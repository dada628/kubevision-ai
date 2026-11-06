/**
 * KubeVision AI - deterministic topology layout math.
 *
 * WHY THIS FILE EXISTS
 * The camera rig (and, in the next milestone, the instanced pod field, the rack
 * chassis and the link beams) must agree on ONE set of world coordinates. If the
 * layout lived inside a mesh component, the camera would focus on a point the
 * pods do not occupy and the close-up would drift on every refactor.
 *
 * CONTRACT
 * - Pure math. No React, no store access, no side effects.
 * - Every function writes into a caller-provided `Vector3` (`out*` arguments) so
 *   the render loop can reuse preallocated scratch objects and never triggers a
 *   GC pause inside `useFrame` (`.cursorrules` rule 3).
 * - Coordinates are deterministic functions of `rackIndex` and `slotIndex`
 *   only. No clocks, no randomness: the server render and the client render
 *   cannot disagree, and a pod keeps its slot across chaos / heal ticks.
 *
 * WORLD AXES
 * - +X : rack order, left (alpha, rack 0) -> right (gamma, rack 2)
 * - +Y : up, the ground plane sits at y = 0
 * - +Z : toward the viewer; pods are mounted on each rack's front face
 */

import { Vector3 } from 'three';
import type { RackIndex } from '@/types/cluster';

/* ==========================================================================
   Rack chassis dimensions
   ========================================================================== */

/** Horizontal distance between two adjacent rack centres, in world units. */
export const RACK_SPACING_X = 6.4;

/** Rack chassis width. */
export const RACK_WIDTH = 2.7;

/** Rack chassis height, measured from the ground plane. */
export const RACK_HEIGHT = 5.2;

/** Rack chassis depth. */
export const RACK_DEPTH = 1.9;

/** Y position of the control-plane beacon (the master hovers above the racks). */
export const MASTER_HEIGHT = 7.4;

/* ==========================================================================
   Pod slot dimensions
   ========================================================================== */

/** Pod slots per rack column. */
export const POD_SLOT_COLUMNS = 3;

/** Pod slots per rack row. */
export const POD_SLOT_ROWS = 4;

/** Total pod slots inside one rack (3 x 4 = 12; the busiest rack hosts 9). */
export const POD_SLOT_COUNT = POD_SLOT_COLUMNS * POD_SLOT_ROWS;

/** Horizontal gap between two pod slot centres. */
export const POD_SLOT_GAP_X = 0.78;

/** Vertical gap between two pod slot centres. */
export const POD_SLOT_GAP_Y = 1.02;

/** Y of the lowest pod row. */
export const POD_SLOT_BASE_Y = 1.15;

/** Z of the pod mounting plane (just in front of the rack's front face). */
export const POD_SLOT_Z = RACK_DEPTH / 2 + 0.14;

/* ==========================================================================
   Derived helpers
   ========================================================================== */

/**
 * Centre X of a rack. The three racks straddle the origin:
 * rack 0 -> -6.4, rack 1 -> 0, rack 2 -> +6.4.
 */
export function rackCenterX(rackIndex: RackIndex): number {
  return (rackIndex - 1) * RACK_SPACING_X;
}

/** Clamps an arbitrary slot index into `[0, POD_SLOT_COUNT - 1]`. */
function clampSlot(slotIndex: number): number {
  if (!Number.isFinite(slotIndex)) {
    return 0;
  }
  const truncated = Math.trunc(slotIndex);
  if (truncated < 0) {
    return 0;
  }
  if (truncated > POD_SLOT_COUNT - 1) {
    return POD_SLOT_COUNT - 1;
  }
  return truncated;
}

/* ==========================================================================
   Mesh placement helpers
   ========================================================================== */

/** Rack origin (bottom centre of the chassis) into `out`. */
export function writeRackOrigin(
  rackIndex: RackIndex,
  out: Vector3,
): Vector3 {
  return out.set(rackCenterX(rackIndex), 0, 0);
}

