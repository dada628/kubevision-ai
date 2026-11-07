'use client';

/**
 * KubeVision AI - zero-rerender telemetry transient pool.
 *
 * The whole point of this module: the R3F render loop needs per-pod, per-frame
 * numbers, but React state updates at that frequency would collapse the frame
 * budget. `.cursorrules` forbids calling `useState` inside `useFrame`, so the
 * live numbers live HERE - in a module-level mutable singleton that React never
 * observes.
 *
 * Data flow:
 *
 *   mock / websocket tick
 *        |  writeSnapshot()
 *        v
 *   telemetryTransientRef   <---- mutated in place, zero allocation per tick
 *        |            |
 *   useFrame reads    |    useClusterStore.syncSummary() reads a summary
 *   Float32Arrays     |    once per second and commits primitives to React
 *        v            v
 *   60 FPS canvas   HUD panels (1 Hz)
 *
 * Allocation discipline:
 * - `Float32Array`s are allocated once and only reallocated when the pod/node
 *   count GROWS past capacity (never on a normal tick).
 * - Target arrays are the interpolation GOALS, not the rendered values. The
 *   renderer eases its own instance state toward them with `damp()`, so no
 *   intermediate buffer is needed here.
 * - No `Date.now()`, no `performance.now()` inside this module: callers pass the
 *   clock so the module stays deterministic and testable.
 */

import {
  INITIAL_CLUSTER_SNAPSHOT,
  clampPercentage,
} from '@/types/cluster';
import type {
  AlertEvent,
  ChaosScenario,
  MasterNodeEntity,
  PodEntity,
  PodStatus,
  TelemetrySnapshot,
  WorkerNodeEntity,
} from '@/types/cluster';
import type { HealActionType } from '@/types/store';
import {
  computeHealthScore,
  computeTotalQps,
  pushSample,
} from '@/utils/clusterHealth';

/** Mutable alert mirror, used only inside this module. */
type MutableAlertEvent = Mutable<AlertEvent>;

/* ==========================================================================
   Mutable mirrors of the readonly contracts
   ========================================================================== */

/**
 * Strips `readonly` recursively for the fields we own. The public API always
 * hands out `TelemetrySnapshot` (readonly); only this module may mutate.
 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export type MutablePod = Mutable<PodEntity>;
export type MutableNode = Mutable<WorkerNodeEntity>;
export type MutableMaster = Mutable<MasterNodeEntity>;

export interface MutableSnapshot
  extends Mutable<Omit<TelemetrySnapshot, 'master' | 'nodes' | 'pods' | 'activeAlerts'>> {
  master: MutableMaster;
  nodes: MutableNode[];
  pods: MutablePod[];
  activeAlerts: Mutable<AlertEvent>[];
}

/* ==========================================================================
   Singleton shape
   ========================================================================== */

export interface TelemetryTransientRef {
  /** The authoritative live snapshot. Mutated in place; never given to React. */
  snapshot: MutableSnapshot;
  /** Pod CPU utilization targets in [0, 100], indexed by `podIndex`. */
  podCpuFloat32: Float32Array;
  /** Pod memory utilization targets in [0, 100], indexed by `podIndex`. */
  podMemFloat32: Float32Array;
  /** Node throughput rate in Mbps, indexed by `nodeIndex`. */
  nodeNetFloat32: Float32Array;
  /** Exponentially smoothed instantaneous FPS. Written by `noteFrame`. */
  currentFps: number;
  /** Exponentially smoothed frame duration in milliseconds. */
  smoothedFrameMs: number;
  /** Monotonic snapshot counter; lets the canvas detect a fresh write cheaply. */
  revision: number;
  /** `podId -> index into podCpuFloat32 / podMemFloat32`. */
  readonly podIndex: Map<string, number>;
  /** `nodeId -> index into nodeNetFloat32`. */
  readonly nodeIndex: Map<string, number>;
}

/* ==========================================================================
   Pure helpers
   ========================================================================== */

