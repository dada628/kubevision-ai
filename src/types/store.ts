/**
 * KubeVision AI - UI store contract.
 *
 * Every Zustand field, selector return type and action signature lives here so
 * `src/store/*` contains logic only and never re-declares a shape. This module
 * is type/const-only: no React, no runtime side effects, safe to import from a
 * Server Component.
 */

import { POD_STATUSES } from './cluster';
import type {
  ChaosScenario,
  IsoTimestamp,
  MasterNodeEntity,
  Percentage,
  PodEntity,
  PodStatus,
  RackIndex,
  WorkerNodeEntity,
} from './cluster';

/* ==========================================================================
   Connection mode
   ========================================================================== */

/** Data source driving the dashboard. */
export const CONNECTION_MODES = ['demo', 'live'] as const;

export type ConnectionMode = (typeof CONNECTION_MODES)[number];

export function isConnectionMode(value: unknown): value is ConnectionMode {
  return (
    typeof value === 'string' &&
    (CONNECTION_MODES as readonly string[]).includes(value)
  );
}

/* ==========================================================================
   Selection
   ========================================================================== */

/** Which kind of entity the HUD inspector is focused on. */
export const ENTITY_TYPES = ['master', 'node', 'pod'] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export function isEntityType(value: unknown): value is EntityType {
  return (
    typeof value === 'string' &&
    (ENTITY_TYPES as readonly string[]).includes(value)
  );
}

/**
 * A detached copy of the currently selected entity.
 *
 * Deliberately a COPY, not a reference: the authoritative telemetry objects in
 * `telemetryTransientRef` are mutated every tick, and handing React a mutable
 * reference would make the HUD show values that silently changed underneath it
 * without a re-render. The copy is refreshed once per `syncSummary` window
 * (<= 1 Hz) and on every explicit selection.
 */
export type SelectedEntitySnapshot =
  | { readonly type: 'pod'; readonly entity: PodEntity }
  | { readonly type: 'node'; readonly entity: WorkerNodeEntity }
  | { readonly type: 'master'; readonly entity: MasterNodeEntity };

/* ==========================================================================
   Pod status filter
   ========================================================================== */

/** `'ALL'` plus every `PodStatus`, for the topology filter chips. */
export const POD_STATUS_FILTERS = ['ALL', ...POD_STATUSES] as const;

export type PodStatusFilter = (typeof POD_STATUS_FILTERS)[number];

export function isPodStatusFilter(value: unknown): value is PodStatusFilter {
  return (
    typeof value === 'string' &&
    (POD_STATUS_FILTERS as readonly string[]).includes(value)
  );
}

/** Narrow helper: true when a pod passes the active filter. */
export function matchesStatusFilter(
  status: PodStatus,
  filter: PodStatusFilter,
): boolean {
  return filter === 'ALL' || status === filter;
}

/* ==========================================================================
   Self-healing actions
   ========================================================================== */

/**
 * Actions `healEntity` accepts.
 *
 * Kept wider than `ConfirmableActionType` because the demo surface also exposes
 * a one-click "auto heal" that is not a real Kubernetes verb. The store narrows
 * the incoming `string` with `isHealActionType` before touching telemetry, so an
 * untrusted value (URL param, model output) can never mutate the cluster.
 */
export const HEAL_ACTION_TYPES = [
  'restart_pod',
  'scale_deployment',
  'drain_node',
  'auto_heal',
] as const;

export type HealActionType = (typeof HEAL_ACTION_TYPES)[number];

export function isHealActionType(value: unknown): value is HealActionType {
  return (
    typeof value === 'string' &&
    (HEAL_ACTION_TYPES as readonly string[]).includes(value)
  );
}

/* ==========================================================================
   Throttled HUD summary
   ========================================================================== */

/**
 * The ONLY telemetry-derived data that lives in React state.
 *
 * Refreshed at most once per 1000 ms (`syncSummary`) so HUD panels stay live
 * while the R3F render loop keeps reading sub-frame values straight out of
 * `telemetryTransientRef`. Every field here is a primitive or a detached copy -
 * no Float32Array, no live `PodEntity` reference.
 */
export interface ClusterSummary {
  /** Composite health score in [0, 100]. */
  readonly healthScore: Percentage;
  /** Pods whose status is anything other than `Running`. */
  readonly abnormalPodCount: number;
  readonly totalPodCount: number;
  readonly runningPodCount: number;
  /**
   * Per-status tallies for the TopBar filter chips.
   *
   * A `Record<PodStatus, number>` rather than five scalar fields: the chip row
   * iterates a fixed tuple of statuses, so adding a `PodStatus` later only
   * requires updating that tuple, not every call site.
   */
  readonly podStatusCounts: Readonly<Record<PodStatus, number>>;
  /** Unresolved alerts in the latest snapshot. */
  readonly activeAlertCount: number;
  readonly totalQps: number;
  /** Smoothed frames-per-second sampled from the transient ref. */
  readonly fps: number;
  /** Wall-clock instant of the last successful summary commit. */
  readonly lastSyncAt: IsoTimestamp;
  /** Detached copy of the selected entity, or null when nothing is selected. */
  readonly selectedEntity: SelectedEntitySnapshot | null;
}

/* ==========================================================================
   Terminal log channels
   ========================================================================== */

