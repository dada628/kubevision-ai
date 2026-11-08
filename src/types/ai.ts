/**
 * KubeVision AI - AI copilot type contract.
 *
 * Two distinct surfaces share this module:
 *
 * 1. Generative UI payloads. The Vercel AI SDK streams tool calls from
 *    `/api/copilot`; each tool result must be a fully-typed payload that a
 *    React Server Component can render directly. Names deliberately mirror the
 *    component contract (`*Props`) so a card component can be written as
 *    `function PodMetricsCard(props: PodMetricsCardProps)` and consume the tool
 *    output with zero mapping code.
 *
 * 2. Edge audit payloads. Log classification runs client-side in a Web Worker
 *    via Transformers.js, so these types must stay free of Node-only imports
 *    and must be structured-clonable (plain objects, no classes, no functions).
 */

import type {
  ChaosScenario,
  IncidentSeverity,
  IsoTimestamp,
  Percentage,
  PodEntity,
  PodStatus,
  TelemetrySnapshot,
  UnitInterval,
} from './cluster';
import type { EntityType } from './store';

/* ==========================================================================
   Shared AI primitives
   ========================================================================== */

/** Trend direction shown next to a sparkline or KPI delta. */
export const METRIC_TRENDS = ['rising', 'falling', 'stable'] as const;

export type MetricTrend = (typeof METRIC_TRENDS)[number];

/** Relative importance of a single telemetry row inside a card. */
export const METRIC_TONES = ['neutral', 'healthy', 'elevated', 'critical'] as const;

export type MetricTone = (typeof METRIC_TONES)[number];

/**
 * One labelled scalar shown inside a generative UI card.
 *
 * `unit` is display-only (`'%'`, `'cores'`, `'MiB'`, `'ms'`, `'qps'`).
 * Numeric range is intentionally NOT encoded on `value`: different rows have
 * different domains, and the producing tool is responsible for validating its
 * own range before emitting the payload.
 */
export interface MetricDatum {
  readonly label: string;
  readonly value: number;
  readonly unit: string;
  readonly trend: MetricTrend;
  readonly tone: MetricTone;
}

/* ==========================================================================
   Generative UI card payloads
   ========================================================================== */

/**
 * Payload for the inline pod health card.
 *
 * Every field is derived from `PodEntity` plus the AI's own commentary. The
 * card is rendered inside a `kv-panel`, so it must NOT carry layout classes -
 * styling tokens are chosen by the renderer, not the model.
 */
export interface PodMetricsCardProps {
  /** `PodEntity.id` - used as the React key and the drill-down target. */
  readonly podId: string;
  /** Fully qualified pod name. */
  readonly podName: string;
  readonly namespace: string;
  readonly nodeId: string;
  readonly status: PodStatus;
  /** Utilization in [0, 100]. */
  readonly cpuUsage: Percentage;
  /** Utilization in [0, 100]. */
  readonly memoryUsage: Percentage;
  readonly restarts: number;
  /** Trailing CPU samples, oldest first. Length <= 6. */
  readonly cpuHistory: number[];
  /** Trailing memory samples, oldest first. Length <= 6. */
  readonly memHistory: number[];
  /** One-sentence model-authored summary, plain text, no markdown. */
  readonly narrative: string;
  /** True when the copilot flagged this pod as needing operator attention. */
  readonly atRisk: boolean;
  /**
   * Focus this pod in the 3D viewport. The card title calls it when the
   * operator clicks the pod name. Omitted outside the copilot drawer.
   */
  readonly onFocusPod?: (podId: string) => void;
}

/**
 * One element of the evidence chain that justifies a root cause call.
 *
 * `weight` is the relative contribution of this piece of evidence to the final
 * verdict, in [0, 1]. All weights in one card are expected to sum to ~1; the
 * renderer draws them as a stacked contribution bar.
 */
export interface EvidenceItem {
  /** Short machine label, e.g. `pod.restart_burst`. */
  readonly signal: string;
  /** Human-readable explanation, one sentence. */
  readonly detail: string;
  /** Contribution weight in [0, 1]. */
  readonly weight: UnitInterval;
  /** Where the evidence was observed. */
  readonly source: 'metrics' | 'logs' | 'events' | 'topology';
  /** Point in time the evidence was captured. */
  readonly observedAt: IsoTimestamp;
}

/** A remediation the copilot suggests, optionally executable in one click. */
export const RECOMMENDED_ACTION_KINDS = [
  'restart_pod',
  'scale_deployment',
  'drain_node',
  'inspect_logs',
] as const;

export type RecommendedActionKind =
  (typeof RECOMMENDED_ACTION_KINDS)[number];

