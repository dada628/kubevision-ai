/**
 * KubeVision AI - deterministic topology layout math.
 *
 * WHY THIS FILE EXISTS
 * The camera rig, the three worker racks and the master control node must agree
 * on ONE set of world coordinates. If the layout lived inside a mesh component,
 * the camera would focus on a point the racks do not occupy and every close-up
 * would drift on each refactor.
 *
 * CONTRACT
 * - Pure math. No React, no store access, no side effects.
 * - Every function writes into a caller-provided `Vector3` (`out*` arguments) so
 *   the render loop can reuse preallocated scratch objects and never triggers a
 *   GC pause inside `useFrame` (`.cursorrules` rule 3).
 * - Coordinates are deterministic functions of `rackIndex` and `slotIndex`
 *   only. No clocks, no randomness: the server render and the client render
 *   cannot disagree, and a rack keeps its angle across chaos / heal ticks.
 *
 * WORLD LAYOUT - polar, not linear
 * The cluster is a ring, not a row: the master sits at the origin and the three
 * worker racks stand on a circle of radius `RACK_ORBIT_RADIUS`, each rotated so
 * its front face (and its neon rails) look at the master.
 *
 *            rack 1 (150°)
 *                 \
 *        rack 0 --- M --- rack 2   <- M = master at the origin
 *          (30°)
 *
 * WHY THE BASE ANGLE IS 30° AND NOT 90°
 * At 90° one rack would stand directly between the overview camera (which looks
 * down the +Z axis) and the master, hiding the control plane behind a chassis.
 * Offsetting the ring by 30° splits the racks to front-left / front-right, which
 * leaves a clear sight line to the master and reads as a symmetrical tripod.
 *
 * WORLD AXES
 * - +X : right, +Y : up (the ground plane sits at y = 0), +Z : toward the camera
 */

import { Vector3 } from 'three';
import type { RackIndex } from '@/types/cluster';

/* ==========================================================================
   Master control node
   ========================================================================== */

/** World Y of the master core centre. The holographic ring lands on y = 0. */
export const MASTER_POSITION_Y = 2.5;

/** Full world position of the master, for camera framing and link beams. */
export const MASTER_POSITION = {
  x: 0,
  y: MASTER_POSITION_Y,
  z: 0,
} as const;

/* ==========================================================================
   Rack orbit
   ========================================================================== */

/** Radius of the circle the three worker racks stand on, in world units. */
export const RACK_ORBIT_RADIUS = 9.5;

/** Angular offset of rack 0, in radians. See the layout note above. */
export const RACK_ANGLE_BASE = Math.PI / 6;

/** Angular distance between two adjacent racks: the ring is split into thirds. */
export const RACK_ANGLE_STEP = (Math.PI * 2) / 3;

/* ==========================================================================
   Rack chassis dimensions
   ========================================================================== */

/** Rack chassis width (local X). */
export const RACK_WIDTH = 3.1;

/** Rack chassis height, measured from the ground plane. */
export const RACK_HEIGHT = 5.2;

/** Rack chassis depth (local Z; the front face is +Z in rack-local space). */
export const RACK_DEPTH = 1.9;

/** Number of horizontal server tray shelves inside one rack. */
export const RACK_TRAY_COUNT = 4;

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

/** Z of the pod mounting plane, in RACK-LOCAL space. */
export const POD_SLOT_Z = RACK_DEPTH / 2 + 0.14;

/* ==========================================================================
   Derived helpers
   ========================================================================== */

/**
 * Angle of a rack on the orbit circle, in radians.
 *
 * @param rackIndex - 0, 1 or 2
 */
export function rackAngle(rackIndex: RackIndex): number {
  return RACK_ANGLE_BASE + rackIndex * RACK_ANGLE_STEP;
}

/**
 * Yaw that makes a rack's local +Z face the master at the origin.
 *
 * DERIVATION
 * For `rotation.y = yaw`, a local +Z vector maps to world `(sin yaw, 0, cos yaw)`.
 * The rack stands at `(R cos a, 0, R sin a)`, so the direction it must look is
 * `-(cos a, 0, sin a)`. Solving `(sin yaw, cos yaw) = (-cos a, -sin a)` gives
 * `yaw = atan2(-cos a, -sin a)`.
 *
 * Uses `Math.atan2`, not `a + PI`: the two agree numerically but `atan2` keeps
 * the result in `(-PI, PI]`, which keeps the value readable in devtools.
 */
export function rackFacingYaw(rackIndex: RackIndex): number {
  const angle = rackAngle(rackIndex);
  return Math.atan2(-Math.cos(angle), -Math.sin(angle));
}

/* ==========================================================================
   Mesh placement helpers
   ========================================================================== */

/** World position of a rack's ground centre into `out`. */
export function writeRackOrigin(
  rackIndex: RackIndex,
  out: Vector3,
): Vector3 {
  const angle = rackAngle(rackIndex);
  return out.set(
    Math.cos(angle) * RACK_ORBIT_RADIUS,
    0,
    Math.sin(angle) * RACK_ORBIT_RADIUS,
  );
}

