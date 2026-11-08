'use client';

/**
 * KubeVision AI - responsive UI store (React-visible state only).
 *
 * SPLIT-OF-RESPONSIBILITY with `useTelemetryRef.ts`:
 *
 *   useTelemetryRef   -> mutable singleton, sub-frame values, read inside
 *                        `useFrame`, zero React involvement, never rendered.
 *   useClusterStore   -> discrete operator intent (selection, filters, modals,
 *                        log lines) plus a THROTTLED 1 Hz telemetry summary.
 *
 * The throttle is the core invariant: per-frame telemetry can never reach
 * React state, otherwise the canvas would re-render 60 times per second and the
 * 60 FPS budget in `.cursorrules` would be lost. `syncSummary` is a hard gate
 * that drops every call inside the current window.
 *
 * SSR note: this file is `'use client'`, but the Zustand store is still created
 * with `create()` (no `createStore` factory + provider), so the initial state is
 * deterministic and identical on server and client: it derives from the frozen
 * `INITIAL_CLUSTER_SNAPSHOT` only, never from `Date.now()` or `Math.random()`.
 */

import { create } from 'zustand';
import {
  INITIAL_CLUSTER_SNAPSHOT,
  isChaosScenario,
  isPercentage,
} from '@/types/cluster';
import type { ChaosScenario, PodStatus } from '@/types/cluster';
import {
  isEntityType,
  isHealActionType,
  isPodStatusFilter,
  isTerminalLogChannel,
  CHAOS_SCENARIO_META,
  CHAOS_TARGET_RACK,
  RACK_WORKER_LABEL,
  TERMINAL_LOG_CHANNEL_TONE,
} from '@/types/store';
import type {
  ClusterSummary,
  ConnectionMode,
  EntityType,
  HealActionType,
  ParsedTerminalLogLine,
  PodStatusFilter,
  QuickPromptRequest,
  SelectedEntitySnapshot,
  TerminalLogChannel,
} from '@/types/store';

/**
 * Re-exported so a terminal component needs exactly one import path
 * (`@/store/useClusterStore`) for both the buffer and its rendering metadata.
 */
export { TERMINAL_LOG_CHANNEL_TONE };
export type { ParsedTerminalLogLine, TerminalLogChannel };
export { TERMINAL_LOG_CHANNELS } from '@/types/store';
import {
  applyChaos,
  applyHeal,
  cloneMaster,
  cloneNode,
  clonePod,
  findLiveNode,
  findLivePod,
  flushTargets,
  getSnapshot,
  telemetryTransientRef,
} from './useTelemetryRef';

/* ==========================================================================
   Constants
   ========================================================================== */

/** Minimum interval between two summary commits, in milliseconds. */
export const SUMMARY_SYNC_INTERVAL_MS = 1000;

/** Terminal log retention. Older lines are dropped from the head. */
export const MAX_TERMINAL_LOG_LINES = 200;

/** Timestamp rendered on the very first (SSR) log line. Frozen, not `now()`. */
const BOOT_TIMESTAMP = '15:00:00';

/* ==========================================================================
   Pure helpers
   ========================================================================== */

/**
 * Builds the initial summary from the frozen seed. Pure and clock-free, so the
 * server render and the client hydration agree byte-for-byte.
 */
function buildInitialSummary(): ClusterSummary {
  const seed = INITIAL_CLUSTER_SNAPSHOT;
  const podStatusCounts = countPodStatuses(seed.pods);
  const runningPodCount = podStatusCounts.Running;
  const totalPodCount = seed.pods.length;
  return {
    healthScore: seed.clusterHealthScore,
    abnormalPodCount: totalPodCount - runningPodCount,
    totalPodCount,
    runningPodCount,
    podStatusCounts,
    activeAlertCount: seed.activeAlerts.filter((alert) => !alert.resolved).length,
    totalQps: seed.totalQps,
    fps: 60,
    lastSyncAt: seed.timestamp,
    selectedEntity: null,
  };
}

/**
 * Tallies pods per status.
 *
 * Always returns all five keys (zero-filled) so consumers can index the record
 * without a null check - `noUncheckedIndexedAccess` is on, and a
 * `Record<PodStatus, number>` with guaranteed keys keeps the chip row total-free
 * of `?? 0` noise.
 */
