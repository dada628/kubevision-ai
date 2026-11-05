'use client';

import { useEffect } from 'react';
import { useClusterStore } from '@/store/useClusterStore';

/**
 * Keeps the React-visible HUD in sync with the transient telemetry pool.
 *
 * WHY A TICKER AND NOT A SUBSCRIPTION
 * `telemetryTransientRef` is a plain mutable object - React cannot observe it.
 * Rather than making the pool reactive (which would defeat its entire purpose),
 * a single low-frequency ticker pulls a summary once per second and commits it
 * to the store. `syncSummary` itself is throttled, so this ticker cannot cause
 * more than `SUMMARY_SYNC_INTERVAL_MS` renders even if several drivers run.
 *
 * WHY 1000ms
 * Matches `SUMMARY_SYNC_INTERVAL_MS`. Ticking faster would be silently dropped
 * by the store gate; ticking slower would starve the HUD between frames.
 *
 * WHY requestAnimationFrame IS AVOIDED
 * An rAF loop here would fire 60x/s and, while the throttle drops the updates,
 * it would still wake the main thread every frame and compete with the R3F
 * loop. A `setInterval` at 1 Hz is effectively free.
 *
 * SSR: the effect only runs in the browser, so the server render uses the
 * deterministic seed summary and hydration sees identical markup.
 */
export function useHudSync(): void {
  useEffect(() => {
    const tick = (): void => {
      useClusterStore.getState().syncSummary(performance.now());
    };

    /* Immediate first sync so a client that mounted after a state mutation
       (e.g. fast refresh) does not show stale numbers for up to a second. */
    tick();
    const handle = window.setInterval(tick, 1000);

    /* Re-sync on tab focus: the interval is throttled by the browser while
       backgrounded, so returning to the tab should not wait for the next tick. */
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.clearInterval(handle);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}

export default useHudSync;