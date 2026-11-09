'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import { cn } from '@/utils/cn';

/** Hit target shared with the copilot grip. */
export const PANE_HANDLE_PX = 32;
const PANE_STEP_PX = 16;
const PANE_SHIFT_STEP_PX = 48;

export type PaneAxis = 'x' | 'y';

/**
 * Which side of the split is the sized pane.
 * `end` is the right or bottom pane (drawer, terminal, copilot composer).
 * `start` is the left or top pane (auditor chrome above the log list).
 */
export type PaneEdge = 'end' | 'start';

export function clampPane(size: number, min: number, max: number): number {
  const upper = Math.max(min, max);
  return Math.min(upper, Math.max(min, Math.round(size)));
}

/**
 * Move the sized pane so the grip stays under the pointer.
 * For an end pane, dragging toward the start grows it.
 */
export function paneSizeFromPointer(
  startSize: number,
  startPointer: number,
  pointer: number,
  edge: PaneEdge,
  min: number,
  max: number,
): number {
  const delta = pointer - startPointer;
  const next = edge === 'end' ? startSize - delta : startSize + delta;
  return clampPane(next, min, max);
}

interface FollowPaneOptions {
  readonly storageKey: string;
  readonly axis: PaneAxis;
  readonly edge: PaneEdge;
  readonly min: number;
  readonly max: number;
  readonly defaultSize: number;
}

interface DragOrigin {
  readonly pointerId: number;
  readonly startPointer: number;
  readonly startSize: number;
}

export interface PaneSeparatorProps {
  readonly axis: PaneAxis;
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly className?: string;
}

/**
 * Pixel size for one pane. The grip follows the pointer 1:1.
 * localStorage is written on release and on keyboard commit, never on every move.
 */
export function useFollowPane(options: FollowPaneOptions): {
  readonly size: number;
  readonly separatorProps: PaneSeparatorProps;
} {
  const { storageKey, axis, edge, min, max, defaultSize } = options;
  const [stored, setStored] = useState<number | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const dragRef = useRef<DragOrigin | null>(null);
  const limitsRef = useRef({ min, max, edge, axis });
  limitsRef.current = { min, max, edge, axis };

  useEffect(() => {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw === null ? Number.NaN : Number(raw);
    setStored(Number.isFinite(parsed) ? parsed : null);
    setLoadedKey(storageKey);
  }, [storageKey]);

  const ready = loadedKey === storageKey;
  const basis = ready && stored !== null ? stored : defaultSize;
  const size = clampPane(basis, min, max);

  const commit = (next: number): void => {
    const limits = limitsRef.current;
    const clamped = clampPane(next, limits.min, limits.max);
    setStored(clamped);
    setLoadedKey(storageKey);
    window.localStorage.setItem(storageKey, String(clamped));
  };

  const pointerOf = (event: ReactPointerEvent<HTMLButtonElement>): number => {
    return limitsRef.current.axis === 'x' ? event.clientX : event.clientY;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startPointer: pointerOf(event),
      startSize: size,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) {
      return;
    }
    const limits = limitsRef.current;
    setStored(
      paneSizeFromPointer(
        drag.startSize,
        drag.startPointer,
        pointerOf(event),
        limits.edge,
        limits.min,
        limits.max,
      ),
    );
    setLoadedKey(storageKey);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    const limits = limitsRef.current;
    commit(
      paneSizeFromPointer(
        drag.startSize,
        drag.startPointer,
        pointerOf(event),
        limits.edge,
        limits.min,
        limits.max,
      ),
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const limits = limitsRef.current;
    const step = event.shiftKey ? PANE_SHIFT_STEP_PX : PANE_STEP_PX;
    const towardStart = limits.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const towardEnd = limits.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    if (event.key === towardStart) {
      event.preventDefault();
      commit(limits.edge === 'end' ? size + step : size - step);
      return;
    }
    if (event.key === towardEnd) {
      event.preventDefault();
      commit(limits.edge === 'end' ? size - step : size + step);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      commit(limits.edge === 'end' ? limits.max : limits.min);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      commit(limits.edge === 'end' ? limits.min : limits.max);
    }
  };

  return {
    size,
    separatorProps: {
      axis,
      label: '',
      value: size,
      min,
      max,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onKeyDown,
    },
  };
}

export function PaneSeparator({
  axis,
  label,
  value,
  min,
  max,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onKeyDown,
  className,
}: PaneSeparatorProps): ReactElement {
  const vertical = axis === 'x';
  return (
    <button
      type="button"
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      title="分隔条跟随指针"
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      className={cn(
        vertical
          ? 'group flex h-full w-8 shrink-0 cursor-col-resize touch-none items-center justify-center outline-none ring-cyan-400 focus-visible:ring-2'
          : 'group flex h-8 w-full shrink-0 cursor-row-resize touch-none items-center justify-center outline-none ring-cyan-400 focus-visible:ring-2',
        className,
      )}
    >
      <span
        className={
          vertical
            ? 'h-10 w-1 rounded-full bg-slate-700 transition-colors duration-150 group-hover:bg-cyan-400 group-focus-visible:bg-cyan-400'
            : 'h-1 w-10 rounded-full bg-slate-700 transition-colors duration-150 group-hover:bg-cyan-400 group-focus-visible:bg-cyan-400'
        }
      />
    </button>
  );
}