/**
 * Frame-rate independent exponential smoothing (a.k.a. exponential decay
 * toward a target). Allocation-free, safe to call inside `useFrame`.
 *
 * @param current - current eased value
 * @param target  - destination value
 * @param lambda  - convergence rate; higher is snappier (e.g. 6..14)
 * @param dt      - frame delta in seconds
 */
export function damp(
  current: number,
  target: number,
  lambda: number,
  dt: number,
): number {
  if (!Number.isFinite(dt) || dt <= 0) {
    return current;
  }
  const t = 1 - Math.exp(-lambda * dt);
  return current + (target - current) * t;
}

/** Default easing rate for pod/node visual interpolation. */
export const DEFAULT_DAMP_LAMBDA = 8;

/**
 * Health / throughput / ring-buffer maths live in `@/utils/clusterHealth`.
 *
 * They are re-exported here (not re-implemented) so every existing importer of
 * `@/store/useTelemetryRef` keeps working, while the SERVER-side synthetic
 * engine can call the very same functions without pulling this `'use client'`
 * module - and its mutable browser singleton - into the RSC graph.
 */
export {
  computeHealthScore,
  computeTotalQps,
  pushSample,
} from '@/utils/clusterHealth';

/** Detached pod copy. Used for React-visible selection snapshots. */
export function clonePod(pod: PodEntity): PodEntity {
  return {
    id: pod.id,
    name: pod.name,
    namespace: pod.namespace,
    nodeId: pod.nodeId,
    status: pod.status,
    cpuUsage: pod.cpuUsage,
    memoryUsage: pod.memoryUsage,
    restarts: pod.restarts,
    ip: pod.ip,
    createdAt: pod.createdAt,
    cpuHistory: [...pod.cpuHistory],
    memHistory: [...pod.memHistory],
  };
}

/** Detached node copy. */
export function cloneNode(node: WorkerNodeEntity): WorkerNodeEntity {
  return {
    id: node.id,
    name: node.name,
    ip: node.ip,
    status: node.status,
    cpuCapacity: node.cpuCapacity,
    memCapacity: node.memCapacity,
    networkMbps: node.networkMbps,
    rackIndex: node.rackIndex,
    podIds: [...node.podIds],
  };
}

/** Detached master copy. */
export function cloneMaster(master: MasterNodeEntity): MasterNodeEntity {
  return {
    id: master.id,
    name: master.name,
    ip: master.ip,
    role: master.role,
    status: master.status,
    kubernetesVersion: master.kubernetesVersion,
    region: master.region,
    zone: master.zone,
    apiServerEndpoint: master.apiServerEndpoint,
    etcdClusterSize: master.etcdClusterSize,
    cpuCapacity: master.cpuCapacity,
    memCapacity: master.memCapacity,
    notes: master.notes,
  };
}

/* ==========================================================================
   Seed -> mutable live snapshot
   ========================================================================== */

/**
 * `INITIAL_CLUSTER_SNAPSHOT` is `Object.freeze`d, so writing to it would throw
 * in strict mode (every ES module is strict). We deep-copy it ONCE at module
 * load into an unfrozen working set; from then on mutation is legal and local.
 */
function createLiveSnapshot(): MutableSnapshot {
  const seed = INITIAL_CLUSTER_SNAPSHOT;
  const pods: MutablePod[] = seed.pods.map((pod) => ({
    id: pod.id,
    name: pod.name,
    namespace: pod.namespace,
    nodeId: pod.nodeId,
    status: pod.status,
    cpuUsage: pod.cpuUsage,
    memoryUsage: pod.memoryUsage,
    restarts: pod.restarts,
    ip: pod.ip,
    createdAt: pod.createdAt,
    cpuHistory: [...pod.cpuHistory],
    memHistory: [...pod.memHistory],
  }));
  const nodes: MutableNode[] = seed.nodes.map((node) => ({
    id: node.id,
    name: node.name,
    ip: node.ip,
    status: node.status,
    cpuCapacity: node.cpuCapacity,
    memCapacity: node.memCapacity,
    networkMbps: node.networkMbps,
    rackIndex: node.rackIndex,
    podIds: [...node.podIds],
  }));
  return {
    timestamp: seed.timestamp,
    clusterHealthScore: seed.clusterHealthScore,
    totalQps: seed.totalQps,
    master: { ...seed.master },
    nodes,
    pods,
    activeAlerts: seed.activeAlerts.map((alert) => ({ ...alert })),
  };
}

