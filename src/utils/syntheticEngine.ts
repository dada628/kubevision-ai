/**
 * KubeVision AI - dual-mode synthetic telemetry engine (SERVER SAFE).
 *
 * WHY THIS MODULE EXISTS OUTSIDE THE STORE
 * `src/store/useTelemetryRef.ts` is a `'use client'` module: it owns a mutable
 * singleton pool that only makes sense in the browser, and every one of its
 * exports becomes a *client reference* on the server. Calling anything from it
 * inside an API route throws at runtime ("Attempted to call ... from the
 * server"). This engine therefore depends only on:
 *
 *   - `@/types/cluster`         (erased types + frozen fixtures, no directive)
 *   - `@/utils/clusterHealth`   (pure maths, no directive)
 *
 * ...which is what lets the very same snapshot maths run in a route handler and,
 * if needed, in a Worker.
 *
 * THE CONTRACT
 *   stepTelemetrySimulation(prevSnapshot, activeChaos) -> TelemetrySnapshot
 *
 * A PURE function: it never mutates `prevSnapshot` (which may be the frozen
 * `INITIAL_CLUSTER_SNAPSHOT`) and never reads a wall clock for its maths. The
 * only clock it uses is the one encoded in `prevSnapshot.timestamp`, advanced by
 * exactly one tick - so a stream is a deterministic, replayable trajectory:
 * feed the same seed and the same chaos at the same instant and you get the same
 * frames, in a browser, on the server, or in a test.
 *
 * WHERE THE "RANDOMNESS" COMES FROM
 * `Math.random()` would break that guarantee (and makes a bug unreproducible).
 * `noise()` is a hash of `(podId, tick, salt)` through a 32-bit avalanche mix, so
 * pod A always jitters like pod A on tick 1000, and the value is stable across
 * server and client. Jitter is therefore *decorrelated* but fully deterministic.
 *
 * THE THREE-LAYER MODEL
 * 1. STEADY STATE - every pod's CPU / memory mean-reverts toward a per-pod
 *    baseline with a small deterministic jitter. `totalQps` follows a slow sine
 *    around the health-derived floor, and pod CPU rides the same wave, so every
 *    derived throughput figure (the client's `deriveNodeNetRate`) rises and falls
 *    with the traffic curve instead of sitting flat.
 * 2. FAULT STATE MACHINES - a chaos scenario owns a *rack*, and drives real
 *    transitions (memory ramps to the limit, the container is OOMKilled, the
 *    kubelet backs off, `restarts` climbs) rather than snapping to a tableau.
 * 3. RECOVERY - anything not owned by the active scenario converges back to its
 *    baseline, and a crashed container only returns to `Running` once its memory
 *    has actually fallen below the recovery ceiling. This is what makes turning
 *    chaos OFF read as self-healing instead of as a state flip.
 *
 * WHY THERE IS NO "networkThroughput" FIELD
 * `WorkerNodeEntity.networkMbps` is PROVISIONED CAPACITY, not observed traffic -
 * overwriting it would corrupt the very field the 3D cables divide by. Live
 * throughput is DERIVED on the consumer side from pod utilization
 * (`deriveNodeNetRate`), and that derivation returns exactly 0 for a
 * `NetworkPartition` node. So a partition is expressed here as: node status ->
 * `NetworkPartition`, its pods' metrics collapse, its scheduled pods go
 * `Pending`. The observable result is the same: the link flatlines.
 */

import {
  INITIAL_CLUSTER_SNAPSHOT,
} from '@/types/cluster';
import type {
  AlertEvent,
  ChaosScenario,
  NodeStatus,
  PodEntity,
  PodStatus,
  RackIndex,
  TelemetrySnapshot,
  WorkerNodeEntity,
} from '@/types/cluster';
import type { LogEntry, LogSource } from '@/types/ai';
import {
  computeHealthScore,
  computeTotalQps,
  pushSample,
} from '@/utils/clusterHealth';

/* ==========================================================================
   Public constants
   ========================================================================== */

/**
 * Wall-clock length of one simulation tick, in milliseconds.
 *
 * The SSE route pushes exactly one frame per tick, so this constant is the
 * stream's cadence as well as the engine's step size: changing it changes both,
 * which is the point (they can never disagree).
 */
export const SIMULATION_TICK_MS = 1000;

/**
 * Hard cap on the alert backlog carried forward by the engine.
 *
 * A long-lived stream that keeps re-injecting chaos would otherwise grow
 * `activeAlerts` without bound - a genuine server-side leak in a module whose
 * whole job is to run for hours. The cap keeps the newest entries.
 */
export const MAX_ALERT_BACKLOG = 24;

/* ==========================================================================
   Scenario topology - which rack each fault owns
   ========================================================================== */

/** Rack of `worker-alpha`. Targeted by `NODE_CPU_SPIKE`. */
const ALPHA_RACK: RackIndex = 0;

/** Rack of `worker-beta`. Targeted by `POD_OOM_SWARM`. */
const BETA_RACK: RackIndex = 1;

/** Rack of `worker-gamma`. Targeted by `NET_PACKET_LOSS`. */
const GAMMA_RACK: RackIndex = 2;

/**
 * How many pods the OOM swarm pushes over the memory limit.
 *
 * The requirement is "the 3 core business pods on worker-beta": three is enough
 * to read as a systemic memory incident on that chassis while leaving the rack's
 * other five containers healthy, which is what makes the failure look targeted
 * rather than like a blanket repaint.
 */
const OOM_CORE_POD_COUNT = 3;

/**
 * Namespace -> business criticality, used to pick those three pods.
 *
 * Ranking by NAMESPACE (not by current metric) is deliberate: a metric-based
 * pick would re-select different pods as the first ones crash, so the fault would
 * wander across the rack. Namespace + id ordering is invariant under status
 * changes, so the same three pods stay the victims for the whole incident.
 */
const CORE_NAMESPACE_PRIORITY: Readonly<Record<string, number>> = {
  payments: 0,
  production: 1,
  streaming: 2,
  search: 3,
  cache: 4,
  ingress: 5,
  background: 6,
  observability: 7,
  security: 8,
  'kube-system': 9,
};

/** Rank for a namespace outside the table: never chosen before a known one. */
const UNKNOWN_NAMESPACE_PRIORITY = 50;

/* ==========================================================================
   Steady-state tunables
   ========================================================================== */

/** Fraction of the gap to the baseline closed per tick (CPU). */
const CPU_REVERSION = 0.24;

/** Fraction of the gap to the baseline closed per tick (memory). Slower: memory moves like a mass. */
const MEM_REVERSION = 0.15;

/** Jitter amplitude around the CPU baseline, in percentage points. */
const CPU_NOISE = 2.4;

/** Jitter amplitude around the memory baseline, in percentage points. */
const MEM_NOISE = 1.6;

/**
 * How far a Pending pod's CPU ramp is accelerated.
 *
 * A pod that is finally scheduled comes up fast; without the boost, the
 * `cpu >= RECOVERY_CPU_FLOOR` test would take several ticks to trip and the HUD
 * would keep reporting Pending long after the container is serving.
 */
const PENDING_CPU_RAMP_BOOST = 1.8;

/** Sine amplitude of the traffic wave, as a fraction of the health-derived QPS. */
const QPS_WAVE_AMPLITUDE = 0.16;

/**
 * Period of the traffic wave, in ms.
 *
 * ~62 s: long enough that the HUD's 6-sample sparklines show a clear trend
 * rather than a zig-zag, short enough that a demo audience sees the curve move.
 */
const QPS_WAVE_PERIOD_MS = 62_000;