export interface RecommendedAction {
  readonly kind: RecommendedActionKind;
  /** Imperative one-liner, e.g. "Restart cart-service-7d9f". */
  readonly label: string;
  /**
   * False for advisory actions (e.g. `inspect_logs`) that need no confirm
   * dialog and no mutation permission.
   */
  readonly requiresConfirmation: boolean;
}

/**
 * Payload for the root-cause alert card.
 *
 * `severity` is the incident grade, not the pod status - a `P0` card can be
 * raised for a node-level network partition just as easily as for an OOM kill.
 */
export interface RootCauseAlertProps {
  /** Stable incident id, also used as the alert-stream correlation key. */
  readonly incidentId: string;
  /** Incident grade: P0 = page now, P1 = act today, P2 = backlog. */
  readonly severity: IncidentSeverity;
  /** Headline, <= 80 chars, plain text. */
  readonly title: string;
  /** Root cause summary, 1-3 sentences, plain text. */
  readonly rootCauseSummary: string;
  /** Ordered supporting evidence, strongest first. Never empty. */
  readonly evidenceChain: EvidenceItem[];
  /** Ordered remediation list, safest first. Never empty. */
  readonly recommendedActions: RecommendedAction[];
  /** Model confidence in the verdict, in [0, 1]. */
  readonly confidence: UnitInterval;
  /** Earliest timestamp at which the anomalous signal was observed. */
  readonly detectedAt: IsoTimestamp;
  /** Affected object ids (`PodEntity.id` / `WorkerNodeEntity.id`). */
  readonly affectedIds: string[];
  /**
   * Focus a pod named in the headline. The title turns matching pod names
   * into buttons when this is set.
   */
  readonly onFocusPod?: (podId: string) => void;
}

/** Mutation kinds the copilot is allowed to request. */
export const CONFIRMABLE_ACTION_TYPES = [
  'restart_pod',
  'scale_deployment',
  'drain_node',
] as const;

export type ConfirmableActionType = (typeof CONFIRMABLE_ACTION_TYPES)[number];