/* ==========================================================================
   Float32 pool sizing
   ========================================================================== */

/** Grows capacity by doubling so a resize is amortised O(1). */
function growCapacity(current: number, required: number): number {
  let capacity = Math.max(current, 8);
  while (capacity < required) {
    capacity *= 2;
  }
  return capacity;
}

function allocateTargets(podCapacity: number, nodeCapacity: number): {
  podCpuFloat32: Float32Array;
  podMemFloat32: Float32Array;
  nodeNetFloat32: Float32Array;
} {
  return {
    podCpuFloat32: new Float32Array(podCapacity),
    podMemFloat32: new Float32Array(podCapacity),
    nodeNetFloat32: new Float32Array(nodeCapacity),
  };
}

/* ==========================================================================
   The singleton
   ========================================================================== */

const liveSnapshot = createLiveSnapshot();

const initialPodCapacity = Math.max(1, liveSnapshot.pods.length);
const initialNodeCapacity = Math.max(1, liveSnapshot.nodes.length);
const initialTargets = allocateTargets(initialPodCapacity, initialNodeCapacity);

/**
 * The one and only mutable telemetry pool.
 *
 * Read it from `useFrame`, from pointer handlers, from the log pipeline - but
 * NEVER render it directly. Anything that must appear in JSX goes through
 * `useClusterStore.syncSummary()`.
 */
export const telemetryTransientRef: TelemetryTransientRef = {
  snapshot: liveSnapshot,
  podCpuFloat32: initialTargets.podCpuFloat32,
  podMemFloat32: initialTargets.podMemFloat32,
  nodeNetFloat32: initialTargets.nodeNetFloat32,
  currentFps: 60,
  smoothedFrameMs: 1000 / 60,
  revision: 0,
  podIndex: new Map<string, number>(),
  nodeIndex: new Map<string, number>(),
};

/**
 * Fills the id->index maps and the Float32 targets from the seed snapshot.
 *
 * WHY THIS RUNS AT MODULE LOAD
 * `refreshTargets()` only executes after a `writeSnapshot` / `applyChaos` tick.
 * Before the first tick the index maps are empty, so every `getNodeFloatIndex` /
 * `getPodFloatIndex` returns -1 and every consumer falls back to zero - the network
 * streams then crawl at their idle floor and the pod cells report 0% CPU until the
 * first telemetry tick lands. Seeding here makes the very first painted frame as
 * truthful as the tenth.
 */
refreshTargets();

/* ==========================================================================
   Read accessors (allocation-free)
   ========================================================================== */

/** The live snapshot, typed as the readonly public contract. */
export function getSnapshot(): TelemetrySnapshot {
  return telemetryTransientRef.snapshot;
}

/** Index of `podId` inside the Float32 pools, or -1 when unknown. */
export function getPodFloatIndex(podId: string): number {
  return telemetryTransientRef.podIndex.get(podId) ?? -1;
}

/** Index of `nodeId` inside the Float32 pool, or -1 when unknown. */
export function getNodeFloatIndex(nodeId: string): number {
  return telemetryTransientRef.nodeIndex.get(nodeId) ?? -1;
}

/** CPU target for a pod index, or 0 when the index is out of range. */
export function readPodCpuTarget(index: number): number {
  return telemetryTransientRef.podCpuFloat32[index] ?? 0;
}

/** Memory target for a pod index, or 0 when the index is out of range. */
export function readPodMemTarget(index: number): number {
  return telemetryTransientRef.podMemFloat32[index] ?? 0;
}

/** Network rate target for a node index, or 0 when the index is out of range. */
export function readNodeNetTarget(index: number): number {
  return telemetryTransientRef.nodeNetFloat32[index] ?? 0;
}