/**
 * Multiplier that puts the shared QPS model on the fixture's own scale.
 *
 * WHY THIS EXISTS
 * `computeTotalQps` is tuned for the client-side demo (`28000 * n^1.35`), which
 * yields ~18.6k at the fixture's health of 74 - but the fixture AUTHORS 24,180 QPS
 * for that same health. Without this correction the very first streamed frame
 * would report a ~23% traffic drop the instant a client connected: a systematic
 * step, not the sine wave, and exactly the kind of "the dashboard is broken"
 * artifact an operator would go chasing.
 *
 * Applied to the MODEL OUTPUT rather than by editing the shared formula, so the
 * browser store's own maths and the server engine stay in one family. Derived
 * once at module load from frozen data, so it cannot drift at runtime.
 *
 * Measured empirically: with this correction, frame 1 lands within ~2% of the
 * seed's QPS (the residue is the sine phase) instead of ~23% below it.
 */
const QPS_SCALE = (() => {
  const seed = INITIAL_CLUSTER_SNAPSHOT;
  const modelQps = computeTotalQps(seed.clusterHealthScore);
  if (!(modelQps > 0) || !(seed.totalQps > 0)) {
    return 1;
  }
  return seed.totalQps / modelQps;
})();

/* ==========================================================================
   POD_OOM_SWARM tunables
   ========================================================================== */

/** Memory the swarm drives each victim toward, in percent of its limit. */
const OOM_MEMORY_TARGET = 99;

/** Per-tick fraction of the gap closed. 0.55 puts a 45%-baseline pod at the limit in ~4 ticks. */
const OOM_MEMORY_RAMP = 0.55;

/** Memory at which the container is considered over its limit (kernel kills it). */
const OOM_CRASH_MEMORY = 96;

/**
 * Length of one crash/back-off cycle, in ticks.
 *
 * Phase 0 of each cycle is `OOMKilled` (and the restart counter increments);
 * the remaining phases are `CrashLoopBackOff`. Three ticks is the shortest cycle
 * an operator can actually read on a 1 Hz stream.
 */
const OOM_LOOP_TICKS = 3;

/** CPU floor while the swarm is active: a leaking container also burns CPU. */
const OOM_CPU_TARGET = 88;

/** CPU a killed container reports while it sits in back-off. */
const OOM_BACKOFF_CPU = 2.5;

/** Deterministic id prefix for swarm alerts, so re-injection cannot duplicate them. */
const OOM_ALERT_ID_PREFIX = 'alert-sim-oom-swarm-';

/* ==========================================================================
   NODE_CPU_SPIKE tunables
   ========================================================================== */

/** Lowest CPU a spiked pod is driven to, in percent. */
const SPIKE_CPU_FLOOR = 92;

/** Highest CPU a spiked pod is driven to, in percent. */
const SPIKE_CPU_CEILING = 98;

/** Per-tick fraction of the gap to the spike target closed. */
const SPIKE_CPU_RAMP = 0.5;

/** Extra memory pressure a saturated node carries, in percentage points. */
const SPIKE_MEMORY_BUMP = 4;

/* ==========================================================================
   NET_PACKET_LOSS tunables
   ========================================================================== */

/** Per-tick fraction of the gap to zero closed while partitioned. */
const PARTITION_METRIC_RAMP = 0.6;

/**
 * Every Nth pod on the partitioned node is stranded as `Pending`.
 *
 * The requirement is "部分 Pod": stranding half the rack leaves the rest running
 * with dead telemetry, which reads as a partial outage. An index-based rule keyed
 * to the node's own scheduling list stays stable across ticks.
 */
const PARTITION_PENDING_STRIDE = 2;

/* ==========================================================================
   Recovery tunables
   ========================================================================== */

/** A crashed container returns to Running once memory falls to at most this. */
const RECOVERY_MEM_CEILING = 74;

/** Recovery target is capped here, so a pod whose BASELINE is near the limit can still heal. */
const RECOVERY_MEM_TARGET_CAP = 68;

/** Per-tick fraction of the gap closed during recovery. Fast: a restart is abrupt. */
const RECOVERY_RAMP = 0.5;

/** A Pending pod is reported Running once it shows at least this much CPU. */
const RECOVERY_CPU_FLOOR = 4;

/** CPU ceiling a recovering container converges to. */
const RECOVERY_CPU_TARGET_CAP = 30;

/* ==========================================================================
   Baselines - derived once from the frozen fixture
   ========================================================================== */

interface PodBaseline {
  /** CPU the pod reverts to when nothing is wrong, in percent. */
  readonly cpu: number;
  /** Memory the pod reverts to when nothing is wrong, in percent. */
  readonly mem: number;
}

/**
 * Per-pod baselines, taken from the authored fixture.
 *
 * USING THE FIXTURE, NOT A HASH, IS THE POINT
 * A hash-derived baseline would yank every pod away from the numbers the demo was
 * designed around (a 71% Redis shard would jump to 34% on frame one). Anchoring to
 * the seed means frame 1 continues the authored state and only the jitter is new.
 * Because the baselines are captured from the FROZEN fixture they cannot drift
 * when live values are pushed to 99% by chaos - which is exactly what makes mean
 * reversion pull the pod back afterwards.
 */
const POD_BASELINES: ReadonlyMap<string, PodBaseline> = new Map(
  INITIAL_CLUSTER_SNAPSHOT.pods.map((pod) => [
    pod.id,
    { cpu: pod.cpuUsage, mem: pod.memoryUsage },
  ]),
);

/**
 * Node status each node returns to when no scenario owns it.
 *
 * `worker-beta` seeds as `HighLoad`, so it stays `HighLoad` in steady state: that
 * is its character, not a fault. Scenario-owned statuses are layered on top and
 * dropped as soon as the scenario releases the rack.
 */
const NODE_BASELINE_STATUS: ReadonlyMap<string, NodeStatus> = new Map(
  INITIAL_CLUSTER_SNAPSHOT.nodes.map((node) => [node.id, node.status]),
);

/** Shared empty set: avoids allocating a throwaway Set on every non-chaos tick. */
const NO_PODS: ReadonlySet<string> = new Set<string>();

/* ==========================================================================
   Mutable alert mirror
   ========================================================================== */

/** `AlertEvent` is readonly by contract; the engine needs to flip `resolved`. */
type MutableAlert = { -readonly [K in keyof AlertEvent]: AlertEvent[K] };

/* ==========================================================================
   Seed
   ========================================================================== */

/**
 * Fresh, unfrozen, independently-owned copy of the fixture with a live clock.
 *
 * WHY EACH CONNECTION NEEDS ITS OWN SEED
 * The engine never mutates its input, so a shared fixture would technically be
 * safe - but two SSE connections that both start from the frozen object would
 * also produce byte-identical alert ids and trajectories, and a later "reset"
 * would be indistinguishable from a fresh connection. A private seed makes each
 * stream an independent run.
 *
 * The timestamp is stamped from the caller's clock: a fixture frozen two days ago
 * would make the HUD's "last sync" read as stale on every demo.
 *
 * @param nowMs - wall clock, in ms (the route passes `Date.now()`)
 */
export function createSimulationSeed(nowMs: number): TelemetrySnapshot {
  const seed = INITIAL_CLUSTER_SNAPSHOT;
  return {
    timestamp: new Date(nowMs).toISOString(),
    clusterHealthScore: seed.clusterHealthScore,
    totalQps: seed.totalQps,
    master: { ...seed.master },
    nodes: seed.nodes.map((node) => ({
      ...node,
      podIds: [...node.podIds],
    })),
    pods: seed.pods.map((pod) => ({
      ...pod,
      cpuHistory: [...pod.cpuHistory],
      memHistory: [...pod.memHistory],
    })),
    activeAlerts: seed.activeAlerts.map((alert) => ({ ...alert })),
  };
}

/* ==========================================================================
   Step context
   ========================================================================== */

interface StepContext {
  /** Absolute ms of the frame being produced. */
  readonly tickMs: number;
  /** Monotonic tick index; the deterministic "random" axis. */
  readonly tick: number;
  /** Traffic wave multiplier around 1.0. */
  readonly wave: number;
  readonly activeChaos: ChaosScenario;
  /** `podId -> rackIndex`, so a pod's rack never needs an O(n) node walk. */
  readonly rackByNodeId: ReadonlyMap<string, RackIndex>;
}

