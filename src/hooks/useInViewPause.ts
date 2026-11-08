'use client';

/**
 * Pauses the canvas when the operator cannot see it.
 *
 * Two signals, either one is enough:
 * - `document.hidden` — the tab is in the background
 * - `IntersectionObserver` — the viewport cell has scrolled out of view
 *
 * The boolean is React state so `<Canvas frameloop>` can stop. The same flag
 * is mirrored into `renderBudget` for anything that samples frames without
 * subscribing to this hook.
 */

import { useEffect, useState, type RefObject } from 'react';
import { useSyncExternalStore } from 'react';
import type { RenderBudgetFlags } from '@/types/perf';
import {
  getRenderBudgetFlags,
  getRenderBudgetServerFlags,
  setRenderPaused,
  subscribeRenderBudget,
} from '@/store/renderBudget';

/** Fraction of the viewport that must be visible to keep the loop running. */
const VIEW_THRESHOLD = 0.05;

export function useInViewPause(target: RefObject<Element | null>): boolean {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const node = target.current;
    let hidden = document.hidden;
    let inView = true;

    const publish = (): void => {
      const next = hidden || !inView;
      setPaused(next);
      setRenderPaused(next);
    };

    const onVisibility = (): void => {
      hidden = document.hidden;
      publish();
    };

    document.addEventListener('visibilitychange', onVisibility);

    let observer: IntersectionObserver | null = null;
    if (node !== null && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          inView = entry !== undefined && entry.isIntersecting;
          publish();
        },
        { threshold: VIEW_THRESHOLD },
      );
      observer.observe(node);
    }

    publish();

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      observer?.disconnect();
      setRenderPaused(false);
    };
  }, [target]);

  return paused;
}

/** Discrete quality flags. Updates only when degradation or pause changes. */
export function useRenderBudgetFlags(): RenderBudgetFlags {
  return useSyncExternalStore(
    subscribeRenderBudget,
    getRenderBudgetFlags,
    getRenderBudgetServerFlags,
  );
}