/** Find a live pod by id. Returns the mutable object; do not hand it to React. */
export function findLivePod(podId: string): MutablePod | null {
  return telemetryTransientRef.snapshot.pods.find((pod) => pod.id === podId) ?? null;
}

/** Find a live worker node by id. */
export function findLiveNode(nodeId: string): MutableNode | null {
  return telemetryTransientRef.snapshot.nodes.find((node) => node.id === nodeId) ?? null;
}

/* ==========================================================================
   Index maps + target array refresh
   ========================================================================== */

/**
 * Rebuilds the id->index maps and writes the Float32 targets.
 *
 * Called from `writeSnapshot` after a tick mutates the live snapshot. Cost is
 * O(pods + nodes) per tick with zero allocation, which is negligible next to a
 * 24-pod topology and stays off the frame path entirely.
 */
function refreshTargets(): void {
  const { snapshot } = telemetryTransientRef;

  const podCount = snapshot.pods.length;
  const nodeCount = snapshot.nodes.length;

  const podCapacity = telemetryTransientRef.podCpuFloat32.length;
  const nodeCapacity = telemetryTransientRef.nodeNetFloat32.length;

  if (podCount > podCapacity || nodeCount > nodeCapacity) {
    const next = allocateTargets(
      growCapacity(podCapacity, podCount),
      growCapacity(nodeCapacity, nodeCount),
    );
    telemetryTransientRef.podCpuFloat32 = next.podCpuFloat32;
    telemetryTransientRef.podMemFloat32 = next.podMemFloat32;
    telemetryTransientRef.nodeNetFloat32 = next.nodeNetFloat32;
  }

  const { podIndex, nodeIndex, podCpuFloat32, podMemFloat32, nodeNetFloat32 } =
    telemetryTransientRef;

  podIndex.clear();
  nodeIndex.clear();

  snapshot.pods.forEach((pod, index) => {
    podIndex.set(pod.id, index);
    podCpuFloat32[index] = pod.cpuUsage;
    podMemFloat32[index] = pod.memoryUsage;
  });

  snapshot.nodes.forEach((node, index) => {
    nodeIndex.set(node.id, index);
    nodeNetFloat32[index] = deriveNodeNetRate(snapshot, node);
  });
}

/**
 * Derives a node's current throughput from the utilization of the pods it
 * hosts. Demo-friendly and deterministic: an idle node reports ~0 Mbps, a
 * saturated node approaches its provisioned NIC speed.
 */
function deriveNodeNetRate(
  snapshot: MutableSnapshot,
  node: WorkerNodeEntity,
): number {
  if (node.status === 'NetworkPartition') {
    return 0;
  }
  let load = 0;
  let hosted = 0;
  for (const pod of snapshot.pods) {
    if (pod.nodeId !== node.id) {
      continue;
    }
    hosted += 1;
    if (pod.status === 'Running') {
      load += (pod.cpuUsage + pod.memoryUsage) / 2;
    }
  }
  if (hosted === 0) {
    return 0;
  }
  const utilization = clampPercentage(load / hosted) / 100;
  return node.networkMbps * utilization;
}

/* ==========================================================================
   Write API
   ========================================================================== */

/**
 * Commits a freshly produced snapshot into the live pool.
 *
 * The snapshot is COPIED into the existing mutable objects rather than adopted
 * by reference, so `INITIAL_CLUSTER_SNAPSHOT` (frozen) can be passed in safely
 * and so entity object identity stays stable for `Map`-based lookups.
 *
 * @param next - snapshot produced by the telemetry driver
 * @param nowMs - optional caller clock, used only for the timestamp fallback
 */
export function writeSnapshot(next: TelemetrySnapshot, nowMs?: number): void {
  const live = telemetryTransientRef.snapshot;

  live.timestamp =
    next.timestamp || (typeof nowMs === 'number' ? new Date(nowMs).toISOString() : live.timestamp);
  live.clusterHealthScore = clampPercentage(next.clusterHealthScore);
  live.totalQps = next.totalQps;
  live.master = { ...next.master };

  replacePods(next.pods);
  replaceNodes(next.nodes);

  live.activeAlerts = next.activeAlerts.map((alert) => ({ ...alert }));

  telemetryTransientRef.revision += 1;
  refreshTargets();
}