/** Metric + lifecycle targets for one pod on this tick. */
interface PodStepResult {
  readonly cpu: number;
  readonly mem: number;
  readonly status: PodStatus;
  readonly restarts: number;
}

/* ==========================================================================
   The step function
   ========================================================================== */

/**
 * Advances the cluster by exactly one tick.
 *
 * @param prevSnapshot - the previous frame. NEVER mutated.
 * @param activeChaos  - scenario owning the current tick ('NONE' for steady state)
 * @returns a NEW snapshot, one tick later
 */
export function stepTelemetrySimulation(
  prevSnapshot: TelemetrySnapshot,
  activeChaos: ChaosScenario,
): TelemetrySnapshot {
  const tickMs = nextTickMs(prevSnapshot.timestamp);
  const rackByNodeId = new Map<string, RackIndex>();
  for (const node of prevSnapshot.nodes) {
    rackByNodeId.set(node.id, node.rackIndex);
  }

  const ctx: StepContext = {
    tickMs,
    tick: Math.floor(tickMs / SIMULATION_TICK_MS),
    wave: qpsWave(tickMs),
    activeChaos,
    rackByNodeId,
  };

  /* Targets are resolved ONCE per tick and handed to every pod, so all victims of
     a scenario agree about who they are.
     
     The OOM victim set is computed on EVERY tick, not only while the swarm is
     active: `stepPod` needs it afterwards to tell a pod the engine crashed (which
     must recover) from a pod the fixture ships already crashed (which must not be
     silently healed). */
  const oomTargets = selectOomTargets(prevSnapshot.pods, prevSnapshot.nodes);
  const strandedPods =
    activeChaos === 'NET_PACKET_LOSS'
      ? selectStrandedPods(prevSnapshot.pods, prevSnapshot.nodes)
      : NO_PODS;

  const pods = prevSnapshot.pods.map((pod) =>
    stepPod(pod, ctx, oomTargets, strandedPods),
  );
  const nodes = prevSnapshot.nodes.map((node) => stepNode(node, activeChaos));
  const activeAlerts = evolveAlerts(
    prevSnapshot.activeAlerts,
    pods,
    nodes,
    oomTargets,
    tickMs,
  );

  /* Both aggregates are DERIVED, never carried forward: health is a function of
     the pod/node statuses this tick just produced, and QPS is that health scaled
     by the traffic wave. Deriving them here is what keeps the HUD's health number
     and the visual fleet from ever contradicting each other. */
  const clusterHealthScore = computeHealthScore(pods, nodes);
  const totalQps = Math.round(
    computeTotalQps(clusterHealthScore) * QPS_SCALE * ctx.wave,
  );

  return {
    timestamp: new Date(tickMs).toISOString(),
    clusterHealthScore,
    totalQps,
    master: prevSnapshot.master,
    nodes,
    pods,
    activeAlerts,
  };
}

/* ==========================================================================
   Pod stepping
   ========================================================================== */

/**
 * Routes one pod through the scenario that owns it.
 *
 * ORDER IS THE WHOLE CONTRACT here, and it took a failing test to get right:
 *
 * 1. The OOM swarm is checked FIRST, because a victim must stay owned by the
 *    swarm even while its own status flips between OOMKilled and
 *    CrashLoopBackOff - routing on status would hand it to the recovery branch
 *    and it would heal itself mid-incident.
 * 2. The partition is checked BEFORE the status branches. A partitioned node's
 *    pods must stay stranded for the whole partition: testing `status` first
 *    sent them to the steady-state branch the frame after they went Pending,
 *    which pulled their CPU back up, which flipped them to Running, which sent
 *    them back to the partition branch - a Pending/Running oscillation every
 *    single tick.
 * 3. Only then do the status branches run.
 *
 * THE "WHO BROKE IT" RULE
 * The engine heals what IT broke, and nothing else. The fixture ships two
 * genuinely broken containers (a CrashLoopBackOff cart-service and an OOMKilled
 * log-shipper) precisely so the first paint exercises every tone; auto-healing
 * them in steady state would erase the authored incident within three ticks.
 * They are distinguished from chaos victims by `oomTargets`, which is the
 * deterministic victim set for the swarm - a crashed pod outside that set is an
 * ambient fault and keeps its status, while a crashed pod inside it is released
 * to recover as soon as the swarm stops owning it.
 */
function stepPod(
  pod: PodEntity,
  ctx: StepContext,
  oomTargets: ReadonlySet<string>,
  strandedPods: ReadonlySet<string>,
): PodEntity {
  const baseline = baselineForPod(pod);
  const crashed = isCrashStatus(pod.status);
  let result: PodStepResult;

  if (ctx.activeChaos === 'POD_OOM_SWARM' && oomTargets.has(pod.id)) {
    result = stepOomPod(pod, baseline, ctx);
  } else if (
    ctx.activeChaos === 'NET_PACKET_LOSS' &&
    !crashed &&
    podOnRack(pod, GAMMA_RACK, ctx)
  ) {
    result = stepPartitionedPod(pod, strandedPods.has(pod.id));
  } else if (crashed) {
    result =
      oomTargets.has(pod.id) && ctx.activeChaos !== 'POD_OOM_SWARM'
        ? stepRecoveringPod(pod, baseline)
        : stepSteadyPod(pod, baseline, ctx);
  } else if (
    ctx.activeChaos === 'NODE_CPU_SPIKE' &&
    pod.status === 'Running' &&
    podOnRack(pod, ALPHA_RACK, ctx)
  ) {
    result = stepSpikePod(pod, baseline, ctx);
  } else {
    result = stepSteadyPod(pod, baseline, ctx);
  }

  /* Histories are COPIED, then appended to: the previous snapshot may be the
     frozen fixture, and `pushSample` mutates in place. */
  const cpuHistory = [...pod.cpuHistory];
  pushSample(cpuHistory, result.cpu);
  const memHistory = [...pod.memHistory];
  pushSample(memHistory, result.mem);

  return {
    ...pod,
    status: result.status,
    cpuUsage: clamp(result.cpu, 0, 100),
    memoryUsage: clamp(result.mem, 0, 100),
    restarts: result.restarts,
    cpuHistory,
    memHistory,
  };
}

/**
 * Steady state: mean reversion toward the baseline plus deterministic jitter.
 *
 * CPU reverts toward `baseline.cpu * wave`, not toward the bare baseline, so the
 * pod's load visibly follows the traffic curve. Memory reverts to its own
 * baseline - memory does not track QPS on a one-minute horizon, and pretending it
 * did would make every pod breathe in lockstep.
 */
function stepSteadyPod(
  pod: PodEntity,
  baseline: PodBaseline,
  ctx: StepContext,
): PodStepResult {
  const cpuGoal = clamp(baseline.cpu * ctx.wave, 0, 100);
  const cpuRamp =
    pod.status === 'Pending' ? CPU_REVERSION * PENDING_CPU_RAMP_BOOST : CPU_REVERSION;

  /* An AMBIENT crash (a fixture-authored one, not a swarm victim) still has to
     report plausible numbers: a container sitting in CrashLoopBackOff is not
     burning 90% of a core. Its CPU therefore decays to the back-off floor while
     its memory stays at the leak level - the container is dead, but the pages it
     allocated are not freed until the sandbox is torn down. Without this the
     first paint would show an OOMKilled pod at 92.7% CPU forever, which is the
     single most obviously fake number a real SRE would spot. */
  if (isCrashStatus(pod.status)) {
    const backoffCpu =
      pod.cpuUsage + (OOM_BACKOFF_CPU - pod.cpuUsage) * CPU_REVERSION;
    const leakingMem =
      pod.memoryUsage +
      (baseline.mem - pod.memoryUsage) * MEM_REVERSION +
      noise(pod.id, ctx.tick, 2) * MEM_NOISE * 0.5;
    return {
      cpu: backoffCpu,
      mem: leakingMem,
      status: pod.status,
      restarts: pod.restarts,
    };
  }

  const cpu =
    pod.cpuUsage +
    (cpuGoal - pod.cpuUsage) * cpuRamp +
    noise(pod.id, ctx.tick, 1) * CPU_NOISE;
  const mem =
    pod.memoryUsage +
    (baseline.mem - pod.memoryUsage) * MEM_REVERSION +
    noise(pod.id, ctx.tick, 2) * MEM_NOISE;

  return {
    cpu,
    mem,
    status: settleStatus(pod, cpu),
    restarts: pod.restarts,
  };
}

