/**
 * Developer performance HUD and the canvas quality budget.
 *
 * These numbers are the contract between `ClusterCanvas` (which spends them)
 * and `PerfTelemetryHUD` (which displays them). Keeping them here stops the
 * sparkle count or the 40 FPS floor from being copied as two different literals.
 */

/** Averaged FPS below this floor asks the canvas to degrade. */
export const PERF_FPS_LOWER = 40;

/** Averaged FPS at or above this ceiling restores the full canvas budget. */
export const PERF_FPS_UPPER = 60;

/** Cyan dust motes while the canvas is at full quality. */
export const SPARKLE_COUNT_FULL = 120;

/** Cyan dust motes after a sustained drop below `PERF_FPS_LOWER`. */
export const SPARKLE_COUNT_DEGRADED = 40;

/**
 * Pod draw batches.
 *
 * `PodInstancedField` mounts one `InstancedMesh` per rack, and there are three
 * racks. A per-pod mesh would have issued one draw per live pod instead.
 */
export const INSTANCED_POD_BATCHES = 3;

/** How many FPS samples the sparkline keeps. Filled at ~10 Hz from the canvas. */
export const PERF_FPS_HISTORY = 48;

/** Where the latest telemetry frame came from. */
export const PERF_TRANSPORTS = ['idle', 'sse', 'local'] as const;

export type PerfTransport = (typeof PERF_TRANSPORTS)[number];

/**
 * Discrete quality flags. The high-frequency numbers (fps, draw calls) are not
 * in here: those must not notify React on every frame.
 */
export interface RenderBudgetFlags {
  readonly degraded: boolean;
  readonly paused: boolean;
  readonly sparkleCount: number;
  /** Pixel ratio actually handed to the canvas. `1` while degraded. */
  readonly dpr: number;
}

/** One polled reading for the developer HUD. */
export interface PerfFrameReading {
  readonly fps: number;
  readonly frameMs: number;
  readonly history: readonly number[];
  readonly drawCalls: number;
  readonly activePodCount: number;
  readonly sseLatencyMs: number | null;
  readonly transport: PerfTransport;
  readonly degraded: boolean;
  readonly paused: boolean;
  readonly sparkleCount: number;
  readonly dpr: number;
}

/** Props for the floating developer telemetry panel. */
export interface PerfTelemetryHUDProps {
  /** Hide the panel. The top-bar button and Shift+P call the same store flag. */
  readonly onClose: () => void;
}