function replacePods(next: readonly PodEntity[]): void {
  const live = telemetryTransientRef.snapshot;
  const byId = new Map<string, MutablePod>();
  for (const pod of live.pods) {
    byId.set(pod.id, pod);
  }

  const merged: MutablePod[] = next.map((incoming) => {
    const existing = byId.get(incoming.id);
    const target: MutablePod = existing ?? {
      id: incoming.id,
      name: incoming.name,
      namespace: incoming.namespace,
      nodeId: incoming.nodeId,
      status: incoming.status,
      cpuUsage: incoming.cpuUsage,
      memoryUsage: incoming.memoryUsage,
      restarts: incoming.restarts,
      ip: incoming.ip,
      createdAt: incoming.createdAt,
      cpuHistory: [],
      memHistory: [],
    };
    target.name = incoming.name;
    target.namespace = incoming.namespace;
    target.nodeId = incoming.nodeId;
    target.status = incoming.status;
    target.cpuUsage = clampPercentage(incoming.cpuUsage);
    target.memoryUsage = clampPercentage(incoming.memoryUsage);
    target.restarts = incoming.restarts;
    target.ip = incoming.ip;
    target.createdAt = incoming.createdAt;
    target.cpuHistory = [...incoming.cpuHistory];
    target.memHistory = [...incoming.memHistory];
    return target;
  });

  live.pods = merged;
}

function replaceNodes(next: readonly WorkerNodeEntity[]): void {
  const live = telemetryTransientRef.snapshot;
  const byId = new Map<string, MutableNode>();
  for (const node of live.nodes) {
    byId.set(node.id, node);
  }

  const merged: MutableNode[] = next.map((incoming) => {
    const existing = byId.get(incoming.id);
    const target: MutableNode = existing ?? {
      id: incoming.id,
      name: incoming.name,
      ip: incoming.ip,
      status: incoming.status,
      cpuCapacity: incoming.cpuCapacity,
      memCapacity: incoming.memCapacity,
      networkMbps: incoming.networkMbps,
      rackIndex: incoming.rackIndex,
      podIds: [],
    };
    target.name = incoming.name;
    target.ip = incoming.ip;
    target.status = incoming.status;
    target.cpuCapacity = incoming.cpuCapacity;
    target.memCapacity = incoming.memCapacity;
    target.networkMbps = incoming.networkMbps;
    target.rackIndex = incoming.rackIndex;
    target.podIds = [...incoming.podIds];
    return target;
  });

  live.nodes = merged;
}

/** Force a target refresh without adopting a new snapshot (after manual edits). */
export function flushTargets(): void {
  refreshTargets();
}

/**
 * Feeds one frame delta into the FPS estimator.
 *
 * Call this exactly once per `useFrame`, BEFORE reading `currentFps`. The delta
 * is clamped so a backgrounded tab that resumes after 30 s does not report a
 * 0.03 FPS outlier to the perf HUD.
 *
 * @param deltaSeconds - frame duration in seconds, straight from `useFrame`
 */
export function noteFrame(deltaSeconds: number): void {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
    return;
  }
  const clamped = Math.min(Math.max(deltaSeconds, 1 / 240), 1);
  const frameMs = clamped * 1000;
  const alpha = 0.12;
  const smoothed =
    telemetryTransientRef.smoothedFrameMs * (1 - alpha) + frameMs * alpha;
  telemetryTransientRef.smoothedFrameMs = smoothed;
  telemetryTransientRef.currentFps = Math.round(1000 / smoothed);
}

/* ==========================================================================
   Chaos injection
   ========================================================================== */