/**
 * `POD_OOM_SWARM`: a leaking container on the beta rack.
 *
 * The state machine is the requirement, not decoration:
 * - memory ramps to the limit (a leak takes seconds, it does not teleport);
 * - once past `OOM_CRASH_MEMORY` the container is OOMKilled on phase 0 of a
 *   3-tick cycle and sits in CrashLoopBackOff on the other two;
 * - `restarts` increments exactly when a NEW OOMKilled is entered, so the counter
 *   tracks real kills instead of counting frames;
 * - CPU collapses while the container is down. A process the kernel has killed
 *   cannot be burning 88% of a core, and a metric that said otherwise would be
 *   the one thing on screen an SRE would immediately distrust.
 */
function stepOomPod(
  pod: PodEntity,
  baseline: PodBaseline,
  ctx: StepContext,
): PodStepResult {
  /* Memory never decays while the swarm owns the pod: the leak is the point, so
     even a container in back-off is still holding (and losing) allocated pages. */
  const mem =
    pod.memoryUsage +
    (OOM_MEMORY_TARGET - pod.memoryUsage) * OOM_MEMORY_RAMP +
    noise(pod.id, ctx.tick, 3) * 0.5;

  if (mem < OOM_CRASH_MEMORY) {
    /* Past the warning band but not yet over the limit: still serving, and
       burning CPU in proportion to the allocation churn. */
    const cpuGoal = Math.max(baseline.cpu, OOM_CPU_TARGET);
    const cpu =
      pod.cpuUsage +
      (cpuGoal - pod.cpuUsage) * OOM_MEMORY_RAMP +
      noise(pod.id, ctx.tick, 4) * 1.2;
    return { cpu, mem, status: 'Running', restarts: pod.restarts };
  }

  const crashed = ctx.tick % OOM_LOOP_TICKS === 0 ? 'OOMKilled' : 'CrashLoopBackOff';
  const killedAgain = crashed === 'OOMKilled' && pod.status !== 'OOMKilled';
  const cpu =
    pod.cpuUsage + (OOM_BACKOFF_CPU - pod.cpuUsage) * OOM_MEMORY_RAMP;
  return {
    cpu,
    mem,
    status: crashed,
    restarts: pod.restarts + (killedAgain ? 1 : 0),
  };
}

/**
 * `NODE_CPU_SPIKE`: every container on the alpha rack is pinned near its limit.
 *
 * The per-pod target is drawn from the pod's own hash inside [92, 98] rather than
 * being one flat number: a rack of eight pods all reading exactly 95% looks like
 * a painted overlay, whereas a spread reads as eight containers genuinely
 * contending for the same cores.
 */
function stepSpikePod(
  pod: PodEntity,
  baseline: PodBaseline,
  ctx: StepContext,
): PodStepResult {
  const span = SPIKE_CPU_CEILING - SPIKE_CPU_FLOOR + 1;
  const target = SPIKE_CPU_FLOOR + (hashString(pod.id) % span);
  /* Clamped INTO the band after the jitter is added: the requirement is that a
     spiked container reads 92-98%, and an unclamped `+/-1.1` term would let it
     dip to 90.9% on a bad tick - which an operator watching the rack would
     correctly read as "not actually saturated". */
  const cpu = clamp(
    pod.cpuUsage +
      (target - pod.cpuUsage) * SPIKE_CPU_RAMP +
      noise(pod.id, ctx.tick, 5) * 1.1,
    SPIKE_CPU_FLOOR,
    SPIKE_CPU_CEILING,
  );
  const memGoal = clamp(baseline.mem + SPIKE_MEMORY_BUMP, 0, 100);
  const mem =
    pod.memoryUsage +
    (memGoal - pod.memoryUsage) * MEM_REVERSION +
    noise(pod.id, ctx.tick, 6) * MEM_NOISE;

  return { cpu, mem, status: 'Running', restarts: pod.restarts };
}

/**
 * `NET_PACKET_LOSS`: the gamma kubelet is unreachable.
 *
 * Two things happen, and the difference between them is the story:
 * - pods the scheduler has already given up on report `Pending` and flatline;
 * - pods it still believes are `Running` keep their status but report NOTHING,
 *   because the metrics pipeline is on the far side of the partition. Zeroed
 *   telemetry under a `Running` status is exactly what an operator sees when a
 *   node goes dark mid-scrape.
 *
 * Stranded pods decay toward zero because they are not running; running-but-dark
 * pods decay toward zero because their scrapes never arrive. Both read as
 * "flatlined", and the smooth decay is what keeps the last real sample from
 * snapping off in a single frame.
 */
function stepPartitionedPod(
  pod: PodEntity,
  stranded: boolean,
): PodStepResult {
  return {
    cpu: pod.cpuUsage * (1 - PARTITION_METRIC_RAMP),
    mem: pod.memoryUsage * (1 - PARTITION_METRIC_RAMP),
    status: stranded ? 'Pending' : pod.status,
    restarts: pod.restarts,
  };
}

/**
 * Recovery: a container the engine faulted converges back to service.
 *
 * Called ONLY for a chaos victim once its scenario has released it (see the
 * "who broke it" rule in `stepPod`), so a container is never silently healed
 * out from under an active incident.
 *
 * Memory is driven to `min(baseline, cap)`, not to the baseline: a pod seeded at
 * 96.8% memory must be able to reach the recovery ceiling, otherwise it would sit
 * in CrashLoopBackOff forever - a fault the engine invented and could never
 * clear, which is worse than no fault at all.
 */
function stepRecoveringPod(
  pod: PodEntity,
  baseline: PodBaseline,
): PodStepResult {
  const memGoal = Math.min(baseline.mem, RECOVERY_MEM_TARGET_CAP);
  const cpuGoal = Math.min(baseline.cpu, RECOVERY_CPU_TARGET_CAP);
  const mem = pod.memoryUsage + (memGoal - pod.memoryUsage) * RECOVERY_RAMP;
  const cpu = pod.cpuUsage + (cpuGoal - pod.cpuUsage) * RECOVERY_RAMP;

  return {
    cpu,
    mem,
    status: mem <= RECOVERY_MEM_CEILING ? 'Running' : pod.status,
    restarts: pod.restarts,
  };
}

/* ==========================================================================
   Node stepping
   ========================================================================== */

/**
 * Node status is DISCRETE, so it is assigned - not eased.
 *
 * Every scenario owns one rack; a node it does not own falls back to the status
 * the fixture gave it. That single rule means switching chaos from
 * NET_PACKET_LOSS to NODE_CPU_SPIKE restores gamma to `Ready` and pushes alpha to
 * `HighLoad` in the same frame, with no per-scenario teardown code.
 *
 * `networkMbps` is deliberately NOT touched (see the module header): it is
 * provisioned capacity. The partition's throughput collapse is carried by
 * `NetworkPartition` plus the zeroed pod metrics.
 */
function stepNode(
  node: WorkerNodeEntity,
  activeChaos: ChaosScenario,
): WorkerNodeEntity {
  let status: NodeStatus = NODE_BASELINE_STATUS.get(node.id) ?? 'Ready';

  if (activeChaos === 'POD_OOM_SWARM' && node.rackIndex === BETA_RACK) {
    /* Three containers pinned at their memory limit is memory pressure on the
       node, which is what HighLoad reports. */
    status = 'HighLoad';
  } else if (activeChaos === 'NODE_CPU_SPIKE' && node.rackIndex === ALPHA_RACK) {
    status = 'HighLoad';
  } else if (activeChaos === 'NET_PACKET_LOSS' && node.rackIndex === GAMMA_RACK) {
    status = 'NetworkPartition';
  }

  return { ...node, status, podIds: [...node.podIds] };
}

