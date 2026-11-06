/**
 * KubeVision AI - load -> neon colour ramp for the 3D hardware models.
 *
 * WHY THIS IS A SEPARATE MODULE
 * The rack rails, the tray status LEDs and the master core all need to answer the
 * same question - "how loaded is this thing, and what colour is that?" - and they
 * all answer it inside `useFrame`. Putting the ramp here keeps:
 *
 * 1. ONE definition of the thresholds, so a rail can never glow amber while the
 *    LED beside it is still cyan.
 * 2. ZERO allocation on the frame path: every `Color` below is a module-level
 *    singleton, and `writeLoadColor` copies INTO the caller's colour instead of
 *    returning a new object (`.cursorrules` rule 3).
 9| * 3. No `three` import at the module's public surface beyond the `Color` type
 *    the helpers already require, so this cannot drag WebGL into the HUD bundle.
 *
 * SEMANTICS (matching the `.cursorrules` palette contract)
 *   healthy  -> emerald-400 #34d399  (load < 55%)
 *   elevated -> amber-400   #fbbf24  (55% <= load < 80%)
 *   critical -> rose-500    #f43f5e  (load >= 80%)
 * Between those anchors the colour is interpolated, so the rails slide smoothly
 * from cyan-green to amber to red instead of snapping at a threshold.
 */

import { Color } from 'three';

/* ==========================================================================
   Palette anchors - module-level singletons, never mutated
   ========================================================================== */

/** Below this the hardware reads as comfortably loaded. */
export const LOAD_ELEVATED_THRESHOLD = 55;

/** At or above this the hardware reads as saturated. */
export const LOAD_CRITICAL_THRESHOLD = 80;

const LOAD_LOW_COLOR = new Color('#34d399');
const LOAD_MID_COLOR = new Color('#fbbf24');
const LOAD_HIGH_COLOR = new Color('#f43f5e');

/** Idle cyan used when a node reports no measurable load at all. */
const LOAD_IDLE_COLOR = new Color('#22d3ee');

/**
 * Writes the load colour for `loadPercent` into `out`.
 *
 * @param loadPercent - utilization in [0, 100]; values outside are clamped
 * @param out         - the material's own `Color`, mutated in place
 */
export function writeLoadColor(loadPercent: number, out: Color): Color {
  if (!Number.isFinite(loadPercent)) {
    return out.copy(LOAD_IDLE_COLOR);
  }
  const load = Math.min(100, Math.max(0, loadPercent));

  if (load < LOAD_ELEVATED_THRESHOLD) {
    const t = load / LOAD_ELEVATED_THRESHOLD;
    return out.copy(LOAD_LOW_COLOR).lerp(LOAD_MID_COLOR, t);
  }
  if (load < LOAD_CRITICAL_THRESHOLD) {
    const t = (load - LOAD_ELEVATED_THRESHOLD) /
      (LOAD_CRITICAL_THRESHOLD - LOAD_ELEVATED_THRESHOLD);
    return out.copy(LOAD_MID_COLOR).lerp(LOAD_HIGH_COLOR, t);
  }
  return out.copy(LOAD_HIGH_COLOR);
}

/**
 * Whether `loadPercent` should trigger the "critical" visual language (pulsing
 * halo, faster breathing). Kept next to the ramp so the two cannot disagree.
 */
export function isCriticalLoad(loadPercent: number): boolean {
  return Number.isFinite(loadPercent) && loadPercent >= LOAD_CRITICAL_THRESHOLD;
}

/**
 * Emissive intensity for a rail at `loadPercent`.
 *
 * Higher load must not just change HUE but also BRIGHTNESS: on a dark chassis a
 * rose-tinted rail at the same intensity as an emerald one is easy to miss in
 * peripheral vision. Range is [0.55, 2.1].
 */
export function loadEmissiveIntensity(loadPercent: number): number {
  if (!Number.isFinite(loadPercent)) {
    return 0.55;
  }
  const load = Math.min(100, Math.max(0, loadPercent)) / 100;
  return 0.55 + load * 1.55;
}

/* ==========================================================================
   Average helpers
   ========================================================================== */

/**
 * Mean utilization of the pods hosted by one node.
 *
 * Demo semantics: a node with no Running pods reports 0 rather than the mean of
 * its zeroed Pending pods, because a partitioned node should read as "dark", not
 * as "50% between running and dead".
 */
export function averageLoad(
  values: readonly number[],
  fallback = 0,
): number {
  if (values.length === 0) {
    return fallback;
  }
  let sum = 0;
  for (const value of values) {
    if (Number.isFinite(value)) {
      sum += value;
    }
  }
  return sum / values.length;
}