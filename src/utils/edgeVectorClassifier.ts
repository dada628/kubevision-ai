/**
 * KubeVision AI - on-device log vector classifier.
 *
 * A fixed linear model over two concatenated features:
 *
 * 1. Cloud-native priors. Phrase rules for panic, OOM / eviction, and
 *    dial-timeout language. These are the semantic half of the decision.
 * 2. A hashed token bag (32 dims, L2-normalised) with a frozen random
 *    projection. It is the "vector" half: deterministic, allocation-light,
 *    and able to nudge lines the phrase list only partly covers.
 *
 * The four prior channels sit on an identity block of the weight matrix, so a
 * strong phrase always outvotes the hash. A benign bias on `NORMAL_INFO`
 * keeps a line with no fault language from being called a panic.
 *
 * Sentiment from DistilBERT is fused in `fuseVectorAndSentiment`. Negative
 * mass is spread only across fault labels that already have prior weight, so
 * a gloomy-but-healthy info line cannot be promoted to `CRITICAL_PANIC`.
 * When the mirror is offline the polarity argument is null and this module
 * is the whole classifier.
 */

import { clampUnitInterval } from '@/types/cluster';
import { EDGE_AUDIT_LABELS } from '@/types/ai';
import type { AuditHypothesis, EdgeAuditLabel } from '@/types/ai';

const HASH_DIM = 32;
const BENIGN_BIAS = 0.45;
const SENTIMENT_GAIN = 0.9;
const MAX_TOKENS = 64;

const FAULT_LABELS = [
  'CRITICAL_PANIC',
  'RESOURCE_EXHAUSTED',
  'NETWORK_TIMEOUT',
] as const satisfies readonly EdgeAuditLabel[];

interface PriorRule {
  readonly pattern: RegExp;
  readonly label: EdgeAuditLabel;
  readonly weight: number;
}

const PRIOR_RULES: readonly PriorRule[] = [
  { pattern: /(?<![a-z])panic(?![a-z])/i, label: 'CRITICAL_PANIC', weight: 3.6 },
  { pattern: /(?<![a-z])fatal(?![a-z])/i, label: 'CRITICAL_PANIC', weight: 2.4 },
  { pattern: /segmentation fault|segfault/i, label: 'CRITICAL_PANIC', weight: 4 },
  { pattern: /nil pointer/i, label: 'CRITICAL_PANIC', weight: 3.8 },
  { pattern: /stack ?trace/i, label: 'CRITICAL_PANIC', weight: 3.2 },
  { pattern: /uncaught/i, label: 'CRITICAL_PANIC', weight: 3 },
  { pattern: /core dumped/i, label: 'CRITICAL_PANIC', weight: 4 },
  { pattern: /crash ?loop/i, label: 'CRITICAL_PANIC', weight: 3.4 },

  { pattern: /out ?of ?memory|outofmemory/i, label: 'RESOURCE_EXHAUSTED', weight: 4.2 },
  { pattern: /oom-?kill|oomkilled/i, label: 'RESOURCE_EXHAUSTED', weight: 4.4 },
  { pattern: /(?<![a-z])oom(?![a-z])/i, label: 'RESOURCE_EXHAUSTED', weight: 3.6 },
  { pattern: /heap space|heap pressure/i, label: 'RESOURCE_EXHAUSTED', weight: 3.4 },
  { pattern: /cannot allocate/i, label: 'RESOURCE_EXHAUSTED', weight: 3.4 },
  { pattern: /memory limit/i, label: 'RESOURCE_EXHAUSTED', weight: 3.2 },
  { pattern: /no space left/i, label: 'RESOURCE_EXHAUSTED', weight: 3.6 },
  { pattern: /disk pressure/i, label: 'RESOURCE_EXHAUSTED', weight: 3.2 },
  { pattern: /cpu throttl/i, label: 'RESOURCE_EXHAUSTED', weight: 3 },
  { pattern: /scheduler lag|threads saturated|\brunq=/i, label: 'RESOURCE_EXHAUSTED', weight: 2.8 },
  { pattern: /(?<![a-z])evict(?:ed|ion)?(?![a-z])/i, label: 'RESOURCE_EXHAUSTED', weight: 2.6 },

  { pattern: /i\/o timeout|io timeout/i, label: 'NETWORK_TIMEOUT', weight: 4.2 },
  { pattern: /deadline exceeded|context deadline/i, label: 'NETWORK_TIMEOUT', weight: 4 },
  { pattern: /connection refused/i, label: 'NETWORK_TIMEOUT', weight: 3.8 },
  { pattern: /no route to host/i, label: 'NETWORK_TIMEOUT', weight: 4 },
  { pattern: /dial tcp/i, label: 'NETWORK_TIMEOUT', weight: 3.6 },
  { pattern: /connection reset/i, label: 'NETWORK_TIMEOUT', weight: 3.6 },
  { pattern: /network is unreachable|packet loss/i, label: 'NETWORK_TIMEOUT', weight: 3.8 },
  { pattern: /upstream degraded/i, label: 'NETWORK_TIMEOUT', weight: 3.2 },
  { pattern: /status=504|(?<![0-9])504(?![0-9])/i, label: 'NETWORK_TIMEOUT', weight: 2.6 },
  { pattern: /(?<![a-z])timeout(?![a-z])/i, label: 'NETWORK_TIMEOUT', weight: 2.2 },

  { pattern: /status=200/i, label: 'NORMAL_INFO', weight: 2.2 },
  { pattern: /request completed/i, label: 'NORMAL_INFO', weight: 1.6 },
  { pattern: /cache hit/i, label: 'NORMAL_INFO', weight: 1.6 },
  { pattern: /heartbeat/i, label: 'NORMAL_INFO', weight: 1.4 },
  { pattern: /scrape served|pool stats|gc pause/i, label: 'NORMAL_INFO', weight: 1.4 },
  { pattern: /(?<![a-z])health(?![a-z])/i, label: 'NORMAL_INFO', weight: 0.8 },
];