/** World position of one pod slot (the pod cube's centre) into `out`. */
export function writePodSlotPosition(
  rackIndex: RackIndex,
  slotIndex: number,
  out: Vector3,
): Vector3 {
  const slot = clampSlot(slotIndex);
  const column = slot % POD_SLOT_COLUMNS;
  const row = Math.floor(slot / POD_SLOT_COLUMNS);
  const x =
    rackCenterX(rackIndex) +
    (column - (POD_SLOT_COLUMNS - 1) / 2) * POD_SLOT_GAP_X;
  const y = POD_SLOT_BASE_Y + row * POD_SLOT_GAP_Y;
  return out.set(x, y, POD_SLOT_Z);
}

/** World position of the control-plane beacon into `out`. */
export function writeMasterPosition(out: Vector3): Vector3 {
  return out.set(0, MASTER_HEIGHT, 0);
}

/* ==========================================================================
   Camera focus poses
   ========================================================================== */

/**
 * Overview pose: the "reset view" framing, matching the Canvas default camera.
 *
 * The offset from target is `(0, 11.6, 22)` -> radius 24.9, polar angle
 * `acos(11.6 / 24.9) = 1.086 rad`, comfortably inside the rig's
 * `[0.2, PI/2 - 0.05]` clamp and below `maxDistance = 35`.
 */
export function writeOverviewPose(
  outPosition: Vector3,
  outTarget: Vector3,
): void {
  outPosition.set(0, 14, 22);
  outTarget.set(0, 2.4, 0);
}

/**
 * Top-down ("俯视拓扑") framing: a steep look down the +Y axis onto the grid.
 *
 * GEOMETRY CONTRACT - do not flatten this to a true 90° nadir
 * `OrbitControls.update()` clamps the camera's polar angle into
 * `[minPolarAngle, maxPolarAngle]` on EVERY frame after the controls run
 * (`useFrame` priority -1). A pose outside that band is therefore not reachable:
 * the rig would ease toward it while the controls snap back, and the two would
 * fight, producing visible vibration for as long as the operator stays in the
 * preset. This pose is deliberately pitched 0.235 rad off vertical, which sits
 * inside the rig's `minPolarAngle = 0.2` with margin, and at radius 23.75
 * (well under `maxDistance = 35`).
 *
 * The 5.5-unit forward offset gives the grid its perspective and keeps the rack
 * faces readable, instead of collapsing them into thin top edges.
 */
export function writeTopPose(
  outPosition: Vector3,
  outTarget: Vector3,
): void {
  outPosition.set(0, 25.4, 5.2);
  outTarget.set(0, 2.4, 0);
}

/**
 * Worker rack close-up.
 *
 * Side racks pull the camera slightly toward the centreline (`x * 0.92`) so the
 * approach reads as a diagonal dolly instead of a flat head-on push, while the
 * middle rack keeps a perfectly frontal framing.
 */
export function writeRackFocusPose(
  rackIndex: RackIndex,
  outPosition: Vector3,
  outTarget: Vector3,
): void {
  const x = rackCenterX(rackIndex);
  const focusY = RACK_HEIGHT * 0.52;
  outTarget.set(x, focusY, 0);
  outPosition.set(x * 0.92, focusY + 1.9, 8.6);
}

/**
 * Single pod close-up: the pod's slot centre plus a short forward offset.
 * Always in front of the rack face, so the camera never ends up inside a chassis.
 */
export function writePodFocusPose(
  rackIndex: RackIndex,
  slotIndex: number,
  outPosition: Vector3,
  outTarget: Vector3,
): void {
  writePodSlotPosition(rackIndex, slotIndex, outTarget);
  const lateralPull =
    rackIndex === 0 ? 0.7 : rackIndex === 2 ? -0.7 : 0;
  outPosition.set(
    outTarget.x + lateralPull,
    outTarget.y + 0.85,
    outTarget.z + 3.4,
  );
}

/** Control-plane beacon close-up. */
export function writeMasterFocusPose(
  outPosition: Vector3,
  outTarget: Vector3,
): void {
  outTarget.set(0, MASTER_HEIGHT, 0);
  outPosition.set(0, MASTER_HEIGHT + 1.6, 12.4);
}