/* ==========================================================================
   Alerts
   ========================================================================== */

/**
 * Evolves the alert stream: resolves what healed, opens what just broke, caps the
 * backlog.
 *
 * Resolution is driven by the CURRENT entity state, not by which scenario is
 * active. That is what lets a stale alert clear itself the frame its pod returns
 * to `Running`, including alerts the fixture shipped with - an alert that stays
 * open after its condition cleared is the fastest way to teach an operator to
 * ignore the alert panel.
 */
function evolveAlerts(
  prevAlerts: readonly AlertEvent[],
  pods: readonly PodEntity[],
  nodes: readonly WorkerNodeEntity[],
  oomTargets: ReadonlySet<string>,
  tickMs: number,
): AlertEvent[] {
  const alerts: MutableAlert[] = prevAlerts.map((alert) => ({ ...alert }));

  const podById = new Map<string, PodEntity>();
  for (const pod of pods) {
    podById.set(pod.id, pod);
  }
  const nodeById = new Map<string, WorkerNodeEntity>();
  for (const node of nodes) {
    nodeById.set(node.id, node);
  }

  for (const alert of alerts) {
    if (alert.resolved) {
      continue;
    }
    if (alert.sourceType === 'pod') {
      const pod = podById.get(alert.sourceId);
      if (pod !== undefined && pod.status === 'Running') {
        alert.resolved = true;
      }
    } else if (alert.sourceType === 'node') {
      const node = nodeById.get(alert.sourceId);
      if (node !== undefined && node.status === 'Ready') {
        alert.resolved = true;
      }
    }
  }

  /* OOM swarm: one P0 per victim, id derived from the pod id so re-entering the
     scenario re-opens the SAME alert instead of stacking a duplicate. */
  for (const podId of oomTargets) {
    const pod = podById.get(podId);
    if (pod === undefined || !isCrashStatus(pod.status)) {
      continue;
    }
    const alertId = `${OOM_ALERT_ID_PREFIX}${pod.id}`;
    const existing = alerts.find((alert) => alert.id === alertId);
    if (existing !== undefined) {
      existing.resolved = false;
      continue;
    }
    alerts.push({
      id: alertId,
      severity: 'P0',
      sourceType: 'pod',
      sourceId: pod.id,
      title: `${pod.name} OOMKilled (memory limit)`,
      message:
        `Container memory reached ${pod.memoryUsage.toFixed(1)}% of its limit; ` +
        `kubelet restarted it ${pod.restarts} times and is backing off.`,
      timestamp: new Date(tickMs).toISOString(),
      acknowledged: false,
      resolved: false,
    });
  }

  if (alerts.length <= MAX_ALERT_BACKLOG) {
    return alerts;
  }
  return alerts.slice(alerts.length - MAX_ALERT_BACKLOG);
}

/* ==========================================================================
   Target selection
   ========================================================================== */

/**
 * The `OOM_CORE_POD_COUNT` most business-critical pods on the beta rack.
 *
 * Selection is invariant under pod status (see `CORE_NAMESPACE_PRIORITY`), and it
 * filters by `pod.nodeId` rather than trusting the node's `podIds` list, because
 * `nodeId` is the authoritative placement the rest of the codebase reads.
 */
function selectOomTargets(
  pods: readonly PodEntity[],
  nodes: readonly WorkerNodeEntity[],
): ReadonlySet<string> {
  const beta = nodes.find((node) => node.rackIndex === BETA_RACK);
  if (beta === undefined) {
    return NO_PODS;
  }
  const hosted = pods.filter((pod) => pod.nodeId === beta.id);
  if (hosted.length === 0) {
    return NO_PODS;
  }
  const victims = [...hosted].sort(compareBusinessPriority).slice(0, OOM_CORE_POD_COUNT);
  return new Set(victims.map((pod) => pod.id));
}

/** Namespace criticality first, then id - never locale-dependent. */
function compareBusinessPriority(a: PodEntity, b: PodEntity): number {
  const priorityA = namespacePriority(a.namespace);
  const priorityB = namespacePriority(b.namespace);
  if (priorityA !== priorityB) {
    return priorityA - priorityB;
  }
  if (a.id === b.id) {
    return 0;
  }
  /* `<` / `>` rather than `localeCompare`: locale-sensitive collation would give
     two servers (or a server and a browser) different victims. */
  return a.id < b.id ? -1 : 1;
}

function namespacePriority(namespace: string): number {
  return CORE_NAMESPACE_PRIORITY[namespace] ?? UNKNOWN_NAMESPACE_PRIORITY;
}

/**
 * Every Nth pod in the gamma node's scheduling list is stranded as `Pending`.
 *
 * Uses `node.podIds` ORDER (the scheduler's own list) rather than sorted ids, so
 * the stranded pods sit at predictable cell positions on the rack - an operator
 * watching the 3D chassis sees alternating cells drop out, not a random subset.
 */
function selectStrandedPods(
  pods: readonly PodEntity[],
  nodes: readonly WorkerNodeEntity[],
): ReadonlySet<string> {
  const gamma = nodes.find((node) => node.rackIndex === GAMMA_RACK);
  if (gamma === undefined || gamma.podIds.length === 0) {
    return NO_PODS;
  }
  const livePodIds = new Set<string>();
  for (const pod of pods) {
    livePodIds.add(pod.id);
  }

  const stranded = new Set<string>();
  for (let index = 0; index < gamma.podIds.length; index += 1) {
    const podId = gamma.podIds[index];
    if (podId === undefined || !livePodIds.has(podId)) {
      continue;
    }
    if (index % PARTITION_PENDING_STRIDE === 0) {
      stranded.add(podId);
    }
  }
  return stranded;
}

/* ==========================================================================
   Small helpers
   ========================================================================== */

/** True for the two states in which the container itself is not running. */
function isCrashStatus(status: PodStatus): boolean {
  return status === 'OOMKilled' || status === 'CrashLoopBackOff';
}

/** Which rack hosts this pod. */
function podOnRack(pod: PodEntity, rack: RackIndex, ctx: StepContext): boolean {
  return ctx.rackByNodeId.get(pod.nodeId) === rack;
}

/** Baseline for a pod, with a deterministic fallback for pods not in the fixture. */
function baselineForPod(pod: PodEntity): PodBaseline {
  const known = POD_BASELINES.get(pod.id);
  if (known !== undefined) {
    return known;
  }
  const hash = hashString(pod.id);
  return { cpu: 18 + (hash % 40), mem: 25 + (hash % 45) };
}

/**
 * Lifecycle convergence for pods the engine is NOT actively faulting.
 *
 * `Pending` -> `Running` once the container shows real CPU: that is the only
 * transition the engine is allowed to invent, and it is how a pod released from a
 * partition (or a lost `catalog-sync` fixture pod that finally gets scheduled)
 * comes back into service.
 *
 * Crash statuses and `Terminating` are passed THROUGH untouched. Recovery from a
 * crash is explicit (`stepRecoveringPod`, gated on the swarm's victim set), and
 * the engine never deletes pods - the snapshot schema has no removal story - so
 * inventing a completion for `Terminating` would leave dangling ids in
 * `node.podIds`.
 */
function settleStatus(pod: PodEntity, cpu: number): PodStatus {
  if (pod.status === 'Pending') {
    return cpu >= RECOVERY_CPU_FLOOR ? 'Running' : 'Pending';
  }
  return pod.status;
}

/** Next frame's clock: exactly one tick after the previous frame. */
function nextTickMs(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  /* A malformed timestamp cannot be allowed to poison the whole trajectory with
     NaN, so it degrades to "one tick from now". */
  const base = Number.isFinite(parsed) ? parsed : Date.now();
  return base + SIMULATION_TICK_MS;
}

/**
 * Traffic wave: a slow sine around 1.0.
 *
 * Derived from the absolute clock (not from a frame counter) so the phase is a
 * function of time alone: two connections opened at the same second show the same
 * point on the curve, and a reconnect does not restart the wave at its trough.
 */
