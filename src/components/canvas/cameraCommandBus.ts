/**
 * KubeVision AI - camera command bus + control snapshot.
 *
 * WHY A MODULE-LEVEL BUS
 * The camera overlay is plain HTML rendered by `TopologyViewport`, while the
 * single `OrbitControls` instance only exists inside the R3F tree. They cannot
 * share a React context (the overlay is the DOM parent, the canvas is a lazily
 * loaded child), and pushing a camera command through `useClusterStore` would
 * make a viewport concern look like cluster state.
 *
 * TWO CHANNELS, ON PURPOSE
 * 1. COMMANDS (`onCameraPreset`, `onAutoRotateChange`) are imperative: they tell
 *    the rig to start an eased flight or to flip auto-rotation. They are NOT
 *    React state - a flight runs for ~1 s and must never re-render the tree.
 * 2. SNAPSHOT (`subscribeCameraControls`) is the observable mirror the toolbar
 *    renders from: which preset is active and whether auto-rotation is on. It
 *    changes only on a discrete operator action, so it is safe to put behind
 *    `useSyncExternalStore`.
 *
 * WHY THE SNAPSHOT MATTERS FOR HONESTY
 * A highlighted "俯视拓扑" chip while the operator has already orbited away would
 * be a lie. `noteManualCameraInteraction()` - called from the rig's `onStart` -
 * demotes the mode to `'manual'`, so no preset stays lit after a drag or wheel
 * zoom. The rig still owns the camera; the toolbar only mirrors it.
 *
 * This module is deliberately dependency-free: it must NOT import `three` or
 * React, so the DOM overlay can use it without pulling WebGL into its bundle.
 */

/* ==========================================================================
   Presets
   ========================================================================== */

/** Camera framings a toolbar button can request. */
export const CAMERA_PRESETS = ['overview', 'top'] as const;

export type CameraPreset = (typeof CAMERA_PRESETS)[number];

/**
 * Which preset the camera is currently framing, `'entity'` when it is holding a
 * selection close-up, or `'manual'` once the operator has taken the camera back
 * by dragging / zooming.
 *
 * `'entity'` exists so a selection close-up is not mislabelled as "manual": the
 * toolbar highlights neither preset in that state, which is the correct readout.
 */
export type CameraFocusMode = CameraPreset | 'entity' | 'manual';

/** Immutable, referentially-stable view of the camera control surface. */
export interface CameraControlSnapshot {
  /** True while the OrbitControls auto-rotate ("环绕巡检") is running. */
  readonly autoRotate: boolean;
  readonly mode: CameraFocusMode;
}

/**
 * The server snapshot. `next/dynamic({ ssr: false })` means the toolbar is never
 * part of the server HTML, but `useSyncExternalStore` still requires a third
 * argument in TypeScript - and returning this frozen constant keeps the shape
 * identical if the toolbar is ever rendered during SSR.
 */
const INITIAL_SNAPSHOT: CameraControlSnapshot = Object.freeze({
  autoRotate: false,
  mode: 'overview',
});

/* ==========================================================================
   Registry
   ========================================================================== */

let snapshot: CameraControlSnapshot = INITIAL_SNAPSHOT;

const snapshotListeners = new Set<() => void>();
const presetListeners = new Set<(preset: CameraPreset) => void>();
const autoRotateListeners = new Set<(enabled: boolean) => void>();

/**
 * Commits a new snapshot and wakes the React subscribers.
 *
 * Identity-stable: an unchanged snapshot is returned as-is and listeners are not
 * notified, so re-clicking the already-active preset button cannot re-render the
 * toolbar. The COMMAND still fires - see `requestPreset` - because clicking the
 * active preset must fly the camera home again after a manual orbit.
 */
function publish(next: CameraControlSnapshot): void {
  if (next.autoRotate === snapshot.autoRotate && next.mode === snapshot.mode) {
    return;
  }
  snapshot = next;
  for (const listener of snapshotListeners) {
    listener();
  }
}

/* ==========================================================================
   Snapshot channel (for useSyncExternalStore)
   ========================================================================== */

export function getCameraControlSnapshot(): CameraControlSnapshot {
  return snapshot;
}

export function getServerCameraControlSnapshot(): CameraControlSnapshot {
  return INITIAL_SNAPSHOT;
}

/**
 * Subscribes to control-surface changes.
 *
 * @returns an unsubscribe function.
 */
export function subscribeCameraControls(listener: () => void): () => void {
  snapshotListeners.add(listener);
  return () => {
    snapshotListeners.delete(listener);
  };
}

/* ==========================================================================
   Command channel (for CameraRig)
   ========================================================================== */

/**
 * Registers the rig's preset handler. Called once by `CameraRig` for its
 * lifetime.
 *
 * @returns an unsubscribe function.
 */
export function onCameraPreset(
  listener: (preset: CameraPreset) => void,
): () => void {
  presetListeners.add(listener);
  return () => {
    presetListeners.delete(listener);
  };
}

/**
 * Registers the rig's auto-rotation handler.
 *
 * @returns an unsubscribe function.
 */
export function onAutoRotateChange(
  listener: (enabled: boolean) => void,
): () => void {
  autoRotateListeners.add(listener);
  return () => {
    autoRotateListeners.delete(listener);
  };
}

/**
 * Requests an eased flight to a preset framing.
 *
 * Always dispatches, even when the preset is already active: the operator uses
 * the same button both to change framing and to return to it after orbiting.
 */
export function requestPreset(preset: CameraPreset): void {
  publish({ autoRotate: snapshot.autoRotate, mode: preset });
  for (const listener of presetListeners) {
    listener(preset);
  }
}

/** Enables or disables the "环绕巡检" auto-rotation. */
export function setAutoRotate(enabled: boolean): void {
  if (enabled === snapshot.autoRotate) {
    return;
  }
  publish({ autoRotate: enabled, mode: snapshot.mode });
  for (const listener of autoRotateListeners) {
    listener(enabled);
  }
}

/** Flips auto-rotation and returns the state it landed in. */
export function toggleAutoRotate(): boolean {
  const next = !snapshot.autoRotate;
  setAutoRotate(next);
  return next;
}

/**
 * Demotes the active preset to `'manual'` after a drag / wheel zoom.
 *
 * No-op when the mode is already manual, so calling this from every `onStart`
 * cannot flood the subscribers. The rig calls it from `onStart`; the flight is
 * cancelled there too.
 */
export function noteManualCameraInteraction(): void {
  noteRigCameraMode('manual');
}

/**
 * The rig's report of what it is framing, so the toolbar highlights the truth.
 *
 * Callers:
 * - `'entity'` while holding a selection close-up (the toolbar lights nothing).
 * - `'overview'` when the selection was cleared and the rig flew home, so the
 *   "全景鸟瞰" chip stays accurate instead of reading "manual".
 *
 * Without this the toolbar would claim a preset the camera is not on, e.g.
 * "全景鸟瞰" lit while the camera sits 3 units in front of a rack.
 */
export function noteRigCameraMode(mode: CameraFocusMode): void {
  if (snapshot.mode === mode) {
    return;
  }
  publish({ autoRotate: snapshot.autoRotate, mode });
}

/** True when `value` is a preset this bus can dispatch. */
export function isCameraPreset(value: unknown): value is CameraPreset {
  return (
    typeof value === 'string' &&
    (CAMERA_PRESETS as readonly string[]).includes(value)
  );
}