/**
 * Applies a chaos scenario to the live snapshot.
 *
 * Demo semantics, documented so nobody mistakes this for a real chaos engine:
 * - `POD_OOM_SWARM`    : the 6 pods with the highest memory are pushed into
 *                        OOMKilled / CrashLoopBackOff.
 * - `NODE_CPU_SPIKE`   : the node hosting the most pods goes HighLoad and every
 *                        pod on it jumps above 85% CPU.
 * - `NET_PACKET_LOSS`  : the busiest node is partitioned. Its pods are dropped
 *                        to Pending and their telemetry zeroes out, mirroring
 *                        what the scheduler reports when a kubelet is
 *                        unreachable for longer than the grace period.
 * - `NONE`             : full recovery of every pod and node.
 *
 * Every alert whose source was healed is marked resolved so the alert counter
 * tracks the visual state.
 */
export function applyChaos(scenario: ChaosScenario): void {
  const live = telemetryTransientRef.snapshot;

  switch (scenario) {
    case 'NONE': {
      for (const pod of live.pods) {
        pod.status = 'Running';
        pod.cpuUsage = clampPercentage(24 + (pod.restarts % 5) * 3);
        pod.memoryUsage = clampPercentage(30 + (pod.restarts % 4) * 4);
        pushSample(pod.cpuHistory, pod.cpuUsage);
        pushSample(pod.memHistory, pod.memoryUsage);
      }
      for (const node of live.nodes) {
        node.status = 'Ready';
      }
      markAlertsResolved(live, () => true);
      break;
    }

    case 'POD_OOM_SWARM': {
      const targets = [...live.pods]
        .sort((a, b) => b.memoryUsage - a.memoryUsage)
        .slice(0, 6);
      targets.forEach((pod, index) => {
        pod.status = index % 3 === 2 ? 'CrashLoopBackOff' : 'OOMKilled';
        pod.memoryUsage = clampPercentage(96 + index * 0.6);
        pod.cpuUsage = clampPercentage(84 + index * 2.2);
        pod.restarts += 2;
        pushSample(pod.cpuHistory, pod.cpuUsage);
        pushSample(pod.memHistory, pod.memoryUsage);
      });
      break;
    }

    case 'NODE_CPU_SPIKE': {
      const busiest = pickBusiestNode(live);
      if (busiest !== null) {
        busiest.status = 'HighLoad';
        for (const pod of live.pods) {
          if (pod.nodeId !== busiest.id || pod.status !== 'Running') {
            continue;
          }
          pod.cpuUsage = clampPercentage(86 + (pod.restarts % 4) * 3);
          pushSample(pod.cpuHistory, pod.cpuUsage);
        }
      }
      break;
    }

    case 'NET_PACKET_LOSS': {
      const busiest = pickBusiestNode(live);
      if (busiest !== null) {
        busiest.status = 'NetworkPartition';
        for (const pod of live.pods) {
          if (pod.nodeId !== busiest.id) {
            continue;
          }
          pod.status = 'Pending';
          pod.cpuUsage = 0;
          pod.memoryUsage = 0;
          pushSample(pod.cpuHistory, 0);
          pushSample(pod.memHistory, 0);
        }
      }
      break;
    }
  }

  recomputeAggregates(live);
  telemetryTransientRef.revision += 1;
  refreshTargets();
}

function pickBusiestNode(live: MutableSnapshot): MutableNode | null {
  let best: MutableNode | null = null;
  for (const node of live.nodes) {
    if (best === null || node.podIds.length > best.podIds.length) {
      best = node;
    }
  }
  return best;
}

function markAlertsResolved(
  live: MutableSnapshot,
  predicate: (alert: MutableAlertEvent) => boolean,
): void {
  for (const alert of live.activeAlerts) {
    if (!alert.resolved && predicate(alert)) {
      alert.resolved = true;
    }
  }
}

/** Recomputes health, qps and the node statuses implied by pod damage. */
function recomputeAggregates(live: MutableSnapshot): void {
  live.clusterHealthScore = computeHealthScore(live.pods, live.nodes);
  live.totalQps = computeTotalQps(live.clusterHealthScore);
}

/* ==========================================================================
   Self-healing
   ========================================================================== */

/* ==========================================================================
   Self-healing contract
   ========================================================================== */