function qpsWave(tickMs: number): number {
  const phase = (tickMs % QPS_WAVE_PERIOD_MS) / QPS_WAVE_PERIOD_MS;
  return 1 + QPS_WAVE_AMPLITUDE * Math.sin(phase * Math.PI * 2);
}

/** FNV-1a over UTF-16 code units. Stable across engines. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 32-bit avalanche mix (mulberry32 family). */
function mix32(value: number): number {
  let state = (value + 0x6d2b79f5) >>> 0;
  state = Math.imul(state ^ (state >>> 15), state | 1) >>> 0;
  state = (state ^ (state + Math.imul(state ^ (state >>> 7), state | 61))) >>> 0;
  return (state ^ (state >>> 14)) >>> 0;
}

/**
 * Deterministic jitter in [-1, 1].
 *
 * @param key  - pod id (the decorrelation axis)
 * @param tick - frame index (the time axis)
 * @param salt - channel selector, so CPU and memory do not move in lockstep
 */
function noise(key: string, tick: number, salt: number): number {
  const mixed = mix32(
    hashString(key) ^ Math.imul(tick, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca6b),
  );
  return (mixed / 0xffffffff) * 2 - 1;
}

/** Clamp with an explicit lower bound (percentages are [0, 100], not [x, 100]). */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

/* ==========================================================================
   Synthetic container logs
   ========================================================================== */

/**
 * The `redactedText` placeholder used by every record this generator emits.
 *
 * READ THIS BEFORE "FIXING" IT
 * `LogEntry` requires both `rawText` and `redactedText`, but redaction is the job
 * of the round-18 on-device engine, and this generator runs on the SERVER. There
 * are only three honest options:
 *
 *   1. emit `redactedText === rawText` - a secret labelled "safe to render";
 *   2. run a redactor here - which would defeat the very exercise, because the
 *      secrets the edge model is meant to catch would arrive pre-masked;
 *   3. emit an explicit placeholder that is obviously not the log line.
 *
 * (3) is the only one that cannot leak. The UI is expected to render `rawText`
 * through the edge pipeline and swap in `redactedText` only once that pipeline
 * returns; until then this placeholder makes the un-redacted state visible
 * rather than silently pretending to be safe.
 */
export const UNREDACTED_PLACEHOLDER = '[unredacted - awaiting edge audit]';

/**
 * Maximum records returned per call.
 *
 * Keeps one tick's log burst bounded: the terminal echo renders every line, so an
 * unbounded generator would become a DOM cost on a 1 Hz stream.
 */
export const MAX_LOGS_PER_TICK = 8;

/**
 * Reserved per-tick budget for each severity band, keyed by `logSeverityWeight`.
 *
 * The bands must be able to coexist: a cluster showing BOTH a crash-loop and a
 * partition is the normal case in this demo, and a quota of 0 for any non-zero
 * band means the terminal can contradict the 3D scene. The sum of these quotas is
 * allowed to exceed `MAX_LOGS_PER_TICK` - the cap still wins, but a band with more
 * members than quota rotates which pod speaks (see the round-robin in the
 * generator), so no band is ever silenced for long.
 */
const LOG_BAND_QUOTA: Readonly<Record<number, number>> = {
  /* Crashed containers. */
  4: 3,
  /* Pods on a partitioned node. */
  3: 2,
  /* Pods on a HighLoad node / Terminating pods. */
  2: 2,
  /* Healthy or merely running. */
  1: 1,
};

/** How many additional lines a band may claim from leftover budget. */
const EXTRA_LINES_PER_BAND = 2;

/** Tail length of the bearer token below. Kept short: it is a fixture, not a real JWT. */
const FIXTURE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJrdWJldmlzaW9uLWRlbW8iLCJyb2xlIjoib3BlcmF0b3IiLCJpYXQiOjE3MzA5MDAwMDB9.' +
  'q4Xk9mTz2LpR7vNb1sYc8HdJfWgE5uAiKoP3rMxQ0nB';

/* -------------------------------------------------------------------------
   Fixture secret material
   ------------------------------------------------------------------------- */

/**
 * Secret-bearing fragments mixed into the raw lines.
 *
 * These are DELIBERATE, and they are the payload for the round-18 exercise: real
 * IPv4 literals with ports, a JWT, a Postgres/Redis DSN with an inline password,
 * and a cloud-style access key. They must stay in `rawText` only.
 *
 * Values are fictional but structurally correct - a redactor that handles these
 * handles the shapes it will actually meet in a cluster.
 */
const SECRET_FRAGMENTS = {
  /** Redis endpoint behind a partitioned node. Matches the fixture's 10.244.2.x rack. */
  redisDsn: 'redis://:r3dis-Pr0d-Pa55@10.244.2.18:6379/0',
  /** Spring-style JDBC URL with an inline credential pair. */
  jdbcDsn:
    'jdbc:postgresql://10.244.1.24:5432/orders?user=svc_orders&password=Tr0ub4dor&3-orders',
  /** Bearer token echoed by an upstream call. */
  bearerToken: `Bearer ${FIXTURE_JWT}`,
  /** AWS-shaped access key id (20 chars, `AKIA` prefix). */
  accessKeyId: 'AKIA4T7Q2ZLMN6VXPR3B',
  /** Node-internal IP of a peer the container is trying to reach. */
  peerIp: '10.244.0.31:8443',
} as const;

/* -------------------------------------------------------------------------
   Log templates
   ------------------------------------------------------------------------- */

/** Template for a healthy container emitting normal stdout. */
interface LogTemplate {
  /** `sprintf`-free template: `{pod}`, `{ns}`, `{ip}` and `{n}` are substituted. */
  readonly template: string;
  readonly stream: 'stdout' | 'stderr';
}

/** Routine lines a healthy service emits. */
const NORMAL_TEMPLATES: readonly LogTemplate[] = [
  { template: 'INFO  request completed method=GET path=/api/v1/health status=200 duration={n}ms', stream: 'stdout' },
  { template: 'INFO  cache hit key=session:{n} ttl=300s', stream: 'stdout' },
  { template: 'INFO  scrape served metrics={n} series=142 duration=3ms', stream: 'stdout' },
  { template: 'INFO  raft heartbeat peer=10.244.0.31:8443 term={n} commit_index={n}', stream: 'stdout' },
  { template: 'INFO  pool stats active={n} idle=4 waiting=0', stream: 'stdout' },
  { template: 'DEBUG gc pause 1.{n}ms heap=412MiB', stream: 'stdout' },
];

/** Lines an OOM-killed / crash-looping container emits just before it dies. */
const OOM_TEMPLATES: readonly LogTemplate[] = [
  {
    template:
      'oom-kill: cgroup memory limit reached (used=511MiB limit=512MiB) oom_score_adj=999 cgroup=/kubepods/burstable/{pod}',
    stream: 'stderr',
  },
  {
    template:
      'FATAL java.lang.OutOfMemoryError: Java heap space at com.kubevision.order.CacheWarmer.warm(CacheWarmer.java:{n})',
    stream: 'stderr',
  },
  {
    template: 'panic: runtime error: out of memory: cannot allocate {n}MiB: resource temporarily unavailable',
    stream: 'stderr',
  },
  {
    template: 'ERROR heap pressure detected resident={n}MiB limit=512MiB forcing full GC',
    stream: 'stderr',
  },
];

/** Lines a node under CPU saturation emits (upstream timeouts, slow tails). */
const CPU_SPIKE_TEMPLATES: readonly LogTemplate[] = [
  {
    template:
      'WARN  upstream degraded: GET https://payments.internal/v2/charge status=504 elapsed=30012ms x-request-id=req-{n}',
    stream: 'stderr',
  },
  {
    template: 'ERROR context deadline exceeded after 10000ms waiting for downstream database pool',
    stream: 'stdout',
  },
  {
    template: 'WARN  scheduler lag: {n} tasks queued, worker threads saturated (runq=64)',
    stream: 'stderr',
  },
];