function countPodStatuses(
  pods: readonly { readonly status: PodStatus }[],
): Record<PodStatus, number> {
  const counts: Record<PodStatus, number> = {
    Running: 0,
    Pending: 0,
    CrashLoopBackOff: 0,
    OOMKilled: 0,
    Terminating: 0,
  };
  for (const pod of pods) {
    counts[pod.status] += 1;
  }
  return counts;
}

/**
 * Reads the live pool and produces a React-safe summary.
 *
 * Everything returned is either a primitive or a detached copy, so the HUD can
 * render it without holding a reference into the mutable snapshot.
 */
function readSummary(selectedEntityId: string | null): ClusterSummary {
  const live = getSnapshot();

  const podStatusCounts = countPodStatuses(live.pods);
  const runningPodCount = podStatusCounts.Running;

  let activeAlertCount = 0;
  for (const alert of live.activeAlerts) {
    if (!alert.resolved) {
      activeAlertCount += 1;
    }
  }

  return {
    healthScore: isPercentage(live.clusterHealthScore)
      ? live.clusterHealthScore
      : 0,
    abnormalPodCount: live.pods.length - runningPodCount,
    totalPodCount: live.pods.length,
    runningPodCount,
    podStatusCounts,
    activeAlertCount,
    totalQps: live.totalQps,
    fps: telemetryTransientRef.currentFps,
    lastSyncAt: live.timestamp,
    selectedEntity: resolveSelectedSnapshot(selectedEntityId),
  };
}

/**
 * Resolves the selected entity id into a detached copy.
 *
 * Returns null when nothing is selected OR when the selected entity no longer
 * exists (a recovered pod can be rescheduled away). Silently degrading to null
 * keeps the inspector from rendering a zombie row.
 */
function resolveSelectedSnapshot(
  selectedEntityId: string | null,
): SelectedEntitySnapshot | null {
  if (selectedEntityId === null) {
    return null;
  }
  const live = getSnapshot();
  if (live.master.id === selectedEntityId) {
    return { type: 'master', entity: cloneMaster(live.master) };
  }
  const node = findLiveNode(selectedEntityId);
  if (node !== null) {
    return { type: 'node', entity: cloneNode(node) };
  }
  const pod = findLivePod(selectedEntityId);
  if (pod !== null) {
    return { type: 'pod', entity: clonePod(pod) };
  }
  return null;
}

/**
 * Infers the entity type for an id.
 *
 * The store still accepts an explicit type on `selectEntity` (the canvas knows
 * exactly what was clicked), but `healEntity` and programmatic selection only
 * have an id, so this resolves it against the live snapshot.
 */
function inferEntityType(
  selectedEntityId: string,
): EntityType | null {
  const live = getSnapshot();
  if (live.master.id === selectedEntityId) {
    return 'master';
  }
  if (findLiveNode(selectedEntityId) !== null) {
    return 'node';
  }
  if (findLivePod(selectedEntityId) !== null) {
    return 'pod';
  }
  return null;
}

/**
 * Formats a channel-tagged terminal line.
 *
 * Wire format: `[HH:MM:SS] [CHANNEL] message`
 *
 * The channel tag is embedded in the STRING rather than stored as structured
 * state on purpose: `terminalLogs` stays `string[]` (as required by the store
 * contract) while the renderer can still colour lines via `parseTerminalLogLine`.
 * A `[HH:MM:SS]` prefix alone is already parseable, so no parallel array or
 * object list is needed - which keeps the store shape minimal and cheap to
 * clone.
 */
function formatChannelLogLine(
  channel: TerminalLogChannel,
  message: string,
  timestamp: string,
): string {
  return `[${timestamp}] [${channel}] ${message}`;
}

const LOG_LINE_PATTERN =
  /^\[(\d{2}:\d{2}:\d{2})\](?:\s*\[([A-Z-]+)\])?\s*(.*)$/;

/**
 * Parses a stored terminal line back into render-ready parts.
 *
 * Pure and allocation-cheap; callers should memoize per line in the renderer
 * (lines are immutable strings, so a `Map<string, ParsedTerminalLogLine>` cache
 * stays valid for the lifetime of the buffer).
 */