export interface PolarityScores {
  readonly positive: number;
  readonly negative: number;
}

export interface VectorInference {
  readonly logits: Readonly<Record<EdgeAuditLabel, number>>;
  readonly priors: Readonly<Record<EdgeAuditLabel, number>>;
}

function emptyScores(): Record<EdgeAuditLabel, number> {
  return {
    CRITICAL_PANIC: 0,
    RESOURCE_EXHAUSTED: 0,
    NETWORK_TIMEOUT: 0,
    NORMAL_INFO: 0,
  };
}

function labelIndex(label: EdgeAuditLabel): number {
  const index = EDGE_AUDIT_LABELS.indexOf(label);
  return index < 0 ? 0 : index;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const FEATURE_DIM = HASH_DIM + EDGE_AUDIT_LABELS.length;

function buildWeightRows(): readonly Float64Array[] {
  const random = mulberry32(0x6b766973);
  return EDGE_AUDIT_LABELS.map((_label, rowIndex) => {
    const row = new Float64Array(FEATURE_DIM);
    for (let column = 0; column < HASH_DIM; column += 1) {
      row[column] = (random() * 2 - 1) * 0.08;
    }
    row[HASH_DIM + rowIndex] = 1;
    return row;
  });
}

const WEIGHT_ROWS: readonly Float64Array[] = buildWeightRows();

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % HASH_DIM;
}

function scorePriors(text: string): Record<EdgeAuditLabel, number> {
  const scores = emptyScores();
  for (const rule of PRIOR_RULES) {
    if (rule.pattern.test(text)) {
      scores[rule.label] += rule.weight;
    }
  }
  return scores;
}

function accumulateHash(features: Float64Array, text: string): void {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/);
  let used = 0;
  for (const token of tokens) {
    if (token.length < 2 || used >= MAX_TOKENS) {
      continue;
    }
    used += 1;
    const bucket = hashToken(token);
    features[bucket] = (features[bucket] ?? 0) + 1;
  }
  let norm = 0;
  for (let i = 0; i < HASH_DIM; i += 1) {
    const value = features[i] ?? 0;
    norm += value * value;
  }
  const magnitude = Math.sqrt(norm);
  if (magnitude <= 0) {
    return;
  }
  for (let i = 0; i < HASH_DIM; i += 1) {
    features[i] = (features[i] ?? 0) / magnitude;
  }
}