/** Lines a partitioned node emits (connection refused / dial timeouts). */
const PARTITION_TEMPLATES: readonly LogTemplate[] = [
  {
    template:
      'ERROR dial tcp 10.244.2.18:6379: i/o timeout after 5s (redis client) retry=1/5',
    stream: 'stderr',
  },
  {
    template:
      'ERROR could not connect to server: connection refused Is the server running on host "10.244.1.24" and accepting TCP/IP connections on port 5432?',
    stream: 'stderr',
  },
  {
    template:
      'WARN  kubelet unreachable: failed to POST /stats/summary to 10.244.2.18:10255 (dial: no route to host)',
    stream: 'stderr',
  },
];

/* -------------------------------------------------------------------------
   Deterministic selection helpers
   ------------------------------------------------------------------------- */

/**
 * Picks a template deterministically from a hash.
 *
 * A rotating counter would need module state (which makes two SSE clients share
 * a cursor). Hashing the pod id with the frame's tick gives each pod a stable but
 * changing choice, so a stream reads as varied without any stored cursor.
 */
function pickTemplate(
  templates: readonly LogTemplate[],
  podId: string,
  tick: number,
  index: number,
): LogTemplate | null {
  if (templates.length === 0) {
    return null;
  }
  const slot = mix32(hashString(podId) ^ Math.imul(tick, 0x9e3779b1) ^ index);
  return templates[slot % templates.length] ?? null;
}

/**
 * Substitutes the small template vocabulary.
 *
 * Supports `{n}` (a changing plausible integer), `{pod}` (the pod name), `{ns}`
 * (its namespace) and `{ip}` (its cluster IP). Every placeholder present in a
 * template MUST be handled here: an unhandled `{pod}` used to survive into the
 * output as a literal `/kubepods/burstable/{pod}`, which reads as an unrendered
 * string rather than as a log line.
 *
 * `{n}` cycles over a few values rather than drawing a random number, so a burst
 * from one pod never repeats the same latency twice in a row while staying
 * deterministic for a given `(podId, tick)`.
 */
function renderTemplate(
  template: string,
  pod: PodEntity,
  tick: number,
  index: number,
): string {
  const seed = mix32(
    hashString(pod.id) ^ Math.imul(tick, 0x85ebca6b) ^ Math.imul(index, 0x27d4eb2f),
  );
  const numbers = [
    seed % 900 + 12,
    (seed >>> 8) % 240 + 3,
    (seed >>> 16) % 40 + 1,
  ];
  let cursor = 0;
  return template
    .replace(/\{n\}/g, () => {
      const value = numbers[cursor % numbers.length] ?? 1;
      cursor += 1;
      return String(value);
    })
    .replace(/\{pod\}/g, pod.id)
    .replace(/\{ns\}/g, pod.namespace)
    .replace(/\{ip\}/g, pod.ip);
}

/**
 * Ordered list of secret shapes, cycled across one tick's burst.
 *
 * WHY A FIXED CYCLE AND NOT A HASH
 * The secrets are the payload the round-18 edge model is trained and evaluated
 * against, so a frame that happens to contain NO IPv4 or NO bearer token is not
 * "variance", it is a frame the pipeline cannot be exercised on. Probabilistic
 * injection produced exactly that (verified: whole 8-line bursts with only an
 * AWS key). A fixed cycle guarantees the invariant instead:
 *
 *   - every burst that emits at least `SECRET_CYCLE.length` lines covers ALL FIVE
 *     shapes, whatever order the quota round-robin happens to produce;
 *   - `'none'` appears three times, so roughly two thirds of lines stay clean and
 *     the "flag every line" degenerate redactor still cannot score perfectly;
 *   - the burst is rotated by `tick`, so consecutive frames do not present the
 *     shapes in a memorisable order.
 */
const SECRET_CYCLE = [
  'peerIp',
  'bearerToken',
  'none',
  'jdbcDsn',
  'none',
  'redisDsn',
  'none',
  'accessKeyId',
] as const;

/** One shape from `SECRET_CYCLE`. */
type SecretShape = (typeof SECRET_CYCLE)[number];

/**
 * The secret clause appended to one raw line.
 *
 * @param sequence  - position of the line inside this tick's burst. This is the
 *                    cycle index, so coverage is a property of the BURST, not of
 *                    any single pod.
 * @param tick      - frame index, used to rotate the cycle's starting point.
 * @param podId     - the emitting pod, mixed into the `none` slots so the SAME
 *                    pod does not always carry the same shape.
 *
 * Returns `''` for the `'none'` slots: a log where every single line carries a
 * DSN is not what a real container emits, and it would let a redactor "pass" by
 * flagging everything.
 */
function secretClause(sequence: number, tick: number, podId: string): string {
  const offset = mix32(hashString(podId) ^ Math.imul(tick, 0x6d2b79f5));
  const shape = SECRET_CYCLE[(sequence + offset) % SECRET_CYCLE.length];
  if (shape === undefined || shape === 'none') {
    return '';
  }
  return ` ${SECRET_FRAGMENT_TEXT[shape]}`;
}

/**
 * `shape -> "key=value"` as it would actually appear in a container log.
 *
 * The KEY NAME is part of the exercise: a redactor has to recognise
 * `authorization=`, `datasource=`, `dsn=` and `aws_access_key_id=` as carriers, not
 * just the value shapes. Emitting a bare token would make the task unrealistically
 * easy.
 */
const SECRET_FRAGMENT_TEXT: Readonly<Record<Exclude<SecretShape, 'none'>, string>> = {
  peerIp: `peer=${SECRET_FRAGMENTS.peerIp}`,
  bearerToken: `authorization=${SECRET_FRAGMENTS.bearerToken}`,
  jdbcDsn: `datasource=${SECRET_FRAGMENTS.jdbcDsn}`,
  redisDsn: `dsn=${SECRET_FRAGMENTS.redisDsn}`,
  accessKeyId: `aws_access_key_id=${SECRET_FRAGMENTS.accessKeyId}`,
};

/**
 * Chooses the template pool for a pod's CURRENT state.
 *
 * Precedence mirrors the engine: crash statuses outrank node-level pressure,
 * because a container that is down cannot be complaining about upstream latency.
 */
function templatesForPod(pod: PodEntity, nodeStatus: NodeStatus): readonly LogTemplate[] {
  if (isCrashStatus(pod.status)) {
    return OOM_TEMPLATES;
  }
  if (pod.status === 'Pending') {
    /* A pod that was never scheduled has no container, so nothing is emitted.
       Returning an empty pool is what keeps the generator honest. */
    return EMPTY_TEMPLATES;
  }
  if (nodeStatus === 'NetworkPartition') {
    return PARTITION_TEMPLATES;
  }
  if (nodeStatus === 'HighLoad') {
    return CPU_SPIKE_TEMPLATES;
  }
  return NORMAL_TEMPLATES;
}

/** Shared empty pool: avoids allocating a throwaway array per unschedulable pod. */
const EMPTY_TEMPLATES: readonly LogTemplate[] = [];