/**
 * Hard ceiling for a pod's CPU after a successful self-heal.
 *
 * The generative UI promises "CPU drops below 35%". Every healing branch below
 * derives its value from this constant instead of hardcoding a number, so the
 * promise can only be broken in one place - and a runtime assertion in
 * `applyHeal` catches it if it ever is.
 */
export const HEAL_CPU_CEILING = 35;

/** CPU target after `restart_pod` (a fresh, lightly loaded container). */
export const HEAL_CPU_RESTART = 28.6;

/** CPU target after `auto_heal` (controller reclaims and rebalances). */
export const HEAL_CPU_AUTO = 26.4;

/** CPU target after `scale_deployment` (load spread across more replicas). */
export const HEAL_CPU_SCALED = 22.9;

/** CPU target for pods housed on a node healed by `drain_node`. */
export const HEAL_CPU_DRAINED = 19.7;

/** Floor so a healed pod never renders as a dead, zero-load cell. */
export const HEAL_CPU_MIN = 8;

export interface HealOutcome {
  readonly ok: boolean;
  readonly message: string;
  /** Which entity actually changed, so the caller can log it precisely. */
  readonly kind: 'pod' | 'node' | 'master' | null;
  /** Id of the entity that ended up healed (null on failure). */
  readonly targetId: string | null;
  /** Human label of the healed entity, for the operator log. */
  readonly targetLabel: string | null;
  /** Status the healed pod ended in; undefined when no pod was touched. */
  readonly statusAfter: PodStatus | undefined;
  /** CPU the healed pod ended at; undefined when no pod was touched. */
  readonly cpuAfter: number | undefined;
  /** How many pods were healed (1 for a pod target, N for a node target). */
  readonly affectedPodCount: number;
}

function healFailure(
  message: string,
  targetId: string | null = null,
): HealOutcome {
  return {
    ok: false,
    message,
    kind: null,
    targetId,
    targetLabel: null,
    statusAfter: undefined,
    cpuAfter: undefined,
    affectedPodCount: 0,
  };
}

/**
 * Writes the healed values into a pod and back into the Float32 target pool.
 *
 * Ordering matters: mutate the live object first, then `pushSample` so the
 * sparkline records the recovered value, then let `refreshTargets()` publish
 * the new number into `podCpuFloat32` / `podMemFloat32`. `refreshTargets` is
 * called once by the caller after all pods are updated, so a node-wide heal
 * writes the pool exactly once instead of once per pod.
 */
function applyHealToPod(
  pod: MutablePod,
  cpu: number,
  mem: number,
  bumpRestarts: boolean,
): void {
  if (bumpRestarts) {
    pod.restarts += 1;
  }
  pod.status = 'Running';
  /* Belt-and-braces: even if a caller passes an out-of-band number, the pod can
     never exceed the ceiling or fall below the visible floor. */
  pod.cpuUsage = clampPercentage(
    Math.min(Math.max(cpu, HEAL_CPU_MIN), HEAL_CPU_CEILING - 0.1),
  );
  pod.memoryUsage = clampPercentage(mem);
  pushSample(pod.cpuHistory, pod.cpuUsage);
  pushSample(pod.memHistory, pod.memoryUsage);
}

/**
 * Applies a self-healing action and rewrites the live snapshot in place.
 *
 * GUARANTEES on success:
 * - Pod targets end at `status === 'Running'` and `cpuUsage < 35`.
 * - Node targets end at `status === 'Ready'` and every hosted pod is Running
 *   with `cpuUsage < 35`.
 * - Alerts sourced from the healed entity are marked resolved.
 * - `clusterHealthScore` / `totalQps` are recomputed and both Float32 target
 *   arrays are republished, so the next `useFrame` tick eases toward the new
 *   values without a React render.
 *
 * `actionType` is a plain `string` on the store boundary (it may come from a
 * model tool call or a URL param); this function is the narrowing checkpoint.
 * Callers pass `isHealActionType`-validated values, and unknown actions fall
 * through to a no-op failure instead of corrupting telemetry.
 */
