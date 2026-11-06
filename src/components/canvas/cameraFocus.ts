/**
 * KubeVision AI - selection -> camera pose resolution.
 *
 * The camera rig needs ONE answer to "where should the camera fly for the
 * currently selected entity?". That answer depends on the live snapshot (a pod's
 * rack and slot are scheduling facts, not UI state), so it cannot be derived
 * from the Zustand slice alone.
 *
 * CONTRACT
 * - Pure: no React, no store import, no three object allocation. The caller
 *   passes the snapshot and two PREALLOCATED `Vector3`s that receive the pose.
 * - Never throws: an id that no longer resolves (a recovered pod that was
 *   rescheduled away) degrades to the overview pose instead of leaving the
 *   camera stranded on a stale close-up.
 */

import type { Vector3 } from 'three';
import type { TelemetrySnapshot } from '@/types/cluster';
import type { EntityType } from '@/types/store';
import {
  writeMasterFocusPose,
  writeOverviewPose,
  writePodFocusPose,
  writeRackFocusPose,
} from './topologyLayout';

/**
 * Infers the entity kind for an id, mirroring `useClusterStore.inferEntityType`.
 *
 * The store normally hands both fields to the canvas, but a programmatic
 * selection (URL param, AI tool call) may only carry the id, so the rig must be
 * able to resolve it on its own.
 */
export function inferEntityTypeFromSnapshot(
  targetId: string,
  snapshot: TelemetrySnapshot,
): EntityType | null {
  if (snapshot.master.id === targetId) {
    return 'master';
  }
  for (const node of snapshot.nodes) {
    if (node.id === targetId) {
      return 'node';
    }
  }
  for (const pod of snapshot.pods) {
    if (pod.id === targetId) {
      return 'pod';
    }
  }
  return null;
}

/**
 * Writes the world pose the camera should ease toward.
 *
 * @param targetId   - selected `PodEntity.id` / `WorkerNodeEntity.id` / master id
 * @param targetType - selection kind from the store, or null to infer it
 * @param snapshot   - the live topology (rack + slot lookup)
 * @param outPosition - receives the desired camera position
 * @param outTarget   - receives the desired orbit target
 */
export function resolveFocusPose(
  targetId: string | null,
  targetType: EntityType | null,
  snapshot: TelemetrySnapshot,
  outPosition: Vector3,
  outTarget: Vector3,
): void {
  if (targetId === null) {
    writeOverviewPose(outPosition, outTarget);
    return;
  }

  const resolvedType =
    targetType ?? inferEntityTypeFromSnapshot(targetId, snapshot);

  if (resolvedType === 'master') {
    /* The caller already TOLD us this id is the control plane, so a strict
       `master.id === targetId` check would strand the camera on the overview for
       any alias (`'master-control-plane'`, a bookmark, a model tool payload).
       The master is a singleton, so the type alone is sufficient proof. */
    writeMasterFocusPose(outPosition, outTarget);
    return;
  }

  if (resolvedType === 'node') {
    let rackIndex: 0 | 1 | 2 | null = null;
    for (const node of snapshot.nodes) {
      if (node.id === targetId) {
        rackIndex = node.rackIndex;
        break;
      }
    }
    if (rackIndex === null) {
      writeOverviewPose(outPosition, outTarget);
      return;
    }
    writeRackFocusPose(rackIndex, outPosition, outTarget);
    return;
  }

  if (resolvedType === 'pod') {
    for (const pod of snapshot.pods) {
      if (pod.id !== targetId) {
        continue;
      }
      /* The pod's rack is a fact about its owning node; the slot index is the
         pod's position inside that node's scheduling list, which is the same
         order the instanced pod field will use. Both are stable across ticks. */
      for (const node of snapshot.nodes) {
        if (node.id !== pod.nodeId) {
          continue;
        }
        const slotIndex = node.podIds.indexOf(pod.id);
        writePodFocusPose(
          node.rackIndex,
          slotIndex < 0 ? 0 : slotIndex,
          outPosition,
          outTarget,
        );
        return;
      }
      break;
    }
  }

  writeOverviewPose(outPosition, outTarget);
}