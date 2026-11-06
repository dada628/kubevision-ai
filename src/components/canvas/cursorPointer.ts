'use client';

/**
 * KubeVision AI - shared pointer-cursor ownership.
 *
 * WHY A COUNTER AND NOT `document.body.style.cursor = ...`
 * Several independently pickable objects share one cursor: the master beacon, the
 * rack plinth, and now the instanced pod cells that float IN FRONT of the racks.
 * R3F dispatches the enter/leave pair of overlapping objects in an order the
 * components do not control - when the pointer slides off a pod onto the chassis
 * behind it, `pointerover` on the rack fires BEFORE `pointerout` on the pod, so a
 * pair of direct assignments ends at `auto` even though the pointer is still over
 * a pickable rack.
 *
 * A depth counter makes the result order-independent: any number of owners can
 * hold the cursor, and it only returns to `auto` once the LAST one releases. The
 * depth is clamped at zero so a stray release (a component unmounting mid-hover)
 * can never leave the cursor stuck as a pointer.
 *
 * Cost: one string write per transition, and only when the value actually
 * changes - never inside a frame loop.
 */

/** How many pickable objects currently want the pointer cursor. */
let holderDepth = 0;

/** Last value written to the DOM, so redundant writes are skipped. */
let appliedCursor: string | null = null;

function applyCursor(): void {
  if (typeof document === 'undefined') {
    return;
  }
  const next = holderDepth > 0 ? 'pointer' : 'auto';
  if (next === appliedCursor) {
    return;
  }
  appliedCursor = next;
  document.body.style.cursor = next;
}

/** Marks one pickable object as hovered. Call from `pointerover`. */
export function acquirePointerCursor(): void {
  holderDepth += 1;
  applyCursor();
}

/** Releases one holder. Call from `pointerout`, exactly once per acquire. */
export function releasePointerCursor(): void {
  holderDepth = Math.max(0, holderDepth - 1);
  applyCursor();
}

/**
 * Drops every holder.
 *
 * Used when a component unmounts while hovered: React does not fire `pointerout`
 * for a removed mesh, so without this the counter would leak and the cursor would
 * stay a pointer for the rest of the session.
 */
export function resetPointerCursor(depth = 1): void {
  holderDepth = Math.max(0, holderDepth - Math.max(0, depth));
  applyCursor();
}