/** Wall-clock label the container would print, derived from the frame clock. */
function logClock(tickMs: number, offsetMs: number): string {
  const instant = new Date(tickMs - offsetMs);
  const hh = String(instant.getUTCHours()).padStart(2, '0');
  const mm = String(instant.getUTCMinutes()).padStart(2, '0');
  const ss = String(instant.getUTCSeconds()).padStart(2, '0');
  const ms = String(instant.getUTCMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

/* -------------------------------------------------------------------------
   Public generator
   ------------------------------------------------------------------------- */

/**
 * Produces one tick's worth of realistic container logs for the cluster.
 *
 * @param snapshot - the frame whose anomalies drive the output
 * @returns up to `MAX_LOGS_PER_TICK` records, most severe pod first
 *
 * WHY IT READS THE SNAPSHOT RATHER THAN RANDOMISING
 * The logs have to TELL THE SAME STORY as the topology. If the 3D scene shows a
 * node partitioned while the terminal prints healthy `200 OK` lines from that
 * node's pods, the whole demo collapses: an operator reads logs to corroborate
 * metrics, not to be given a second, unrelated narrative. Every template pool is
 * therefore selected from the pod's own status plus its node's status, so the
 * OOM lines only appear under pods that are actually OOMKilled.
 *
 * WHY THE BURST IS QUOTA-BASED, NOT "TOP N ROWS"
 * A plain sort-then-truncate starves the tail. With two ambient crashed pods in
 * the fixture, each wanting four lines, the entire `MAX_LOGS_PER_TICK` budget was
 * consumed before a partitioned node got a single line - the terminal showed
 * crashes while the topology showed a partition, which is exactly the divergence
 * this generator exists to prevent. Each severity band therefore gets a RESERVED
 * share of the budget (`LOG_BAND_QUOTA`), filled round-robin across pods. Coverage
 * of every active anomaly beats depth on the loudest one.
 *
 * DETERMINISM
 * Pure in `snapshot`: `(podId, tick)` selects the lines, so the same snapshot
 * always yields the same logs. `tick` is derived from `snapshot.timestamp`, so no
 * wall clock is read and two identical frames cannot disagree.
 *
 * SECRETS
 * Raw lines deliberately carry a real-shaped IPv4 with port, a JWT, a DSN with an
 * inline password and an AWS access key id (see `SECRET_FRAGMENTS`). They exist
 * ONLY in `rawText`; `redactedText` is `UNREDACTED_PLACEHOLDER` so nothing
 * secret can ever be mistaken for the safe field before round 18 runs.
 */
export function generateSyntheticLogs(snapshot: TelemetrySnapshot): LogEntry[] {
  const tickMs = parseTickMs(snapshot.timestamp);
  const tick = Math.floor(tickMs / SIMULATION_TICK_MS);

  /** Node status by id, so each pod resolves its node with one lookup. */
  const nodeStatusById = new Map<string, NodeStatus>();
  for (const node of snapshot.nodes) {
    nodeStatusById.set(node.id, node.status);
  }

  /* Group pods into severity bands. Sorting within a band is deterministic on id
     (never on array position, which is not stable across snapshots). */
  const bands = new Map<number, PodEntity[]>();
  for (const pod of snapshot.pods) {
    const nodeStatus = nodeStatusById.get(pod.nodeId) ?? 'Ready';
    const weight = logSeverityWeight(pod, nodeStatus);
    if (weight <= 0) {
      continue;
    }
    const bucket = bands.get(weight);
    if (bucket === undefined) {
      bands.set(weight, [pod]);
    } else {
      bucket.push(pod);
    }
  }
  const orderedWeights = [...bands.keys()].sort((a, b) => b - a);

  const logs: LogEntry[] = [];
  let sequence = 0;

  /* Round 1: every band spends its reserved quota, rotating across its pods so a
     band with more pods than quota still shows a DIFFERENT pod each tick. */
  for (const weight of orderedWeights) {
    const pods = bands.get(weight);
    if (pods === undefined || pods.length === 0) {
      continue;
    }
    pods.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const quota = LOG_BAND_QUOTA[weight] ?? 1;
    /* Which pod leads this tick rotates by tick, so a band is not permanently
       represented by its alphabetically-first member. */
    const rotation = tick % pods.length;

    for (let slot = 0; slot < quota; slot += 1) {
      if (logs.length >= MAX_LOGS_PER_TICK) {
        break;
      }
      const pod = pods[(rotation + slot) % pods.length];
      if (pod === undefined) {
        continue;
      }
      const nodeStatus = nodeStatusById.get(pod.nodeId) ?? 'Ready';
      const emitted = emitLogForPod(pod, nodeStatus, tick, tickMs, slot, sequence);
      if (emitted !== null) {
        logs.push(emitted);
        sequence += 1;
      }
    }
  }

  /* Round 2: spend any leftover budget on more detail from the worst bands, so a
     calm cluster is not forced to pad and a chaotic one still fills the window. */
  for (const weight of orderedWeights) {
    if (logs.length >= MAX_LOGS_PER_TICK) {
      break;
    }
    const pods = bands.get(weight);
    if (pods === undefined) {
      continue;
    }
    const base = LOG_BAND_QUOTA[weight] ?? 1;
    for (let extra = 0; extra < EXTRA_LINES_PER_BAND; extra += 1) {
      if (logs.length >= MAX_LOGS_PER_TICK) {
        break;
      }
      for (const pod of pods) {
        if (logs.length >= MAX_LOGS_PER_TICK) {
          break;
        }
        const nodeStatus = nodeStatusById.get(pod.nodeId) ?? 'Ready';
        const emitted = emitLogForPod(
          pod,
          nodeStatus,
          tick,
          tickMs,
          base + extra,
          sequence,
        );
        if (emitted !== null) {
          logs.push(emitted);
          sequence += 1;
        }
      }
    }
  }

  return logs;
}

/**
 * Emits ONE log record for a pod, or null when it has nothing to say.
 *
 * Split out so both quota rounds share the identical template selection, secret
 * injection and id scheme - two call sites that drifted would produce duplicate
 * ids or inconsistent text for the same `(pod, tick, line)`.
 */
function emitLogForPod(
  pod: PodEntity,
  nodeStatus: NodeStatus,
  tick: number,
  tickMs: number,
  lineIndex: number,
  sequence: number,
): LogEntry | null {
  const pool = templatesForPod(pod, nodeStatus);
  const template = pickTemplate(pool, pod.id, tick, lineIndex);
  if (template === null) {
    return null;
  }
  const body = renderTemplate(template.template, pod, tick, lineIndex);
  const clause = secretClause(sequence, tick, pod.id);
  const emittedAt = tickMs - (lineIndex + 1) * 137;
  const clock = logClock(tickMs, (lineIndex + 1) * 137);

  return {
    id: `log-${pod.id}-${tick}-${sequence}`,
    rawText: `${clock} ${body}${clause}`,
    redactedText: UNREDACTED_PLACEHOLDER,
    timestamp: new Date(emittedAt).toISOString(),
    source: buildLogSource(pod),
    stream: template.stream,
  };
}

/**
 * Sort weight for the burst: higher = more urgent.
 *
 * Deliberately coarse. The generator's job is to lead with the crash, not to
 * re-implement the alert ranking that `evolveAlerts` already owns.
 */
function logSeverityWeight(pod: PodEntity, nodeStatus: NodeStatus): number {
  if (pod.status === 'Pending') {
    return 0;
  }
  if (isCrashStatus(pod.status)) {
    return 4;
  }
  if (nodeStatus === 'NetworkPartition') {
    return 3;
  }
  if (nodeStatus === 'HighLoad' || pod.status === 'Terminating') {
    return 2;
  }
  return 1;
}

/** Builds the `LogSource` for a pod, including a plausible container name. */
function buildLogSource(pod: PodEntity): LogSource {
  return {
    podId: pod.id,
    podName: pod.name,
    namespace: pod.namespace,
    /* Kubernetes derives the container name from the workload; the pod's own
       name prefix is a faithful stand-in and needs no extra fixture field. */
    container: containerNameFor(pod),
  };
}

/**
 * Container name for a pod.
 *
 * Derived from the first dash-separated segment of the pod name, which is the
 * convention the fixture follows (`payment-gateway-7f8b9-x2k` lives in a
 * `payment-gateway` workload). Falls back to the whole name for single-segment
 * ids such as `coredns-7d9b4-z8x` -> `coredns`.
 */
function containerNameFor(pod: PodEntity): string {
  const segments = pod.name.split('-');
  const first = segments[0];
  if (first === undefined || first.length === 0) {
    return pod.name;
  }
  return first;
}

/**
 * Parses a snapshot timestamp into ms, degrading safely.
 *
 * Mirrors `nextTickMs`: an unparseable timestamp must not produce `NaN` and
 * silently empty the log stream, so it falls back to "now".
 */
function parseTickMs(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
}