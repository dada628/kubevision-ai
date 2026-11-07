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
 * - `HighLoad` WHEN it is a drill: a chaos experiment deliberately pinning a
 *   node's CPU is a fault an operator must be able to SEE in the 3D scene, and
 *   that is what `NODE_CPU_SPIKE` produces. Distinguished via the active chaos
 *   below, because the steady-state baseline also seeds one node as `HighLoad`
 *   and that one genuinely is capacity, not failure.
 *
 * WHAT DOES NOT
 * - `HighLoad` in steady state: saturation from ordinary traffic is a capacity
 *   signal, not a failure. Painting it red would cry wolf on every load test, and
 *   the fixture ships `worker-beta` as `HighLoad` from the very first frame -
 *   alarming on that would leave a fault ring burning permanently at rest.
 * - `Terminating`: normal churn during a rollout.
 */

import { getSnapshot } from '@/store/useTelemetryRef';
import { CHAOS_TARGET_RACK } from '@/types/store';
import type { RackIndex } from '@/types/cluster';
import { useClusterStore } from '@/store/useClusterStore';

/**
 * Why a rack is faulted.
 *
 * The KIND matters to the callers: a partition is a total loss of traffic (the
 * cable should nearly die), whereas crashed pods are a partial failure (traffic
 * continues, so the cable warns without flatlining).
 *
 * `saturation` is the node-level capacity kind: the link is fine and no container
 * has died, but the chassis is running out of compute. Reported separately so the
 * cable can warn without pretending the network is broken.
 */
export type RackFaultKind = 'none' | 'partition' | 'pod' | 'saturation';

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
  let highLoad = false;

  for (const node of snapshot.nodes) {
    if (node.rackIndex !== rackIndex) {
      continue;
    }
    nodeId = node.id;
    partitioned = node.status === 'NetworkPartition';
    highLoad = node.status === 'HighLoad';
    break;
  }

  if (nodeId === null) {
    return 'none';
  }
  if (partitioned) {
    return 'partition';
  }

  /* A saturated node that a DRILL put there is checked BEFORE the pod scan.
     Ordering is the whole point: the fixture ships `worker-alpha` with a crashed
     container (`cart-service`), so scanning pods first would let that ambient
     fault mask the `NODE_CPU_SPIKE` drill the operator just fired - the ring
     would keep showing "a pod died" while the node burns, and the drill would
     have no visible signature at all.

     `NODE_CPU_SPIKE` targets exactly one rack, so the test is "is this the rack
     the active scenario owns", which `CHAOS_TARGET_RACK` already answers - no
     second mapping to maintain. The transient CPU values are deliberately NOT
     used: they are eased, so the ring would fade in and out frame by frame. */
  const driftScenario = useClusterStore.getState().activeChaos;
  const drillRack = CHAOS_TARGET_RACK[driftScenario];
  if (
    highLoad &&
    driftScenario === 'NODE_CPU_SPIKE' &&
    drillRack !== null &&
    drillRack === rackIndex
  ) {
    return 'saturation';
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