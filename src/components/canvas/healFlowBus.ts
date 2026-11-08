/**
 * Brief emerald surge on the cable that serves a rack the copilot just healed.
 *
 * The confirm card lives outside the canvas, and the packet loop cannot take
 * React state: a frame must not re-render. This module is the one number the
 * stream reads while it advances packets. No `three` import, so the card can
 * call it without pulling WebGL into the chat bundle.
 */

import type { RackIndex } from '@/types/cluster';

/** How long the healed cable stays fast and emerald, in seconds. */
const HEAL_FLOW_SECONDS = 2.4;

let surgeRack: RackIndex | null = null;
let surgeLeft = 0;

/** Arm the surge. A second heal on another rack replaces the first. */
export function requestHealFlow(rack: RackIndex): void {
  surgeRack = rack;
  surgeLeft = HEAL_FLOW_SECONDS;
}

/**
 * Advance the surge by one frame and report which rack is still glowing.
 *
 * Call once per frame, not once per cable, or the timer expires three times
 * too fast. `strength` falls from 1 to 0 so the colour eases back to cyan.
 */
export function sampleHealFlow(dt: number): { readonly rack: RackIndex; readonly strength: number } | null {
  if (surgeRack === null || surgeLeft <= 0) {
    surgeRack = null;
    surgeLeft = 0;
    return null;
  }
  const rack = surgeRack;
  const strength = surgeLeft / HEAL_FLOW_SECONDS;
  surgeLeft = Math.max(0, surgeLeft - dt);
  if (surgeLeft <= 0) {
    surgeRack = null;
  }
  return { rack, strength };
}
