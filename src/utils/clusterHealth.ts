/**
 * KubeVision AI - deterministic cluster health / throughput maths.
 *
 * WHY THIS MODULE IS SEPARATE FROM THE TELEMETRY STORE
 * `useTelemetryRef.ts` is a `'use client'` module: it owns a mutable singleton
 * pool that only makes sense inside the browser. The synthetic engine
 * (`src/utils/syntheticEngine.ts`) runs on the SERVER, inside the SSE route, and
 * it must answer the same two questions the HUD answers - "how healthy is this
 * cluster?" and "how much traffic is it serving?" - without dragging the client
 * pool into an RSC module graph.
 *
 * Both sides therefore import the maths from HERE. One definition of the penalty
 * table means the score a server frame advertises is bit-identical to the score
 * the browser would recompute from the same snapshot; two copies would drift the
 * moment a status penalty was tuned in one place.
 *
 * PURITY CONTRACT
 * No React, no three, no clocks, no randomness. Every function is a pure
 * function of its arguments, so the same snapshot always yields the same score on
 * the server render, in the browser, and in a replay.
 */

import { TELEMETRY_HISTORY_LENGTH, clampPercentage } from '@/types/cluster';
import type {
  NodeStatus,
  PodEntity,
  PodStatus,
  WorkerNodeEntity,
} from '@/types/cluster';

/* ==========================================================================
   Penalty tables
   ========================================================================== */

/** Penalty each pod status contributes to the composite health score. */
const POD_HEALTH_PENALTY: Record<PodStatus, number> = {
  Running: 0,
  Pending: 4,
  Terminating: 3,
  CrashLoopBackOff: 8,
  OOMKilled: 7,
};

/** Penalty each node status contributes to the composite health score. */
const NODE_HEALTH_PENALTY: Record<NodeStatus, number> = {
  Ready: 0,
  HighLoad: 5,
  NetworkPartition: 10,
};

/* ==========================================================================
   Scores
   ========================================================================== */

/**
 * Deterministic composite health model.
 *
 * 100 - (sum of pod penalties) - (sum of node penalties), clamped to [0, 100].
 * Deliberately simple and deterministic: the same snapshot always yields the
 * same score, on the server and in the browser.
 */
export function computeHealthScore(
  pods: readonly PodEntity[],
  nodes: readonly WorkerNodeEntity[],
): number {
  let score = 100;
  for (const pod of pods) {
    score -= POD_HEALTH_PENALTY[pod.status];
  }
  for (const node of nodes) {
    score -= NODE_HEALTH_PENALTY[node.status];
  }
  return clampPercentage(score);
}

/**
 * Deterministic QPS model for the demo: healthier clusters serve more traffic.
 * Monotonically decreasing in damage, so the HUD never shows "worse health but
 * more traffic", which would look broken.
 */
export function computeTotalQps(healthScore: number): number {
  const normalized = clampPercentage(healthScore) / 100;
  return Math.round(28000 * normalized ** 1.35);
}

/* ==========================================================================
   Ring buffer
   ========================================================================== */

/**
 * Append a sample to a fixed-length ring buffer, oldest first. In place.
 *
 * In place by contract: the caller already owns the array (a pod's
 * `cpuHistory` / `memHistory`), and returning a new array once per pod per
 * second would allocate on a path that must stay allocation-free.
 */
export function pushSample(history: number[], value: number): void {
  history.push(clampPercentage(value));
  while (history.length > TELEMETRY_HISTORY_LENGTH) {
    history.shift();
  }
}