/**
 * World position of one pod slot (the pod cube's centre) into `out`.
 *
 * The slot is laid out in RACK-LOCAL space (columns along local X, the pod plane
 * at local +Z) and then rotated by the rack's facing yaw and translated to the
 * rack origin. Without this the pods of a rotated rack would float in a plane
 * parallel to the world axes instead of against the chassis front.
 */
export function writePodSlotPosition(
  rackIndex: RackIndex,
  slotIndex: number,
  out: Vector3,
): Vector3 {
  const slot =
    !Number.isFinite(slotIndex) || slotIndex < 0
      ? 0
      : Math.min(Math.trunc(slotIndex), POD_SLOT_COUNT - 1);
  const column = slot % POD_SLOT_COLUMNS;
  const row = Math.floor(slot / POD_SLOT_COLUMNS);

  const localX = (column - (POD_SLOT_COLUMNS - 1) / 2) * POD_SLOT_GAP_X;
  const localY = POD_SLOT_BASE_Y + row * POD_SLOT_GAP_Y;
  const localZ = POD_SLOT_Z;

  const angle = rackAngle(rackIndex);
  const yaw = rackFacingYaw(rackIndex);
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);

  return out.set(
    Math.cos(angle) * RACK_ORBIT_RADIUS + localX * cosYaw + localZ * sinYaw,
    localY,
    Math.sin(angle) * RACK_ORBIT_RADIUS - localX * sinYaw + localZ * cosYaw,
  );
}

/** World position of the master core into `out`. */
export function writeMasterPosition(out: Vector3): Vector3 {
  return out.set(MASTER_POSITION.x, MASTER_POSITION.y, MASTER_POSITION.z);
}

/* ==========================================================================
   Camera focus poses
   ========================================================================== */

/**
 * Overview pose: the "reset view" framing, matching the Canvas default camera.
 *
 * The offset from target is `(0, 11.8, 22)` -> radius 24.97, polar angle 1.084
 * rad, comfortably inside the rig's `[0.2, PI/2 - 0.05]` clamp and below
 * `maxDistance = 35`. The target sits slightly above the master core so the ring
 * plus the three racks are all inside the frustum.
 */
export function writeOverviewPose(
  outPosition: Vector3,
  outTarget: Vector3,
): void {
  outPosition.set(0, 14, 22);
  outTarget.set(0, 2.6, 0);
}

/**
 * Top-down ("俯视拓扑") framing: a steep look down the +Y axis onto the ring.
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
 * The 5.2-unit forward offset gives the floor perspective and keeps the rack
 * faces readable, instead of collapsing them into thin top edges.
 */
export function writeTopPose(
  outPosition: Vector3,
  outTarget: Vector3,
): void {
  outPosition.set(0, 25.4, 5.2);
  outTarget.set(0, 2.6, 0);
}

/**
 * Worker rack close-up.
 *
 * The camera steps OUTWARD along the rack's own radius and slightly up, so the
 * approach is always a frontal dolly regardless of which third of the ring the
 * rack occupies. Framing a rotated rack from a fixed +Z offset would show it at
 * an angle from the sides.
 */
export function writeRackFocusPose(
  rackIndex: RackIndex,
  outPosition: Vector3,
  outTarget: Vector3,
): void {
  const angle = rackAngle(rackIndex);
  const focusY = RACK_HEIGHT * 0.52;
  const originX = Math.cos(angle) * RACK_ORBIT_RADIUS;
  const originZ = Math.sin(angle) * RACK_ORBIT_RADIUS;

  outTarget.set(originX, focusY, originZ);
  /* 6.2 units out from the rack face, 1.6 up: the full chassis plus its plaque
     stay in frame at fov 45. */
  outPosition.set(
    originX + Math.cos(angle) * 6.2,
    focusY + 1.6,
    originZ + Math.sin(angle) * 6.2,
  );
}

/**
 * Single pod close-up: the pod's slot centre plus a short forward offset along
 * the rack's facing direction, so the camera never ends up inside a chassis.
 */
export function writePodFocusPose(
  rackIndex: RackIndex,
  slotIndex: number,
  outPosition: Vector3,
  outTarget: Vector3,
): void {
  writePodSlotPosition(rackIndex, slotIndex, outTarget);
  const angle = rackAngle(rackIndex);
  outPosition.set(
    outTarget.x + Math.cos(angle) * 3.4,
    outTarget.y + 0.85,
    outTarget.z + Math.sin(angle) * 3.4,
  );
}

/** Master control plane close-up. */
export function writeMasterFocusPose(
  outPosition: Vector3,
  outTarget: Vector3,
): void {
  outTarget.set(MASTER_POSITION.x, MASTER_POSITION.y, MASTER_POSITION.z);
  /* 8 units back on +Z and 1.4 up: far enough that the outer wireframe, the
     holographic ring and the nameplate all fit, close enough to read the core. */
  outPosition.set(
    MASTER_POSITION.x,
    MASTER_POSITION.y + 1.4,
    MASTER_POSITION.z + 8,
  );
}