export function parseTerminalLogLine(
  raw: string,
): ParsedTerminalLogLine {
  const match = LOG_LINE_PATTERN.exec(raw);
  if (match === null) {
    return {
      raw,
      timestamp: null,
      channel: null,
      tone: 'neutral',
      message: raw,
    };
  }
  const timestamp = match[1] ?? null;
  const channelToken = match[2] ?? null;
  const message = match[3] ?? '';
  const channel = isTerminalLogChannel(channelToken) ? channelToken : null;
  return {
    raw,
    timestamp,
    channel,
    tone: channel === null ? 'neutral' : TERMINAL_LOG_CHANNEL_TONE[channel],
    message,
  };
}

/** Clock used ONLY for log prefixes, never for initial state. */
function currentClockLabel(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * The operator-facing `[CHAOS-MESH]` broadcast for one drill injection.
 *
 * Names the victim explicitly. A bare "Fault scenario injected" line is useless in
 * a list of twenty terminal lines: the operator needs to know WHICH chassis is
 * about to start burning, and the terminal is the only place that survives after
 * the modal closes.
 *
 * The reset case is worded as a recovery rather than as an injected experiment,
 * because broadcasting "injected: NONE" would be actively misleading in an audit
 * trail.
 */
function describeChaosBroadcast(scenario: ChaosScenario): string {
  if (scenario === 'NONE') {
    return 'Fault scenario injected: NONE - all experiments recovered, cluster reset to health baseline';
  }

  const rack = CHAOS_TARGET_RACK[scenario];
  const target = rack === null ? 'cluster' : RACK_WORKER_LABEL[rack];
  const meta = CHAOS_SCENARIO_META.find((entry) => entry.scenario === scenario);
  const label = meta === undefined ? scenario : meta.label;

  return `Fault scenario injected: ${scenario} (${label}) -> target ${target}`;
}

/** Appends lines, trimming from the head to respect the retention cap. */
function appendLines(
  existing: readonly string[],
  incoming: readonly string[],
): string[] {
  const next = [...existing, ...incoming];
  if (next.length <= MAX_TERMINAL_LOG_LINES) {
    return next;
  }
  return next.slice(next.length - MAX_TERMINAL_LOG_LINES);
}

/* ==========================================================================
   Store contract
   ========================================================================== */

export interface ClusterStoreState {
  /* ---------------------------- selection ---------------------------- */
  selectedEntityId: string | null;
  selectedEntityType: EntityType | null;
  /** Increments when the copilot asks the camera to fly to the current selection. */
  cameraFocusNonce: number;

  /* ------------------------- connection mode ------------------------- */
  connectionMode: ConnectionMode;

  /* ----------------------------- chaos ------------------------------- */
  activeChaos: ChaosScenario;
  isChaosModalOpen: boolean;

  /* ---------------------------- filters ------------------------------ */
  statusFilter: PodStatusFilter;

  /* ----------------------------- panels ------------------------------ */
  isPerfHudOpen: boolean;
  /** Terminal echo collapsed to an 8px-tall status strip. */
  isTerminalCollapsed: boolean;

  /* -------------------------- terminal log --------------------------- */
  terminalLogs: string[];

  /* --------------------------- AI copilot ---------------------------- */
  quickPromptTrigger: QuickPromptRequest | null;

  /* ----------------------- throttled summary ------------------------- */
  summary: ClusterSummary;

  /** Monotonic ms of the last committed summary; the throttle gate. */
  lastSummarySyncMs: number;

  /* ----------------------------- actions ----------------------------- */

  /** Select an entity. Pass both fields as null to clear the selection. */
  selectEntity: (id: string | null, type: EntityType | null) => void;
  /**
   * Select an entity and arm a camera flight even when that entity is already
   * selected. The canvas watches `cameraFocusNonce`, because a same-id click
   * would otherwise leave the rig where the operator dragged it.
   */
  focusEntity: (id: string, type: EntityType) => void;
  /** Clear the selection. */
  clearSelection: () => void;
  /** Toggle demo/live data source. */
  setConnectionMode: (mode: ConnectionMode) => void;
  /** Flip between demo and live. */
  toggleConnectionMode: () => void;
  /** Fire a chaos scenario against the live pool and reflect it in the HUD. */
  triggerChaos: (scenario: ChaosScenario) => void;
  /** Open/close the chaos control modal. */
  setChaosModalOpen: (open: boolean) => void;
  /** Open/close the performance HUD. */
  setPerfHudOpen: (open: boolean) => void;
  /** Collapse/expand the bottom terminal echo. */
  setTerminalCollapsed: (collapsed: boolean) => void;
  /** Flip the terminal between collapsed and expanded. */
  toggleTerminalCollapsed: () => void;
  /** Set the pod status filter chip. */
  setStatusFilter: (filter: PodStatusFilter) => void;
  /**
   * Self-heal an entity. `actionType` is a bare `string` on purpose: it may
   * arrive from a model tool call. It is narrowed with `isHealActionType`
   * before anything is mutated; unknown actions are rejected, not coerced.
   */
  healEntity: (targetId: string, actionType: string) => void;
  /** Append one line to the bottom terminal. */
  appendTerminalLog: (line: string) => void;
  /** Append several lines at once (batch flush from a stream). */
  appendTerminalLogs: (lines: readonly string[]) => void;
  /** Clear the terminal buffer. */
  clearTerminalLogs: () => void;
  /** Queue a diagnosis. A new id is minted on every call, even when the text repeats. */
  triggerQuickPrompt: (prompt: string) => void;
  /** Consume the queued prompt (called by the copilot once it has dispatched). */
  consumeQuickPrompt: () => void;
  /**
   * Commit a fresh summary to React state.
   *
   * HARD THROTTLE: returns `false` without touching state when called again
   * within `SUMMARY_SYNC_INTERVAL_MS`.
   *
   * @param nowMs - caller clock; pass `performance.now()` or `Date.now()`
   * @param force - bypass the throttle (selection changes, heal results)
   */
  syncSummary: (nowMs: number, force?: boolean) => boolean;
  /** Reset the store to its seed state (hot reload / tests). */
  reset: () => void;
}

/* ==========================================================================
   Store implementation
   ========================================================================== */

/** Survives identical prompt text so the drawer cannot miss a second click. */
let quickPromptSequence = 0;

const initialState = {
  selectedEntityId: null as string | null,
  selectedEntityType: null as EntityType | null,
  cameraFocusNonce: 0,
  connectionMode: 'demo' as ConnectionMode,
  activeChaos: 'NONE' as ChaosScenario,
  isChaosModalOpen: false,
  statusFilter: 'ALL' as PodStatusFilter,
  isPerfHudOpen: false,
  isTerminalCollapsed: false,
  terminalLogs: [
    formatChannelLogLine(
      'SYSTEM',
      'kubevision boot: control plane node-master-01 reachable at https://10.0.3.10:6443',
      BOOT_TIMESTAMP,
    ),
    formatChannelLogLine(
      'TELEMETRY',
      'telemetry pool seeded: 3 worker nodes, 24 pods, 4 active alerts',
      BOOT_TIMESTAMP,
    ),
    formatChannelLogLine(
      'SYSTEM',
      'render budget: 60 FPS target - transient ref channel online, HUD sync @1Hz',
      BOOT_TIMESTAMP,
    ),
  ] as string[],
  quickPromptTrigger: null as QuickPromptRequest | null,
  summary: buildInitialSummary(),
  lastSummarySyncMs: Number.NEGATIVE_INFINITY,
};

export const useClusterStore = create<ClusterStoreState>((set, get) => ({
  ...initialState,

  /* ------------------------------ selection ------------------------------ */

  selectEntity: (id, type) => {
    set({
      selectedEntityId: id,
      selectedEntityType: id === null ? null : type,
    });
    /* Selection is a user-driven event: bypass the throttle so the inspector
       paints immediately instead of up to 1 s late. */
    get().syncSummary(performance.now(), true);
  },

  focusEntity: (id, type) => {
    set((state) => ({
      selectedEntityId: id,
      selectedEntityType: type,
      cameraFocusNonce: state.cameraFocusNonce + 1,
    }));
    get().syncSummary(performance.now(), true);
  },

  clearSelection: () => {
    set({ selectedEntityId: null, selectedEntityType: null });
    get().syncSummary(performance.now(), true);
  },

  /* --------------------------- connection mode --------------------------- */

  setConnectionMode: (mode) => {
    set({ connectionMode: mode });
    get().appendTerminalLog(
      formatChannelLogLine(
        'SYSTEM',
        mode === 'live'
          ? 'data source switched to LIVE stream (demo generator detached)'
          : 'data source switched to DEMO generator (seeded topology)',
        currentClockLabel(),
      ),
    );
  },

  toggleConnectionMode: () => {
    const next: ConnectionMode =
      get().connectionMode === 'demo' ? 'live' : 'demo';
    get().setConnectionMode(next);
  },

  /* -------------------------------- chaos -------------------------------- */

  triggerChaos: (scenario) => {
    if (!isChaosScenario(scenario)) {
      return;
    }
    applyChaos(scenario);
    const wasReset = scenario === 'NONE';
    set({ activeChaos: scenario, isChaosModalOpen: false });

    /* Two lines, on purpose:
       1. the CHAOS channel is the pipeline receipt ("we applied this to the live
          snapshot"), which is what the existing demo surface already emits;
       2. CHAOS-MESH is the OPERATOR-FACING broadcast for the drill control, in the
          exact shape Chaos Mesh itself reports an injected experiment. Keeping
          both means the drill is auditable without losing the machine receipt. */
    get().appendTerminalLog(
      formatChannelLogLine(
        'CHAOS',
        wasReset
          ? 'chaos reset: all injected faults cleared, cluster returning to steady state'
          : `chaos injected: ${scenario} applied to live snapshot`,
        currentClockLabel(),
      ),
    );
    get().appendTerminalLog(
      formatChannelLogLine(
        'CHAOS-MESH',
        describeChaosBroadcast(scenario),
        currentClockLabel(),
      ),
    );
    get().syncSummary(performance.now(), true);
  },

  setChaosModalOpen: (open) => set({ isChaosModalOpen: open }),

  /* ------------------------------- filters ------------------------------- */

  setStatusFilter: (filter) => {
    if (!isPodStatusFilter(filter)) {
      return;
    }
    set({ statusFilter: filter });
  },

  /* -------------------------------- panels ------------------------------- */

  setPerfHudOpen: (open) => set({ isPerfHudOpen: open }),

  setTerminalCollapsed: (collapsed) => set({ isTerminalCollapsed: collapsed }),

  toggleTerminalCollapsed: () =>
    set((state) => ({ isTerminalCollapsed: !state.isTerminalCollapsed })),

  /* ------------------------------- healing ------------------------------- */

  healEntity: (targetId, actionType) => {
    if (!isHealActionType(actionType)) {
      get().appendTerminalLog(
        formatChannelLogLine(
          'KUBE-CONTROLLER',
          `rejected unknown action "${actionType}" for target "${targetId}"`,
          currentClockLabel(),
        ),
      );
      return;
    }

    const healAction: HealActionType = actionType;
    /* Single call into the transient pool: it mutates the live pod/node,
       republishes podCpuFloat32 / podMemFloat32, bumps revision and recomputes
       health+qps in one pass. Nothing here touches React state. */
    const outcome = applyHeal(targetId, healAction);

    /* The controller log line is the operator-facing receipt. Format required
       by the generative UI: a timestamped, green [KUBE-CONTROLLER] line. On
       success it carries the canonical phrase plus the concrete entity and the
       resulting CPU so the terminal is auditable, not decorative. */
    get().appendTerminalLog(
      formatChannelLogLine(
        'KUBE-CONTROLLER',
        outcome.ok
          ? `Successfully executed self-healing action "${healAction}" on ${outcome.targetLabel} (${outcome.targetId}) -> ${outcome.statusAfter ?? 'unchanged'}, cpu ${(outcome.cpuAfter ?? 0).toFixed(1)}%, pods ${outcome.affectedPodCount}`
          : `self-healing action "${healAction}" on "${targetId}" failed: ${outcome.message}`,
        currentClockLabel(),
      ),
    );

    /* The healed entity may be the selected one: refresh the selection type
       and summary together so the inspector reflects the new status.
       `syncSummary(force)` is required here - the 1 Hz throttle would otherwise
       swallow the update and the inspector would show stale numbers for up to a
       second right after the operator clicked "heal". */
    if (get().selectedEntityId === targetId) {
      const inferred = inferEntityType(targetId);
      set({ selectedEntityType: inferred });
    }
    /* A node-wide heal can repair pods other than the selected one, so the
       selection snapshot is refreshed unconditionally. */
    get().syncSummary(performance.now(), true);
  },

  /* ------------------------------ terminal ------------------------------- */

  appendTerminalLog: (line) => {
    if (line.length === 0) {
      return;
    }
    set((state) => ({ terminalLogs: appendLines(state.terminalLogs, [line]) }));
  },

  appendTerminalLogs: (lines) => {
    if (lines.length === 0) {
      return;
    }
    set((state) => ({ terminalLogs: appendLines(state.terminalLogs, lines) }));
  },

  clearTerminalLogs: () => set({ terminalLogs: [] }),

  /* ------------------------------ AI copilot ----------------------------- */

  triggerQuickPrompt: (prompt) => {
    const trimmed = prompt.trim();
    if (trimmed.length === 0) {
      return;
    }
    quickPromptSequence += 1;
    set({ quickPromptTrigger: { id: quickPromptSequence, prompt: trimmed } });
    get().appendTerminalLog(
      formatChannelLogLine(
        'COPILOT',
        `dispatch: "${trimmed}"`,
        currentClockLabel(),
      ),
    );
  },

  consumeQuickPrompt: () => set({ quickPromptTrigger: null }),

  /* ---------------------------- throttled sync --------------------------- */

  syncSummary: (nowMs, force = false) => {
    const { lastSummarySyncMs, selectedEntityId } = get();
    if (!force && nowMs - lastSummarySyncMs < SUMMARY_SYNC_INTERVAL_MS) {
      return false;
    }
    set({
      summary: readSummary(selectedEntityId),
      lastSummarySyncMs: nowMs,
    });
    return true;
  },

  /* -------------------------------- reset -------------------------------- */

  reset: () => {
    set({
      ...initialState,
      summary: buildInitialSummary(),
      lastSummarySyncMs: Number.NEGATIVE_INFINITY,
    });
    flushTargets();
  },
}));

/* ==========================================================================
   Selector hooks - narrow subscriptions, no object re-creation per render
   ========================================================================== */

/** Current selection id, or null. */
export function useSelectedEntityId(): string | null {
  return useClusterStore((state) => state.selectedEntityId);
}

/** Current selection kind, or null. */
export function useSelectedEntityType(): EntityType | null {
  return useClusterStore((state) => state.selectedEntityType);
}

/** Demo/live data source. */
export function useConnectionMode(): ConnectionMode {
  return useClusterStore((state) => state.connectionMode);
}

/** Active chaos scenario. */
export function useActiveChaos(): ChaosScenario {
  return useClusterStore((state) => state.activeChaos);
}

/** Active status filter chip. */
export function useStatusFilter(): PodStatusFilter {
  return useClusterStore((state) => state.statusFilter);
}

/** Performance HUD visibility. */
export function usePerfHudOpen(): boolean {
  return useClusterStore((state) => state.isPerfHudOpen);
}

/** Terminal echo collapsed state. */
export function useTerminalCollapsed(): boolean {
  return useClusterStore((state) => state.isTerminalCollapsed);
}

/** Throttled telemetry summary (1 Hz). */
export function useClusterSummary(): ClusterSummary {
  return useClusterStore((state) => state.summary);
}

/** Chaos modal visibility. */
export function useChaosModalOpen(): boolean {
  return useClusterStore((state) => state.isChaosModalOpen);
}

/** Queued AI prompt, or null once the drawer has taken it. */
export function useQuickPromptTrigger(): QuickPromptRequest | null {
  return useClusterStore((state) => state.quickPromptTrigger);
}

/** Inlined pod count for the filter chips: `ALL` wins over specific statuses. */
export function selectVisiblePodCount(
  pods: readonly { readonly status: PodStatus }[],
  filter: PodStatusFilter,
): number {
  if (filter === 'ALL') {
    return pods.length;
  }
  let count = 0;
  for (const pod of pods) {
    if (pod.status === filter) {
      count += 1;
    }
  }
  return count;
}