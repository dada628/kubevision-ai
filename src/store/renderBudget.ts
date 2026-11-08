/**
 * Canvas quality budget and the latest frame counters.
 *
 * WHY THIS IS NOT ZUSTAND
 * FPS, frame time and draw calls change every frame. Putting them in the
 * cluster store would re-render the whole command surface at 60 Hz and break
 * the frame budget. `useFrame` only writes numbers into this module. React
 * hears about two discrete flags (degraded, paused). The HUD copies the
 * numbers on its own slow poll.
 */

import type { IsoTimestamp } from '@/types/cluster';
import type { PerfFrameReading, PerfTransport, RenderBudgetFlags } from '@/types/perf';
import {
  PERF_FPS_HISTORY,
  PERF_FPS_LOWER,
  PERF_FPS_UPPER,
  SPARKLE_COUNT_DEGRADED,
  SPARKLE_COUNT_FULL,
} from '@/types/perf';
import { getSnapshot } from '@/store/useTelemetryRef';

const HISTORY = PERF_FPS_HISTORY;
const fpsRing = new Float32Array(HISTORY);

let ringCursor = 0;
let ringFilled = 0;
let lastRingAt = 0;
let lowStreak = 0;
let highStreak = 0;

/** 10 Hz samples. Twenty in a row is two seconds under or over the floor. */
const SUSTAINED_SAMPLES = 20;

let latestFps = 60;
let latestFrameMs = 1000 / 60;
let latestDrawCalls = 0;
let latestLatencyMs: number | null = null;
let latestTransport: PerfTransport = 'idle';

let degraded = false;
let paused = false;

const FULL_FLAGS: RenderBudgetFlags = Object.freeze({
  degraded: false,
  paused: false,
  sparkleCount: SPARKLE_COUNT_FULL,
  dpr: 2,
});

let flags: RenderBudgetFlags = FULL_FLAGS;
const listeners = new Set<() => void>();
let degradeTimer = 0;

function buildFlags(): RenderBudgetFlags {
  return {
    degraded,
    paused,
    sparkleCount: degraded ? SPARKLE_COUNT_DEGRADED : SPARKLE_COUNT_FULL,
    dpr: degraded ? 1 : 2,
  };
}

function publishFlags(): void {
  flags = buildFlags();
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Records one rendered frame.
 *
 * Called from the canvas `useFrame`. It must not notify React. The sparkline
 * ring accepts a sample at most every 100 ms so the line shows about a second
 * of motion per ten points instead of a single frame.
 */
export function noteFrameBudget(fps: number, frameMs: number, drawCalls: number): void {
  if (Number.isFinite(fps) && fps >= 0) {
    latestFps = fps;
  }
  if (Number.isFinite(frameMs) && frameMs >= 0) {
    latestFrameMs = frameMs;
  }
  if (Number.isFinite(drawCalls) && drawCalls >= 0) {
    latestDrawCalls = drawCalls;
  }
  const now = performance.now();
  if (now - lastRingAt < 100) {
    return;
  }
  lastRingAt = now;
  fpsRing[ringCursor] = latestFps;
  ringCursor = (ringCursor + 1) % HISTORY;
  if (ringFilled < HISTORY) {
    ringFilled += 1;
  }
  /*
   * PerformanceMonitor emits onDecline / onIncline for a sampled window.
   * This streak is the continuous watch: a machine that falls under 40 FPS
   * after that window still sheds pixels and sparkles, and a recovery above
   * 60 FPS puts them back. The request is deferred off the frame.
   */
  if (latestFps < PERF_FPS_LOWER) {
    lowStreak += 1;
    highStreak = 0;
    if (lowStreak >= SUSTAINED_SAMPLES && !degraded) {
      requestRenderDegraded(true);
    }
    return;
  }
  if (latestFps >= PERF_FPS_UPPER) {
    highStreak += 1;
    lowStreak = 0;
    if (highStreak >= SUSTAINED_SAMPLES && degraded) {
      requestRenderDegraded(false);
    }
    return;
  }
  lowStreak = 0;
  highStreak = 0;
}

/**
 * Age of the telemetry frame at the moment it was applied.
 *
 * `timestamp` is the simulation clock on the snapshot. The difference against
 * the wall clock is the delivery delay for an SSE frame, and the same age for
 * a locally stepped frame.
 */
export function noteTelemetryArrival(
  timestamp: IsoTimestamp,
  transport: Exclude<PerfTransport, 'idle'>,
): void {
  const parsed = Date.parse(timestamp);
  latestTransport = transport;
  if (!Number.isFinite(parsed)) {
    latestLatencyMs = null;
    return;
  }
  latestLatencyMs = Math.max(0, Date.now() - parsed);
}

export function isRenderPaused(): boolean {
  return paused;
}

export function setRenderPaused(next: boolean): void {
  if (paused === next) {
    return;
  }
  paused = next;
  publishFlags();
}

/**
 * Asks the canvas to drop or restore quality.
 *
 * `PerformanceMonitor` invokes its callbacks from inside `useFrame`. Committing
 * here synchronously would re-render React on that call stack, which the frame
 * budget forbids. The timeout leaves the current frame alone.
 */
export function requestRenderDegraded(next: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.clearTimeout(degradeTimer);
  degradeTimer = window.setTimeout(() => {
    degradeTimer = 0;
    if (degraded === next) {
      return;
    }
    degraded = next;
    publishFlags();
  }, 0);
}

export function subscribeRenderBudget(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRenderBudgetFlags(): RenderBudgetFlags {
  return flags;
}

export function getRenderBudgetServerFlags(): RenderBudgetFlags {
  return FULL_FLAGS;
}

function copyHistory(): readonly number[] {
  const history: number[] = [];
  if (ringFilled === 0) {
    return history;
  }
  const start = ringFilled < HISTORY ? 0 : ringCursor;
  for (let index = 0; index < ringFilled; index += 1) {
    history.push(fpsRing[(start + index) % HISTORY] ?? 0);
  }
  return history;
}

function countActivePods(): number {
  let count = 0;
  for (const pod of getSnapshot().pods) {
    if (pod.status !== 'Pending') {
      count += 1;
    }
  }
  return count;
}

/** Copies the latest counters. Allocates only for the HUD poll, never per frame. */
export function readPerfReading(): PerfFrameReading {
  return {
    fps: latestFps,
    frameMs: latestFrameMs,
    history: copyHistory(),
    drawCalls: latestDrawCalls,
    activePodCount: countActivePods(),
    sseLatencyMs: latestLatencyMs,
    transport: latestTransport,
    degraded: flags.degraded,
    paused: flags.paused,
    sparkleCount: flags.sparkleCount,
    dpr: flags.dpr,
  };
}
