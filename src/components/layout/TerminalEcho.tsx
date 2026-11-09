'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import {
  ChevronDown,
  ChevronUp,
  Eraser,
  Terminal,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { PaneSeparator, useFollowPane } from './paneSplit';
import type { TerminalLogTone } from '@/types/store';
import {
  parseTerminalLogLine,
  useClusterStore,
  useTerminalCollapsed,
} from '@/store/useClusterStore';

/* ==========================================================================
   Constants
   ========================================================================== */

/** Distance from the bottom, in px, still considered "pinned to the tail". */
const STICK_TO_BOTTOM_THRESHOLD_PX = 24;
/** Expanded height before the operator drags. Matches the old `h-32`. */
const TERMINAL_DEFAULT_PX = 128;
const TERMINAL_MIN_PX = 120;
const TERMINAL_CANVAS_MIN_PX = 160;
const TERMINAL_HEIGHT_KEY = 'kv-terminal-echo-height';

/**
 * Tone -> text colour.
 *
 * Explicit class strings (not interpolated) so Tailwind's JIT scanner can see
 * every variant at build time. Never build these dynamically:
 * `text-${tone}-400` would be purged.
 */
const TONE_TEXT: Record<TerminalLogTone, string> = {
  healthy: 'text-emerald-400',
  elevated: 'text-amber-400',
  critical: 'text-rose-400',
  accent: 'text-cyan-400',
  violet: 'text-violet-400',
  neutral: 'text-slate-400',
};

const TONE_BADGE: Record<TerminalLogTone, string> = {
  healthy: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
  elevated: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  critical: 'border-rose-500/50 bg-rose-500/10 text-rose-400',
  accent: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-400',
  violet: 'border-violet-500/40 bg-violet-500/10 text-violet-400',
  neutral: 'border-slate-700 bg-slate-800/60 text-slate-400',
};

/* ==========================================================================
   TerminalEcho
   ========================================================================== */

/**
 * 左侧 3D 视口底部的极客事件流终端。
 *
 * Behaviour:
 * - Expanded: a pixel height (default 128) dragged from the top edge. Collapsed
 *   to an `h-8` status strip via the header or the chevron. The drag grip is
 *   absent while folded, and the last height returns on expand.
 * - Auto-scroll: sticks to the newest line, but ONLY while the operator is
 *   already at the bottom. If they scroll up to read history, new lines do not
 *   yank the viewport back - the standard log-viewer contract.
 * - Colour: driven by the parsed channel (`[WARN]`, `[ERR]`, `[AI-COPILOT]`,
 *   `[EDGE-WASM]`, `[KUBE-CONTROLLER]`, ...), never by substring sniffing.
 *
 * SSR safety: this component renders the log buffer only; the buffer's initial
 * contents come from the frozen seed, so server and client agree. The scroll
 * effect runs client-side only.
 */