/** Lifecycle of a requested mutation, mirrored from the API route. */
export const ACTION_EXECUTION_STATES = [
  'idle',
  'pending_confirmation',
  'executing',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export type ActionExecutionState = (typeof ACTION_EXECUTION_STATES)[number];

/**
 * Payload for the human-in-the-loop confirmation card.
 *
 * The copilot NEVER mutates the cluster directly: it emits this payload, the
 * operator confirms, and only then does the client call the mutation route with
 * the `requestId` as an idempotency key.
 */
export interface ActionConfirmProps {
  /** Idempotency key; also the correlation id echoed by the mutation route. */
  readonly requestId: string;
  readonly actionType: ConfirmableActionType;
  /**
   * Target object id. Interpretation depends on `actionType`:
   * `restart_pod` -> `PodEntity.id`,
   * `scale_deployment` -> deployment name,
   * `drain_node` -> `WorkerNodeEntity.id`.
   */
  readonly targetId: string;
  /** Human-readable target, e.g. `cart-service-7d9f` or `node-rack-2-03`. */
  readonly targetLabel: string;
  /** Current lifecycle state of the mutation. */
  readonly executionState: ActionExecutionState;
  /** Why the copilot proposes this action, one sentence, plain text. */
  readonly rationale: string;
  /**
   * Desired replica count for `scale_deployment`; ignored for the other action
   * kinds. Undefined rather than 0 so a missing value can never be mistaken for
   * a scale-to-zero request.
   */
  readonly desiredReplicas?: number;
  /** Blast radius warning shown in the confirm dialog, plain text. */
  readonly impactDescription: string;
  /** Populated when `executionState === 'failed'`. Plain text. */
  readonly errorMessage?: string;
  /**
   * Focus the pod this action refers to. Restart targets that pod directly;
   * a scale target resolves to one of its replicas. Drain stays a node.
   */
  readonly onFocusPod?: (podId: string) => void;
}

/**
 * Placeholder shown while a tool call's arguments are still streaming.
 *
 * The model emits the tool name before the argument object is complete. `toolName`
 * may therefore be absent, partial (`"PodMet"`), or already final. The skeleton
 * must render in every one of those states and must not require a parsed payload.
 */
export interface GenUISkeletonProps {
  /**
   * Tool name as far as the stream has produced it. Omit while even the name
   * has not arrived. Never a parsed argument object.
   */
  readonly toolName?: string;
}

/* ==========================================================================
   Edge log audit
   ========================================================================== */

/** Labels produced by the on-device log classifier. */
export const EDGE_AUDIT_LABELS = [
  'CRITICAL_PANIC',
  'RESOURCE_EXHAUSTED',
  'NETWORK_TIMEOUT',
  'NORMAL_INFO',
] as const;

export type EdgeAuditLabel = (typeof EDGE_AUDIT_LABELS)[number];

/** Where a log record was captured. */
export interface LogSource {
  /** `PodEntity.id` that emitted the record. */
  readonly podId: string;
  readonly podName: string;
  readonly namespace: string;
  /** Container inside the pod, when known. */
  readonly container?: string;
}

/**
 * A single log record as it travels the edge-audit pipeline.
 *
 * `rawText` MUST stay in the worker/main-thread boundary only; it is what gets
 * classified. `redactedText` is what is allowed to leave the device or be
 * persisted - secrets, bearer tokens, IPs and emails are masked before the
 * record reaches React state or telemetry export.
 */
export interface LogEntry {
  /** Stable record id, used for dedupe and virtualized list keys. */
  readonly id: string;
  /** Verbatim log line. Never render this directly. */
  readonly rawText: string;
  /** Secret-masked log line. Safe to render and to persist. */
  readonly redactedText: string;
  /** When the container produced the line. */
  readonly timestamp: IsoTimestamp;
  /** Which pod/container produced it. */
  readonly source: LogSource;
  /** Stream the line came from. */
  readonly stream: 'stdout' | 'stderr';
}

/** One (label, confidence) hypothesis from the classifier. */
export interface AuditHypothesis {
  readonly label: EdgeAuditLabel;
  /** Confidence in [0, 1]. */
  readonly confidence: UnitInterval;
}

/**
 * Result of running Transformers.js over one (or one batch of) `LogEntry`.
 *
 * `inferenceMs` measures the main-thread-observed wall time for the worker's
 * classify round trip, so it includes ONNX session overhead and message
 * passing - which is exactly what the latency HUD needs to display.
 */
export interface EdgeAuditResult {
  /** Label with the highest confidence. */
  readonly label: EdgeAuditLabel;
  /** Confidence of `label`, in [0, 1]. */
  readonly confidence: UnitInterval;
  /** Inference wall time in milliseconds, >= 0. */
  readonly inferenceMs: number;
  /** Id of the audited `LogEntry`. */
  readonly logEntryId: string;
  /**
   * Full ranked distribution. Optional because a fast-path classifier may emit
   * only the argmax label; the UI degrades to a single bar in that case.
   */
  readonly hypotheses?: AuditHypothesis[];
  /** True when `confidence` fell below the pipeline's action threshold. */
  readonly belowThreshold: boolean;
}

/* ==========================================================================
   Runtime guards
   ========================================================================== */

export function isMetricTrend(value: unknown): value is MetricTrend {
  return (
    typeof value === 'string' &&
    (METRIC_TRENDS as readonly string[]).includes(value)
  );
}

export function isMetricTone(value: unknown): value is MetricTone {
  return (
    typeof value === 'string' &&
    (METRIC_TONES as readonly string[]).includes(value)
  );
}

export function isConfirmableActionType(
  value: unknown,
): value is ConfirmableActionType {
  return (
    typeof value === 'string' &&
    (CONFIRMABLE_ACTION_TYPES as readonly string[]).includes(value)
  );
}

export function isActionExecutionState(
  value: unknown,
): value is ActionExecutionState {
  return (
    typeof value === 'string' &&
    (ACTION_EXECUTION_STATES as readonly string[]).includes(value)
  );
}

export function isEdgeAuditLabel(value: unknown): value is EdgeAuditLabel {
  return (
    typeof value === 'string' &&
    (EDGE_AUDIT_LABELS as readonly string[]).includes(value)
  );
}

/** True when the action has reached a state where no further transition occurs. */
export function isTerminalActionState(
  state: ActionExecutionState,
): state is 'succeeded' | 'failed' | 'cancelled' {
  return (
    state === 'succeeded' || state === 'failed' || state === 'cancelled'
  );
}

/**
 * Live scene attached to every `POST /api/chat` body.
 *
 * Read once at send time from `useClusterStore` and the telemetry pool. The
 * route treats this as the only source of truth: a missing snapshot must not
 * be replaced by a healthier guess when these fields are present.
 */
export interface ChatClusterContext {
  /** `useClusterStore.selectedEntityId`. Null when the viewport has no selection. */
  readonly selectedEntityId: string | null;
  /** Kind of the selection, so a node id is not searched as a pod. */
  readonly selectedEntityType: EntityType | null;
  /** `useClusterStore.activeChaos` at the moment the message was sent. */
  readonly activeChaos: ChaosScenario;
  /**
   * Pods that are not Running, or whose CPU or memory is above 80%.
   * Detached copies of the live snapshot, not store summaries.
   */
  readonly abnormalPods: readonly PodEntity[];
  /** Full live `TelemetrySnapshot`, including healthy pods, nodes and alerts. */
  readonly snapshot: TelemetrySnapshot;
}
