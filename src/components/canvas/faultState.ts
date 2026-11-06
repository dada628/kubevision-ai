'use client';

/**
 * KubeVision AI - one definition of "is this rack in trouble?".
 *
 * WHY THIS IS SHARED
 * Two independent visual effects light up on a fault: the warning ripple on the
 * floor (`ErrorRippleRing`) and the orange-red alert cable with its stuttering
 * packet flow (`NetworkStream3D`). If each kept its own condition, a chaos
 * scenario could light the ring while the cable stayed calm - which reads as a
 * rendering bug, not as a fault. One function means they can only ever disagree
 * about the WEIGHT of a fault, never about its existence.
 *
 * WHAT COUNTS AS A FAULT
 * - `NetworkPartition`: the kubelet is unreachable, so the control plane sees no
 *   traffic at all. This is the `NET_PACKET_LOSS` chaos signature.
 * - A hosted pod in `CrashLoopBackOff` or `OOMKilled`: the node may still be
 *   healthy, but a container on it has failed and needs attention.
 *
 * WHAT DOES NOT
 * - `HighLoad`: saturation is a capacity signal, not a failure. Painting it red
 *   would cry wolf on every load test.
 * - `Terminating`: normal churn during a rollout.
 */

import { getSnapshot } from '@/store/useTelemetryRef';
import type { RackIndex } from '@/types/cluster';

/**
 * Why a rack is faulted.
 *
 * The KIND matters to the callers: a partition is a total loss of traffic (the
 * cable should nearly die), whereas crashed pods are a partial failure (traffic
 * continues, so the cable warns without flatlining).
 */
export type RackFaultKind = 'none' | 'partition' | 'pod';

/**
 * Classifies the rack's current health.
 *
 * Allocation-free: it walks the live transient snapshot and returns a string
 * literal, so it is safe to call from `useFrame` on every cable every frame.
 */
export function readRackFault(rackIndex: RackIndex): RackFaultKind {
  const snapshot = getSnapshot();

  let nodeId: string | null = null;
  let partitioned = false;

  for (const node of snapshot.nodes) {
    if (node.rackIndex !== rackIndex) {
      continue;
    }
    nodeId = node.id;
    partitioned = node.status === 'NetworkPartition';
    break;
  }

  if (nodeId === null) {
    return 'none';
  }
  if (partitioned) {
    return 'partition';
  }

  for (const pod of snapshot.pods) {
    if (pod.nodeId !== nodeId) {
      continue;
    }
    if (pod.status === 'CrashLoopBackOff' || pod.status === 'OOMKilled') {
      return 'pod';
    }
  }

  return 'none';
}

/** Convenience predicate for callers that only need a boolean. */
export function isRackFaulted(rackIndex: RackIndex): boolean {
  return readRackFault(rackIndex) !== 'none';
}