export function TerminalEcho(): ReactElement {
  const terminalLogs = useClusterStore((state) => state.terminalLogs);
  const collapsed = useTerminalCollapsed();
  const toggleCollapsed = useClusterStore((state) => state.toggleTerminalCollapsed);
  const setCollapsed = useClusterStore((state) => state.setTerminalCollapsed);
  const clearLogs = useClusterStore((state) => state.clearTerminalLogs);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const stickToBottomRef = useRef<boolean>(true);
  const [columnHeight, setColumnHeight] = useState(0);
  /* Mirror of `stickToBottomRef` for the header label. The ref is the source of
     truth for the scroll effect (it must not trigger a render on every scroll
     event); this state exists only so the "tail / scroll-lock" badge updates. */
  const [isPinned, setIsPinned] = useState<boolean>(true);

  useEffect(() => {
    const section = sectionRef.current;
    const column = section?.parentElement;
    if (column === null || column === undefined) {
      return;
    }
    const measure = (): void => {
      setColumnHeight(column.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    return () => {
      observer.disconnect();
    };
  }, []);

  const maxHeight = columnHeight === 0
    ? 480
    : Math.max(TERMINAL_MIN_PX, columnHeight - TERMINAL_CANVAS_MIN_PX);
  const heightPane = useFollowPane({
    storageKey: TERMINAL_HEIGHT_KEY,
    axis: 'y',
    edge: 'end',
    min: TERMINAL_MIN_PX,
    max: maxHeight,
    defaultSize: TERMINAL_DEFAULT_PX,
  });

  /**
   * Parses each line once per string identity.
   *
   * Lines are immutable, so a WeakMap-style cache would work, but the buffer is
   * capped at 200 entries and the parse is a single regex - memoizing on the
   * array reference is enough and keeps the code honest.
   */
  const rendered = useMemo(
    () => terminalLogs.map((line) => ({ raw: line, parsed: parseTerminalLogLine(line) })),
    [terminalLogs],
  );

  /** Tracks whether the operator is reading the tail. */
  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (node === null) {
      return;
    }
    const distanceFromBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight;
    const pinned = distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD_PX;
    stickToBottomRef.current = pinned;
    /* Only set state when the badge actually changes, so a fast scroll does not
       queue a render per scroll event. */
    setIsPinned((previous) => (previous === pinned ? previous : pinned));
  }, []);

  /* Auto-scroll on every append, but only when pinned to the tail.
     Resizing the terminal uses the same rule: a reader parked mid-log keeps
     their scrollTop, and a reader already on the tail stays on the tail. */
  useEffect(() => {
    if (collapsed) {
      return;
    }
    const node = scrollRef.current;
    if (node === null || !stickToBottomRef.current) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [terminalLogs, collapsed, heightPane.size]);

  /* `noUncheckedIndexedAccess` types index access as possibly-undefined even
     when the length check guarantees a hit, hence the `?? null` fallback. */
  const lastLine =
    rendered.length === 0 ? null : (rendered[rendered.length - 1] ?? null);

  return (
    <section
      ref={sectionRef}
      className="pointer-events-auto flex shrink-0 flex-col overflow-hidden border-t border-slate-800/80 bg-slate-950/85 backdrop-blur-md"
      style={{ height: collapsed ? 32 : heightPane.size }}
      aria-label="Cluster event stream"
    >
      {collapsed ? null : (
        <PaneSeparator {...heightPane.separatorProps} label="拖动调整终端高度" />
      )}
      {/* ------------------------------ header ------------------------------ */}
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        aria-controls="terminal-echo-body"
        className="flex h-8 shrink-0 items-center gap-2 border-b border-slate-800/60 px-3 text-left transition-colors hover:bg-slate-900/60"
      >
        <Terminal className="h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden />
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-ultra-wide text-slate-400">
          terminal echo
        </span>

        <span className="flex items-center gap-1 rounded border border-slate-800 bg-slate-900/80 px-1.5 py-px font-mono text-[9px] tabular-nums text-slate-500">
          {terminalLogs.length} lines
        </span>

        {/* Collapsed preview: the newest line, dimmed, so the strip stays useful. */}
        {collapsed && lastLine !== null && (
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-600">
            {lastLine.parsed.timestamp !== null && (
              <span className="mr-1.5 text-slate-700">{lastLine.parsed.timestamp}</span>
            )}
            <span className={cn('mr-1.5', TONE_TEXT[lastLine.parsed.tone])}>
              {lastLine.parsed.channel !== null
                ? `[${lastLine.parsed.channel}]`
                : ''}
            </span>
            {lastLine.parsed.message}
          </span>
        )}

        {!collapsed && (
          <span className="ml-auto flex items-center gap-1 font-mono text-[9px] uppercase tracking-widest text-slate-700">
            {isPinned ? 'tail' : 'scroll-lock'}
          </span>
        )}

        <span
          className={cn(
            'grid h-5 w-5 shrink-0 place-items-center rounded text-slate-500',
            collapsed ? 'ml-auto' : '',
          )}
          aria-hidden
        >
          {collapsed ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </span>
      </button>

      {/* ------------------------------- body ------------------------------- */}
      {!collapsed && (
        <div
          id="terminal-echo-body"
          ref={scrollRef}
          onScroll={handleScroll}
          className="kv-fade-bottom relative flex-1 overflow-y-auto overscroll-contain px-3 py-1.5"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          tabIndex={0}
        >
          {rendered.length === 0 ? (
            <p className="py-2 font-mono text-[11px] text-slate-700">
              awaiting telemetry - buffer empty
            </p>
          ) : (
            <ul className="space-y-px">
              {rendered.map(({ raw, parsed }, index) => (
                <li
                  key={`${index}-${raw}`}
                  className="flex items-start gap-1.5 font-mono text-[11px] leading-5"
                >
                  <span className="w-14 shrink-0 text-right text-slate-700 tabular-nums">
                    {parsed.timestamp ?? '--:--:--'}
                  </span>

                  {parsed.channel !== null ? (
                    <span
                      className={cn(
                        'mt-0.5 shrink-0 rounded border px-1 text-[9px] leading-4 tracking-wide',
                        TONE_BADGE[parsed.tone],
                      )}
                    >
                      {parsed.channel}
                    </span>
                  ) : (
                    <span className="w-0 shrink-0" aria-hidden />
                  )}

                  <span
                    className={cn(
                      'min-w-0 break-words',
                      parsed.tone === 'neutral'
                        ? 'text-slate-400'
                        : TONE_TEXT[parsed.tone],
                    )}
                  >
                    {parsed.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ----------------------------- footer bar ---------------------------- */}
      {!collapsed && (
        <div className="flex h-6 shrink-0 items-center justify-between border-t border-slate-800/60 bg-slate-950/60 px-3">
          <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-widest text-slate-700">
            <span className="h-1 w-1 animate-pulse-glow rounded-full bg-emerald-400" />
            stream live
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={clearLogs}
              className="flex items-center gap-1 rounded px-1.5 py-px font-mono text-[9px] uppercase tracking-widest text-slate-600 transition-colors hover:text-rose-400"
            >
              <Eraser className="h-2.5 w-2.5" aria-hidden />
              clear
            </button>
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              className="rounded px-1.5 py-px font-mono text-[9px] uppercase tracking-widest text-slate-600 transition-colors hover:text-cyan-400"
            >
              fold
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export default TerminalEcho;