function dot(row: Float64Array, features: Float64Array): number {
  let sum = 0;
  const width = Math.min(row.length, features.length);
  for (let i = 0; i < width; i += 1) {
    sum += (row[i] ?? 0) * (features[i] ?? 0);
  }
  return sum;
}

/** Priors plus the hashed bag, projected onto the four audit labels. */
export function inferLogVector(text: string): VectorInference {
  const priors = scorePriors(text);
  const features = new Float64Array(FEATURE_DIM);
  accumulateHash(features, text);
  for (const label of EDGE_AUDIT_LABELS) {
    features[HASH_DIM + labelIndex(label)] = priors[label];
  }
  const normalSlot = HASH_DIM + labelIndex('NORMAL_INFO');
  features[normalSlot] = (features[normalSlot] ?? 0) + BENIGN_BIAS;

  const logits = emptyScores();
  for (const label of EDGE_AUDIT_LABELS) {
    const row = WEIGHT_ROWS[labelIndex(label)];
    logits[label] = row === undefined ? 0 : dot(row, features);
  }
  return { logits, priors };
}

/**
 * Add DistilBERT polarity onto the vector logits.
 *
 * `polarity === null` returns a copy of `logits` unchanged (offline path).
 * Negative probability is shared in proportion to fault priors, and only
 * among labels whose prior is already non-zero. Positive probability lifts
 * `NORMAL_INFO`.
 */
export function fuseVectorAndSentiment(
  logits: Readonly<Record<EdgeAuditLabel, number>>,
  priors: Readonly<Record<EdgeAuditLabel, number>>,
  polarity: PolarityScores | null,
): Record<EdgeAuditLabel, number> {
  const fused = emptyScores();
  for (const label of EDGE_AUDIT_LABELS) {
    fused[label] = logits[label];
  }
  if (polarity === null) {
    return fused;
  }

  let faultMass = 0;
  for (const label of FAULT_LABELS) {
    faultMass += priors[label];
  }
  if (faultMass <= 0) {
    fused.NORMAL_INFO += SENTIMENT_GAIN * Math.max(polarity.positive, 0.2 * polarity.negative);
    return fused;
  }
  for (const label of FAULT_LABELS) {
    fused[label] += SENTIMENT_GAIN * polarity.negative * (priors[label] / faultMass);
  }
  const normalPrior = priors.NORMAL_INFO;
  const normalShare = normalPrior > 0 ? normalPrior / (normalPrior + faultMass) : 0.15;
  fused.NORMAL_INFO += SENTIMENT_GAIN * polarity.positive * Math.max(normalShare, 0.15);
  return fused;
}

/** Softmax over the four labels, strongest hypothesis first. */
export function rankFusedLogits(
  logits: Readonly<Record<EdgeAuditLabel, number>>,
): AuditHypothesis[] {
  let maxLogit = Number.NEGATIVE_INFINITY;
  for (const label of EDGE_AUDIT_LABELS) {
    const value = logits[label];
    if (value > maxLogit) {
      maxLogit = value;
    }
  }

  const exponent = emptyScores();
  let sum = 0;
  for (const label of EDGE_AUDIT_LABELS) {
    const value = Math.exp(logits[label] - maxLogit);
    exponent[label] = value;
    sum += value;
  }

  const ranked: AuditHypothesis[] = EDGE_AUDIT_LABELS.map((label) => ({
    label,
    confidence: sum > 0 ? clampUnitInterval(exponent[label] / sum) : 0,
  }));
  ranked.sort((left, right) => {
    const delta = right.confidence - left.confidence;
    if (delta !== 0) {
      return delta;
    }
    return labelIndex(left.label) - labelIndex(right.label);
  });
  return ranked;
}