export function applyHeal(
  targetId: string,
  actionType: HealActionType,
): HealOutcome {
  const live = telemetryTransientRef.snapshot;
  const pod = findLivePod(targetId);
  const node = findLiveNode(targetId);

  if (pod === null && node === null) {
    return healFailure(
      `heal rejected: no pod or node with id "${targetId}"`,
      targetId,
    );
  }

  if (pod !== null) {
    /* `drain_node` on a POD target is meaningless - draining evicts pods FROM a
       node. Rejecting it keeps the invariant "successful pod heal => Running"
       true for every accepted action, instead of returning ok while leaving the
       pod Terminating. */
    if (actionType === 'drain_node') {
      return healFailure(
        `drain_node targets nodes, not pods - use restart_pod for ${pod.name}`,
        targetId,
      );
    }

    switch (actionType) {
      case 'restart_pod': {
        applyHealToPod(pod, HEAL_CPU_RESTART, 38.2, true);
        break;
      }
      case 'scale_deployment': {
        /* Scale-out halves the per-replica load, but a pod that was pegged at
           96% would land at 52% - still over the ceiling. Take the minimum of
           the halved value and the fixed post-scale target. */
        const halved = pod.cpuUsage * 0.55;
        applyHealToPod(
          pod,
          Math.min(halved, HEAL_CPU_SCALED),
          Math.min(pod.memoryUsage * 0.62, 44.5),
          false,
        );
        break;
      }
      case 'auto_heal': {
        applyHealToPod(pod, HEAL_CPU_AUTO, 33.8, false);
        break;
      }
    }

    markAlertsResolved(live, (alert) => alert.sourceId === pod.id);
    recomputeAggregates(live);
    telemetryTransientRef.revision += 1;
    refreshTargets();

    return {
      ok: true,
      message: `${actionType} healed pod ${pod.name} -> Running (cpu ${pod.cpuUsage.toFixed(1)}%)`,
      kind: 'pod',
      targetId: pod.id,
      targetLabel: pod.name,
      statusAfter: pod.status,
      cpuAfter: pod.cpuUsage,
      affectedPodCount: 1,
    };
  }

  /* Node target. */
  if (node === null) {
    return healFailure('heal rejected: target vanished', targetId);
  }

  if (actionType !== 'drain_node' && actionType !== 'auto_heal') {
    return healFailure(
      `${actionType} is not applicable to node ${node.name}`,
      targetId,
    );
  }

  const cpuForHosted =
    actionType === 'drain_node' ? HEAL_CPU_DRAINED : HEAL_CPU_AUTO;
  const memForHosted = actionType === 'drain_node' ? 27.4 : 35.6;

  node.status = 'Ready';
  let affectedPodCount = 0;
  let lastCpu = 0;
  for (const hosted of live.pods) {
    if (hosted.nodeId !== node.id) {
      continue;
    }
    applyHealToPod(hosted, cpuForHosted, memForHosted, false);
    markAlertsResolved(live, (alert) => alert.sourceId === hosted.id);
    affectedPodCount += 1;
    lastCpu = hosted.cpuUsage;
  }
  markAlertsResolved(live, (alert) => alert.sourceId === node.id);
  recomputeAggregates(live);
  telemetryTransientRef.revision += 1;
  refreshTargets();

  return {
    ok: true,
    message: `${actionType} healed node ${node.name} -> Ready (${affectedPodCount} pods, cpu ${lastCpu.toFixed(1)}%)`,
    kind: 'node',
    targetId: node.id,
    targetLabel: node.name,
    statusAfter: 'Running',
    cpuAfter: lastCpu,
    affectedPodCount,
  };
}

/* ==========================================================================
   Test / hot-reload reset
   ========================================================================== */

/**
 * Restores the pool to the seed state.
 *
 * Intended for unit tests and Next.js hot reload; calling it in production
 * would silently wipe live telemetry, so it is not exposed on the store.
 */
export function resetTelemetryTransient(): void {
  const fresh = createLiveSnapshot();
  telemetryTransientRef.snapshot = fresh;
  telemetryTransientRef.currentFps = 60;
  telemetryTransientRef.smoothedFrameMs = 1000 / 60;
  telemetryTransientRef.revision = 0;
  refreshTargets();
}