/**
 * Fixed set of log channels so the terminal renderer can colour lines without
 * parsing free-form text.
 *
 * Two families coexist on purpose:
 * - Pipeline channels emitted by the stores (`KUBE-CONTROLLER`, `CHAOS`,
 *   `COPILOT`, `TELEMETRY`, `SYSTEM`).
 * - Legacy / external prefixes that already appear in kubectl-style output and
 *   in worker messages (`WARN`, `ERR`, `AI-COPILOT`, `EDGE-WASM`). Supporting
 *   them means a log line copied out of `kubectl logs` still colourises
 *   correctly instead of falling back to neutral grey.
 */
export const TERMINAL_LOG_CHANNELS = [
  'KUBE-CONTROLLER',
  'CHAOS',
  'CHAOS-MESH',
  'COPILOT',
  'AI-COPILOT',
  'EDGE-WASM',
  'WARN',
  'ERR',
  'TELEMETRY',
  'SYSTEM',
] as const;

export type TerminalLogChannel = (typeof TERMINAL_LOG_CHANNELS)[number];

export type TerminalLogTone =
  | 'healthy'
  | 'elevated'
  | 'critical'
  | 'accent'
  | 'violet'
  | 'neutral';

/** Channel -> HUD colour tone. Controller successes are emerald. */
export const TERMINAL_LOG_CHANNEL_TONE: Record<
  TerminalLogChannel,
  TerminalLogTone
> = {
  'KUBE-CONTROLLER': 'healthy',
  CHAOS: 'critical',
  /* Chaos Mesh broadcasts are the drill-injection channel: rose, so an injected
     fault is distinguishable at a glance from the copilot's cyan narration. */
  'CHAOS-MESH': 'critical',
  COPILOT: 'accent',
  'AI-COPILOT': 'accent',
  'EDGE-WASM': 'violet',
  WARN: 'elevated',
  ERR: 'critical',
  TELEMETRY: 'neutral',
  SYSTEM: 'neutral',
};

/** A terminal line decomposed for rendering. Never stored - derived on read. */
export interface ParsedTerminalLogLine {
  readonly raw: string;
  /** `HH:MM:SS`, or null when the line carries no timestamp. */
  readonly timestamp: string | null;
  readonly channel: TerminalLogChannel | null;
  readonly tone: TerminalLogTone;
  /** Message body with timestamp and channel stripped. */
  readonly message: string;
}

export function isTerminalLogChannel(
  value: unknown,
): value is TerminalLogChannel {
  return (
    typeof value === 'string' &&
    (TERMINAL_LOG_CHANNELS as readonly string[]).includes(value)
  );
}

/* ==========================================================================
   Chaos drill metadata
   ========================================================================== */

/**
 * Which rack each chaos scenario damages, or null when it damages none.
 *
 * THIS IS THE SINGLE SOURCE FOR "WHERE DID WE HIT IT?"
 * Three consumers need the same answer and must never disagree: the drill modal
 * (which rack to highlight on its card), the camera rig (which rack to fly to on
 * injection) and the terminal broadcast (which chassis to name). Deriving it in
 * one place means a scenario that is re-targeted in the engine cannot leave the
 * camera flying to the wrong rack.
 *
 * The values mirror `syntheticEngine.ts`'s `*_RACK` constants, which is the other
 * half of the same contract:
 *   POD_OOM_SWARM   -> rack 1 (worker-beta)   (per the engine header)
 *   NODE_CPU_SPIKE  -> rack 0 (worker-alpha)  (per the engine header)
 *   NET_PACKET_LOSS -> rack 2 (worker-gamma)  (per the engine header)
 *
 * `'NONE'` is null because a recovery has no blast radius: flying the camera to a
 * rack to show it healing would imply that rack was the only one affected.
 */
export const CHAOS_TARGET_RACK: Readonly<Record<ChaosScenario, RackIndex | null>> = {
  NONE: null,
  POD_OOM_SWARM: 1,
  NODE_CPU_SPIKE: 0,
  NET_PACKET_LOSS: 2,
};

/** Human name of each rack's worker node, for terminal broadcasts. */
export const RACK_WORKER_LABEL: Readonly<Record<RackIndex, string>> = {
  0: 'worker-alpha',
  1: 'worker-beta',
  2: 'worker-gamma',
};

/* ==========================================================================
   Chaos presentation metadata
   ========================================================================== */

/** Human label + HUD tone for each chaos scenario. Pure presentation data. */
export interface ChaosScenarioMeta {
  readonly scenario: ChaosScenario;
  readonly label: string;
  readonly description: string;
  readonly tone: 'neutral' | 'healthy' | 'elevated' | 'critical';
}

export const CHAOS_SCENARIO_META: readonly ChaosScenarioMeta[] = [
  {
    scenario: 'NONE',
    label: 'Steady State',
    description: 'No fault injection. All anomalies cleared.',
    tone: 'healthy',
  },
  {
    scenario: 'POD_OOM_SWARM',
    label: 'Pod OOM Swarm',
    description: 'Memory pressure drives the busiest pods into OOMKilled.',
    tone: 'critical',
  },
  {
    scenario: 'NODE_CPU_SPIKE',
    label: 'Node CPU Spike',
    description: 'Sustained CPU saturation pushes a worker into HighLoad.',
    tone: 'elevated',
  },
  {
    scenario: 'NET_PACKET_LOSS',
    label: 'Network Packet Loss',
    description: 'Packet loss partitions a node and strands its pods.',
    tone: 'critical',
  },
];