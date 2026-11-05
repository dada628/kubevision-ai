'use client';

import { useCallback, useEffect, useMemo, type ReactElement } from 'react';
import {
  Activity,
  Boxes,
  Cpu,
  Github,
  Gauge,
  ShieldAlert,
  Zap,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import type { PodStatus } from '@/types/cluster';
import { CHAOS_SCENARIOS } from '@/types/cluster';
import type { PodStatusFilter } from '@/types/store';
import {
  useActiveChaos,
  useClusterStore,
  useClusterSummary,
  useConnectionMode,
  usePerfHudOpen,
  useStatusFilter,
} from '@/store/useClusterStore';

/* ==========================================================================
   Constants
   ========================================================================== */

const APP_VERSION = 'v2.4-Edge';

const REPO_URL = 'https://github.com/dada628/kubevision-ai';

/**
 * Filter chips, in display order.
 *
 * A fixed tuple rather than `Object.keys(POD_STATUS_FILTERS)`: the order is a
 * design decision (ALL first, then the states an operator actually triages),
 * not something that should drift with a type change.
 */
const FILTER_CHIPS: readonly { filter: PodStatusFilter; label: string }[] = [
  { filter: 'ALL', label: 'ALL' },
  { filter: 'Running', label: 'Running' },
  { filter: 'Pending', label: 'Pending' },
  { filter: 'CrashLoopBackOff', label: 'CrashLoop' },
];

/** Which status each chip counts (`ALL` counts everything). */
const CHIP_STATUS: Record<Exclude<PodStatusFilter, 'ALL'>, PodStatus> = {
  Running: 'Running',
  Pending: 'Pending',
  CrashLoopBackOff: 'CrashLoopBackOff',
  OOMKilled: 'OOMKilled',
  Terminating: 'Terminating',
};

const CHIP_TONE: Record<PodStatusFilter, string> = {
  ALL: 'border-slate-700 text-slate-300',
  Running: 'border-emerald-500/40 text-emerald-400',
  Pending: 'border-amber-500/40 text-amber-400',
  CrashLoopBackOff: 'border-rose-500/40 text-rose-400',
  OOMKilled: 'border-rose-500/40 text-rose-400',
  Terminating: 'border-slate-500/40 text-slate-400',
};

/** Chaos rotation: one click advances the scenario, the last step resets. */
const CHAOS_ROTATION = CHAOS_SCENARIOS;

/* ==========================================================================
   Health semantics
   ========================================================================== */

type HealthTone = 'healthy' | 'elevated' | 'critical';

interface HealthPresentation {
  readonly tone: HealthTone;
  readonly ring: string;
  readonly text: string;
  readonly glow: string;
  readonly label: string;
  /** True only for the critical band, which pulses. */
  readonly blinks: boolean;
}

/**
 * Maps a health score onto the three contract bands:
 * `>= 85` emerald, `60..84` amber, `< 60` rose (blinking).
 */
function presentHealth(score: number): HealthPresentation {
  if (score >= 85) {
    return {
      tone: 'healthy',
      ring: 'stroke-emerald-400',
      text: 'text-emerald-400',
      glow: 'shadow-glow-emerald',
      label: 'healthy',
      blinks: false,
    };
  }
  if (score >= 60) {
    return {
      tone: 'elevated',
      ring: 'stroke-amber-400',
      text: 'text-amber-400',
      glow: 'shadow-glow-amber',
      label: 'degraded',
      blinks: false,
    };
  }
  return {
    tone: 'critical',
    ring: 'stroke-rose-500',
    text: 'text-rose-500',
    glow: 'shadow-glow-rose',
    label: 'critical',
    blinks: true,
  };
}

/* ==========================================================================
   Health ring
   ========================================================================== */

const RING_SIZE = 38;
const RING_STROKE = 3;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

interface HealthRingProps {
  readonly score: number;
}

function HealthRing({ score }: HealthRingProps): ReactElement {
  const presentation = presentHealth(score);
  const clamped = Math.min(100, Math.max(0, score));
  const dash = (clamped / 100) * RING_CIRCUMFERENCE;

  return (
    <div
      className={cn(
        'relative grid shrink-0 place-items-center rounded-full border border-slate-800 bg-slate-900/80',
        presentation.glow,
        presentation.blinks && 'animate-pulse-glow',
      )}
      style={{ width: RING_SIZE, height: RING_SIZE }}
      title={`cluster health ${score}/100`}
      role="img"
      aria-label={`Cluster health score ${score} out of 100, ${presentation.label}`}
    >
      <svg
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        className="absolute inset-0 -rotate-90"
        aria-hidden
      >
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          strokeWidth={RING_STROKE}
          className="stroke-slate-800"
        />
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${RING_CIRCUMFERENCE}`}
          className={cn(
            presentation.ring,
            'transition-[stroke-dasharray] duration-700 ease-out',
          )}
        />
      </svg>
      <span className={cn('relative font-mono text-[11px] font-semibold tabular-nums', presentation.text)}>
        {clamped}
      </span>
    </div>
  );
}

/* ==========================================================================
   QPS odometer
   ========================================================================== */

/**
 * Compact QPS formatter: `24.2k`, `1.3M`. Keeps the readout inside its box at
 * any traffic level without a second line of layout.
 */
function formatQps(value: number): { main: string; suffix: string } {
  if (!Number.isFinite(value) || value < 0) {
    return { main: '0', suffix: '' };
  }
  if (value >= 1_000_000) {
    return { main: (value / 1_000_000).toFixed(2), suffix: 'M' };
  }
  if (value >= 1000) {
    return { main: (value / 1000).toFixed(1), suffix: 'k' };
  }
  return { main: String(Math.round(value)), suffix: '' };
}

interface QpsReadoutProps {
  readonly qps: number;
}

function QpsReadout({ qps }: QpsReadoutProps): ReactElement {
  const { main, suffix } = useMemo(() => formatQps(qps), [qps]);

  return (
    <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5">
      <Activity className="h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden />
      <div className="leading-none">
        <p className="font-mono text-[9px] uppercase tracking-ultra-wide text-slate-500">
          qps
        </p>
        {/* Keying on the value remounts the span each tick, so the fade-in-up
            animation replays and the number visibly "ticks" without a timer. */}
        <p
          key={qps}
          className="animate-fade-in-up font-mono text-base font-semibold tabular-nums text-cyan-400 text-glow-cyan"
        >
          {main}
          {suffix.length > 0 && (
            <span className="ml-0.5 text-[11px] text-cyan-500/80">{suffix}</span>
          )}
        </p>
      </div>
    </div>
  );
}

/* ==========================================================================
   Mode switch
   ========================================================================== */

interface ModeSwitchProps {
  readonly mode: 'demo' | 'live';
  readonly onToggle: () => void;
}

function ModeSwitch({ mode, onToggle }: ModeSwitchProps): ReactElement {
  const isLive = mode === 'live';

  return (
    <button
      type="button"
      onClick={onToggle}
      role="switch"
      aria-checked={isLive}
      aria-label="Toggle between demo synthetic data and live tunnel"
      className={cn(
        'group relative flex items-center gap-2 rounded-full border px-1.5 py-1 transition-colors duration-200',
        isLive
          ? 'border-emerald-500/40 bg-emerald-500/10'
          : 'border-slate-700 bg-slate-900/70',
      )}
    >
      <span
        className={cn(
          'rounded-full px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest transition-colors',
          isLive ? 'text-slate-500' : 'text-cyan-400',
        )}
      >
        demo
      </span>
      <span
        className={cn(
          'relative h-4 w-8 rounded-full transition-colors duration-200',
          isLive ? 'bg-emerald-500/70' : 'bg-slate-700',
        )}
        aria-hidden
      >
        <span
          className={cn(
            'absolute top-0.5 h-3 w-3 rounded-full transition-transform duration-200 ease-out',
            isLive
              ? 'translate-x-4 bg-emerald-300 shadow-glow-emerald'
              : 'translate-x-0.5 bg-slate-400',
          )}
        />
      </span>
      <span
        className={cn(
          'rounded-full px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest transition-colors',
          isLive ? 'text-emerald-300' : 'text-slate-500',
        )}
      >
        live
      </span>
    </button>
  );
}

/* ==========================================================================
   TopBar
   ========================================================================== */

/**
 * 运维中控台顶栏。
 *
 * Layout contract: three zones (`left` brand / `middle` filters+QPS / `right`
 * actions) on `lg+`; on smaller screens the middle zone collapses and the QPS
 * readout moves into the right cluster so the bar never wraps to two lines and
 * never introduces a scrollbar (the shell locks the viewport).
 */
export function TopBar(): ReactElement {
  const summary = useClusterSummary();
  const connectionMode = useConnectionMode();
  const activeChaos = useActiveChaos();
  const statusFilter = useStatusFilter();
  const isPerfHudOpen = usePerfHudOpen();

  const toggleConnectionMode = useClusterStore((state) => state.toggleConnectionMode);
  const setStatusFilter = useClusterStore((state) => state.setStatusFilter);
  const triggerChaos = useClusterStore((state) => state.triggerChaos);
  const setChaosModalOpen = useClusterStore((state) => state.setChaosModalOpen);
  const togglePerfHud = useClusterStore((state) => state.setPerfHudOpen);

  const health = presentHealth(summary.healthScore);

  /**
   * Shift+P toggles the performance HUD.
   *
   * Guarded against typing contexts: an operator editing the copilot prompt
   * must be able to type a capital P without the HUD flashing.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!event.shiftKey || event.key.toLowerCase() !== 'p') {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        ) {
          return;
        }
      }
      event.preventDefault();
      togglePerfHud(!useClusterStore.getState().isPerfHudOpen);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [togglePerfHud]);

  /**
   * Chaos button: advances the scenario rotation, wrapping to `NONE` so the
   * demo can always be reset with the same control. Also opens the modal so the
   * operator can pick a specific scenario instead of cycling.
   */
  const handleInjectChaos = useCallback(() => {
    const currentIndex = CHAOS_ROTATION.indexOf(activeChaos);
    const nextIndex = (currentIndex + 1) % CHAOS_ROTATION.length;
    const next = CHAOS_ROTATION[nextIndex] ?? 'NONE';
    triggerChaos(next);
    setChaosModalOpen(true);
  }, [activeChaos, triggerChaos, setChaosModalOpen]);

  const chaosActive = activeChaos !== 'NONE';

  return (
    <header className="relative z-30 flex h-14 shrink-0 items-center gap-3 border-b border-slate-800/80 bg-slate-950/85 px-3 backdrop-blur-md sm:px-4">
      {/* ------------------------------- left ------------------------------- */}
      <div className="flex min-w-0 shrink-0 items-center gap-2.5">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-cyan-500/30 bg-cyan-500/10 text-cyan-400 shadow-glow-cyan"
          aria-hidden
        >
          <Boxes className="h-5 w-5" />
        </span>
        <div className="min-w-0 leading-tight">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold tracking-tight text-slate-100">
              KubeVision AI
            </span>
            <span className="shrink-0 rounded border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-px font-mono text-[9px] font-medium tracking-wide text-cyan-400">
              {APP_VERSION}
            </span>
          </div>
          <p className="hidden font-mono text-[9px] uppercase tracking-ultra-wide text-slate-600 sm:block">
            3d situational awareness
          </p>
        </div>

        <HealthRing score={summary.healthScore} />
        <div className="hidden leading-none xl:block">
          <p className="font-mono text-[9px] uppercase tracking-ultra-wide text-slate-600">
            health
          </p>
          <p className={cn('font-mono text-[10px] font-semibold', health.text)}>
            {health.label}
          </p>
        </div>
      </div>

      {/* ------------------------------ middle ------------------------------ */}
      <div className="hidden min-w-0 flex-1 items-center justify-center gap-2 lg:flex">
        <div
          className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/50 p-1"
          role="group"
          aria-label="Filter pods by status"
        >
          {FILTER_CHIPS.map(({ filter, label }) => {
            const isActive = statusFilter === filter;
            const count =
              filter === 'ALL'
                ? summary.totalPodCount
                : summary.podStatusCounts[CHIP_STATUS[filter]];
            return (
              <button
                key={filter}
                type="button"
                onClick={() => setStatusFilter(filter)}
                aria-pressed={isActive}
                className={cn(
                  'group flex items-center gap-1.5 rounded px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition-all duration-150',
                  isActive
                    ? cn('bg-slate-800/90 shadow-sm', CHIP_TONE[filter])
                    : 'text-slate-500 hover:bg-slate-800/40 hover:text-slate-300',
                )}
              >
                <span>{label}</span>
                <span
                  className={cn(
                    'rounded px-1 py-px text-[9px] tabular-nums',
                    isActive ? 'bg-slate-950/60' : 'bg-slate-800/60 text-slate-500',
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <QpsReadout qps={summary.totalQps} />

        <div className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/60 px-2.5 py-1.5">
          <Gauge className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />
          <div className="leading-none">
            <p className="font-mono text-[9px] uppercase tracking-ultra-wide text-slate-500">
              fps
            </p>
            <p className="font-mono text-xs font-semibold tabular-nums text-emerald-400">
              {summary.fps}
            </p>
          </div>
        </div>
      </div>

      {/* ------------------------------- right ------------------------------ */}
      <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
        {/* QPS stays visible on narrow screens where the middle zone is hidden. */}
        <div className="lg:hidden">
          <QpsReadout qps={summary.totalQps} />
        </div>

        <ModeSwitch mode={connectionMode} onToggle={toggleConnectionMode} />

        <button
          type="button"
          onClick={handleInjectChaos}
          aria-label={
            chaosActive
              ? `Chaos active: ${activeChaos}. Click to advance the scenario.`
              : 'Inject a chaos fault into the demo cluster'
          }
          title={
            chaosActive
              ? `Active fault: ${activeChaos} - click to advance`
              : 'Inject a chaos fault into the demo cluster'
          }
          className={cn(
            'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest transition-all duration-150',
            'border-rose-500/50 bg-rose-500/10 text-rose-400 hover:border-rose-400 hover:bg-rose-500/20 hover:shadow-glow-rose',
            chaosActive && 'border-rose-400 bg-rose-500/20 shadow-glow-rose animate-pulse-glow',
          )}
        >
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {/* One label per breakpoint. Both spans stay in the DOM (CSS hides
              one), so the visible one carries the text and the other is
              aria-hidden - otherwise a screen reader announces "Inject
              Chaoschaos". The button's aria-label is the authoritative name. */}
          <span className="hidden md:inline">
            {chaosActive ? activeChaos : 'Inject Chaos'}
          </span>
          <span className="md:hidden" aria-hidden>
            chaos
          </span>
        </button>

        <button
          type="button"
          onClick={() => togglePerfHud(!isPerfHudOpen)}
          aria-pressed={isPerfHudOpen}
          title="Toggle performance HUD (Shift+P)"
          className={cn(
            'hidden items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest transition-all duration-150 sm:flex',
            isPerfHudOpen
              ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-400 shadow-glow-cyan'
              : 'border-slate-700 bg-slate-900/70 text-slate-500 hover:border-slate-600 hover:text-slate-300',
          )}
        >
          <Cpu className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>HUD</span>
          <kbd className="rounded border border-slate-700 bg-slate-950/80 px-1 py-px text-[8px] tracking-normal text-slate-500">
            ⇧P
          </kbd>
        </button>

        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          title="View source on GitHub"
          aria-label="View source on GitHub"
          className="grid h-8 w-8 place-items-center rounded-lg border border-slate-700 bg-slate-900/70 text-slate-500 transition-colors duration-150 hover:border-slate-600 hover:text-slate-200"
        >
          <Github className="h-4 w-4" aria-hidden />
        </a>

        <span
          className={cn(
            'hidden h-8 items-center gap-1.5 rounded-lg border px-2 font-mono text-[9px] uppercase tracking-widest xl:flex',
            connectionMode === 'live'
              ? 'border-emerald-500/40 text-emerald-400'
              : 'border-slate-700 text-slate-500',
          )}
          title={`Data source: ${connectionMode}`}
        >
          <Zap className="h-3 w-3" aria-hidden />
          {connectionMode === 'live' ? 'tunnel' : 'synthetic'}
        </span>
      </div>
    </header>
  );
}

export default TopBar;