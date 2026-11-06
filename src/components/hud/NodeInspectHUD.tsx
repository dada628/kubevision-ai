'use client';

/**
 * KubeVision AI - selected-entity inspection probe for the 3D viewport.
 *
 * ONE SURFACE, TWO STATES
 * The top-left corner of the viewport is the operator's "what am I looking at?"
 * slot. With nothing selected it shows the compact legend plus gesture hints;
 * with a pod or node selected the SAME slot grows into a glass probe card. Keeping
 * them in one component means the two states can share a corner, a transition and
 * a z-index instead of fighting over the same pixels.
 *
 * WHY THE CARD IS NOT A REACT TELEMETRY SUBSCRIBER
 * `cpuHistory` / `memHistory` are already detached copies on
 * `summary.selectedEntity` (refreshed at 1 Hz by `syncSummary`), so the sparklines
 * re-render once per second - not per frame. Nothing here reads
 * `telemetryTransientRef`, which keeps the 60 FPS canvas untouched.
 *
 * POINTER EVENTS
 * The wrapper is `pointer-events-none` so orbit/zoom still reach the canvas through
 * the empty part of its box; only the card and its buttons opt back in. Without
 * that, the card's container would be an invisible shield over the viewport corner.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity,
  Cpu,
  MemoryStick,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Waypoints,
} from 'lucide-react';
import type { PodEntity, WorkerNodeEntity } from '@/types/cluster';
import type { EntityType } from '@/types/store';
import {
  useClusterStore,
  useClusterSummary,
  useSelectedEntityId,
  useSelectedEntityType,
} from '@/store/useClusterStore';
import { getSnapshot } from '@/store/useTelemetryRef';

/* ==========================================================================
   Legend + gestures
   ========================================================================== */

interface LegendEntry {
  readonly label: string;
  /** Tailwind class for the dot; must match the 3D status palette. */
  readonly dot: string;
  readonly text: string;
}

/**
 * Three-way status legend, matching the canvas:
 * emerald = Running, amber = Pending, rose = faulty (CrashLoop / OOM).
 */
const LEGEND: readonly LegendEntry[] = [
  { label: 'Running', dot: 'bg-emerald-400', text: 'text-emerald-400' },
  { label: 'Pending', dot: 'bg-amber-400', text: 'text-amber-400' },
  { label: 'Faulty', dot: 'bg-rose-500', text: 'text-rose-500' },
];

/** Gesture cheatsheet. Left/right both matter, so they are listed explicitly. */
const GESTURES: readonly string[] = [
  '左键拖拽 · 旋转',
  '右键拖拽 · 平移',
  '点击实体 · 巡检',
];

/* ==========================================================================
   Sparkline
   ========================================================================== */

interface SparklineProps {
  /** Samples in [0, 100], oldest first. May be shorter than the view box. */
  readonly series: readonly number[];
  /** Stable DOM id for the gradient def (two sparklines share the document). */
  readonly gradientId: string;
  readonly stroke: string;
  readonly fillTop: string;
  readonly height: number;
}

/** View box width. Fixed so the path maths never depends on layout. */
const SPARK_WIDTH = 168;

/**
 * Pure-SVG area sparkline.
 *
 * WHY HAND-ROLLED AND NOT A CHART LIB
 * The whole widget is one closed path plus a gradient fill. A charting library
 * would add tens of kilobytes and a resize observer to draw twenty numbers.
 *
 * WHY A SMOOTH PATH (C, NOT L)
 * With only six history samples, straight segments read as a jagged sawtooth. A
 * Catmull-Rom-to-cubic conversion keeps the curve honest about the sample values
 * while removing the visual noise that makes a 6-point line look like an error.
 *
 * `preserveAspectRatio="none"` lets the path stretch to the CSS box: the SVG has a
 * fixed coordinate system, but the card is fluid, and a stretched sparkline is the
 * intended behaviour here (it is a trend, not a measurement instrument).
 */
function Sparkline({
  series,
  gradientId,
  stroke,
  fillTop,
  height,
}: SparklineProps): ReactElement {
  const geometry = useMemo(() => {
    /* Pad a short series by repeating its first value: a single spike from zero
       would draw a misleading cliff that the pod never experienced. */
    const samples = series.length === 0 ? [0] : series;
    const padded =
      samples.length === 1 ? [samples[0] ?? 0, samples[0] ?? 0] : samples;

    const maxIndex = Math.max(1, padded.length - 1);
    /* Clamp and normalise; a flat line at 50% must sit mid-box, not on the floor. */
    const points = padded.map((raw, index) => {
      const value = Math.min(100, Math.max(0, Number.isFinite(raw) ? raw : 0));
      const x = (index / maxIndex) * SPARK_WIDTH;
      /* Invert Y: 100% is the top of the box. Leave a small inset so the stroke is
         never clipped by the view box edge. */
      const y = height - 3 - (value / 100) * (height - 8);
      return { x, y };
    });

    /* Catmull-Rom -> cubic Bezier with a 1/6 tension, the standard conversion. */
    let d = '';
    for (let index = 0; index < points.length - 1; index += 1) {
      const p0 = points[index - 1] ?? points[0];
      const p1 = points[index] ?? points[0];
      const p2 = points[index + 1] ?? points[0];
      const p3 = points[index + 2] ?? p2 ?? p1;
      if (p0 === undefined || p1 === undefined || p2 === undefined || p3 === undefined) {
        continue;
      }
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }

    const first = points[0];
    const last = points[points.length - 1];
    const line = first === undefined || last === undefined
      ? ''
      : `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}${d}`;
    /* Close the path down the right edge, along the floor and back up the left, so
       the gradient fill has an area to shade. */
    const area = last === undefined || first === undefined
      ? ''
      : `${line} L ${last.x.toFixed(2)} ${height} L ${first.x.toFixed(2)} ${height} Z`;

    return { line, area };
  }, [series, height]);

  return (
    <svg
      viewBox={`0 0 ${SPARK_WIDTH} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-hidden
      className="h-9 w-full overflow-visible"
    >
      <defs>
        {/* Vertical gradient: visible at the top, transparent at the baseline, so
            overlapping series never muddy each other. */}
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fillTop} stopOpacity={0.55} />
          <stop offset="100%" stopColor={fillTop} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={geometry.area} fill={`url(#${gradientId})`} stroke="none" />
      <path
        d={geometry.line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/* ==========================================================================
   Status presentation
   ========================================================================== */

interface StatusBadge {
  readonly label: string;
  readonly className: string;
  /** Whether the badge carries the alarm pulse. */
  readonly alarming: boolean;
}

/** Maps every pod status onto a badge tone, mirroring the 3D palette. */
function presentPodStatus(status: PodEntity['status']): StatusBadge {
  switch (status) {
    case 'Running':
      return {
        label: 'RUNNING',
        className: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400',
        alarming: false,
      };
    case 'Pending':
      return {
        label: 'PENDING',
        className: 'border-amber-500/50 bg-amber-500/10 text-amber-400',
        alarming: false,
      };
    case 'Terminating':
      return {
        label: 'TERMINATING',
        className: 'border-slate-500/50 bg-slate-500/10 text-slate-300',
        alarming: false,
      };
    case 'CrashLoopBackOff':
      return {
        label: 'CRASHLOOPBACKOFF',
        className: 'border-rose-500/60 bg-rose-500/15 text-rose-400',
        alarming: true,
      };
    case 'OOMKilled':
      return {
        label: 'OOMKILLED',
        className: 'border-rose-500/60 bg-rose-500/15 text-rose-400',
        alarming: true,
      };
    default:
      return {
        label: String(status).toUpperCase(),
        className: 'border-slate-500/50 bg-slate-500/10 text-slate-300',
        alarming: false,
      };
  }
}

/** Node statuses. `HighLoad` is amber (capacity), `NetworkPartition` is rose. */
function presentNodeStatus(status: WorkerNodeEntity['status']): StatusBadge {
  switch (status) {
    case 'Ready':
      return {
        label: 'READY',
        className: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400',
        alarming: false,
      };
    case 'HighLoad':
      return {
        label: 'HIGH LOAD',
        className: 'border-amber-500/50 bg-amber-500/10 text-amber-400',
        alarming: false,
      };
    case 'NetworkPartition':
      return {
        label: 'PARTITION',
        className: 'border-rose-500/60 bg-rose-500/15 text-rose-400',
        alarming: true,
      };
    default:
      return {
        label: String(status).toUpperCase(),
        className: 'border-slate-500/50 bg-slate-500/10 text-slate-300',
        alarming: false,
      };
  }
}

/* ==========================================================================
   Shared row primitives
   ========================================================================== */

function InfoRow({
  label,
  value,
  mono = true,
  tone = 'text-slate-200',
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly tone?: string;
}): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest text-slate-500">
        {label}
      </span>
      <span
        className={`truncate text-right text-[11px] ${mono ? 'font-mono' : ''} ${tone}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

/* ==========================================================================
   Node history aggregation
   ========================================================================== */

/**
 * Mean per-sample history across every pod scheduled on `node`.
 *
 * WHY PER SAMPLE INDEX AND NOT A FLAT MEAN
 * The sparkline is a time series. Averaging all samples into one number would draw
 * a flat line; folding by index preserves the shared shape (a spike ripples into a
 * hump), which is what makes a node-level trend readable at all.
 *
 * Nodes with no pods return an empty series - the caller renders a flat baseline
 * rather than pretending to have data.
 */
function meanHistories(
  node: WorkerNodeEntity,
  key: 'cpuHistory' | 'memHistory',
): number[] {
  let length = 0;
  for (const podId of node.podIds) {
    const pod = findPodInSnapshot(podId);
    if (pod !== null && pod[key].length > length) {
      length = pod[key].length;
    }
  }
  if (length === 0) {
    return [];
  }

  const sums = new Array<number>(length).fill(0);
  const counts = new Array<number>(length).fill(0);
  for (const podId of node.podIds) {
    const pod = findPodInSnapshot(podId);
    if (pod === null) {
      continue;
    }
    const series = pod[key];
    /* Right-align short series so the newest sample always lands in the last slot;
       otherwise a freshly created pod would skew the recent half of the curve. */
    const offset = length - series.length;
    for (let index = 0; index < series.length; index += 1) {
      const target = offset + index;
      const value = series[index];
      if (value === undefined) {
        continue;
      }
      sums[target] = (sums[target] ?? 0) + value;
      counts[target] = (counts[target] ?? 0) + 1;
    }
  }

  return sums.map((sum, index) => {
    const count = counts[index] ?? 0;
    return count === 0 ? 0 : sum / count;
  });
}

/**
 * Reads one pod's live history out of the transient telemetry pool.
 *
 * WHY THE TRANSIENT POOL AND NOT THE SUMMARY
 * `summary.selectedEntity` only carries the SELECTED entity, so a node's pods are
 * not reachable through it. The transient pool is the source `syncSummary` copies
 * from, so the two can never disagree about a sample.
 *
 * This is called from `useMemo` (once per render, and only when a NODE is
 * selected), never from a frame loop, so it does not violate the zero-per-frame
 * allocation rule. The returned object is read, not retained.
 */
function findPodInSnapshot(podId: string): PodEntity | null {
  const live = getSnapshot();
  for (const pod of live.pods) {
    if (pod.id === podId) {
      return pod;
    }
  }
  return null;
}

/* ==========================================================================
   Probe card
   ========================================================================== */

interface ProbeProps {
  readonly entityType: EntityType;
  readonly pod: PodEntity | null;
  readonly node: WorkerNodeEntity | null;
}

/**
 * The glass probe card.
 *
 * Rendered only while an entity is selected; `AnimatePresence` in the parent keeps
 * the component mounted long enough to play the exit transition.
 */
function InspectProbe({ entityType, pod, node }: ProbeProps): ReactElement {
  /**
   * Transient feedback for the heal action.
   *
   * Local state is correct here: this is UI acknowledgement, not telemetry, and it
   * changes at most once per click.
   */
  const [healNotice, setHealNotice] = useState<string | null>(null);

  const healEntity = useClusterStore((state) => state.healEntity);
  const triggerQuickPrompt = useClusterStore((state) => state.triggerQuickPrompt);

  /* Clear the notice when the operator selects a different entity. */
  useEffect(() => {
    setHealNotice(null);
  }, [pod?.id, node?.id]);

  const target = pod ?? node;
  const name = target?.name ?? '—';
  const entityId = target?.id ?? '';
  const status = pod !== null ? presentPodStatus(pod.status) : node !== null ? presentNodeStatus(node.status) : null;

  /**
   * UID.
   *
   * The entity contracts deliberately carry no `uid` field - these are demo
   * entities, not API objects - so the id is presented as the stable identity and
   * labelled accordingly. Inventing a fake UUID would be worse than saying "ID".
   */
  const identityLabel = entityType === 'pod' ? 'UID' : 'NODE ID';
  const identityValue = entityId;

  /** Namespace for pods; the owning node's IP for nodes. */
  const contextLabel = entityType === 'pod' ? 'NAMESPACE' : 'NODE IP';
  const contextValue = pod !== null ? pod.namespace : node !== null ? node.ip : '—';

  /** The other half of the context row: which node a pod runs on, or pod count. */
  const peerLabel = entityType === 'pod' ? 'NODE' : 'PODS';
  const peerValue =
    pod !== null
      ? pod.nodeId
      : node !== null
        ? `${node.podIds.length} scheduled`
        : '—';

  const restarts = pod !== null ? pod.restarts : null;

  const handleDiagnose = useCallback(() => {
    if (entityId.length === 0) {
      return;
    }
    /* The copilot hook watches `quickPromptTrigger` for reference inequality, so a
       freshly built string is what wakes it - a boolean flag would be swallowed on
       the second identical request. */
    const kind = entityType === 'pod' ? 'Pod' : 'Node';
    const statusText = pod !== null ? pod.status : node !== null ? node.status : 'unknown';
    const cpuText = pod !== null ? `CPU ${pod.cpuUsage.toFixed(1)}%` : '';
    triggerQuickPrompt(
      [
        `请对 ${kind} ${name} 发起专项根因诊断。`,
        `ID: ${entityId};`,
        `状态: ${statusText};`,
        cpuText.length > 0 ? `${cpuText};` : '',
        restarts !== null ? `重启次数: ${restarts};` : '',
        '请结合最近的遥测走势与告警给出可执行的处置建议。',
      ]
        .filter((part) => part.length > 0)
        .join(' '),
    );
  }, [entityId, entityType, name, node, pod, restarts, triggerQuickPrompt]);

  const handleHeal = useCallback(() => {
    if (entityId.length === 0) {
      return;
    }
    /* A pod is restarted; a node is healed in place. `restart_pod` on a node id is
       rejected by the store's contract, so the branch is not cosmetic. */
    const action = entityType === 'pod' ? 'restart_pod' : 'auto_heal';
    healEntity(entityId, action);
    setHealNotice(action === 'restart_pod' ? '已下发重启指令' : '已下发节点自愈指令');
  }, [entityId, entityType, healEntity]);

  const cpuHistory = pod?.cpuHistory ?? [];
  const memHistory = pod?.memHistory ?? [];

  /**
   * A node has no history of its own - `WorkerNodeEntity` carries capacities, not
   * samples. Showing two empty sparklines would be a dead panel, so for a node the
   * series is the MEAN of its pod histories, computed per sample index.
   *
   * This is the same aggregation the 3D rack uses for its rails (mean of the hosted
   * pods), so the probe and the chassis behind it always agree.
   */
  const nodeSeries = useMemo(() => {
    if (node === null) {
      return { cpu: [] as number[], mem: [] as number[] };
    }
    return {
      cpu: meanHistories(node, 'cpuHistory'),
      mem: meanHistories(node, 'memHistory'),
    };
  }, [node]);

  const displayCpu = pod !== null ? cpuHistory : nodeSeries.cpu;
  const displayMem = pod !== null ? memHistory : nodeSeries.mem;

  /* For a node there are no per-pod histories, so the sparklines fall back to the
     node's own capacity utilisation read from its pods via the store summary. */
  return (
    <motion.section
      key={entityId}
      initial={{ opacity: 0, y: -8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.97 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className="pointer-events-auto w-[248px] overflow-hidden rounded-lg border border-slate-700/80 bg-slate-900/75 shadow-panel backdrop-blur-md"
      aria-label={`${entityType} inspector`}
    >
      {/* --------------------------------------------------------- header */}
      <header className="flex items-start justify-between gap-2 border-b border-slate-800/80 px-3 py-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-ultra-wide text-slate-500">
            {entityType === 'pod' ? (
              <Cpu className="h-2.5 w-2.5 text-cyan-400" aria-hidden />
            ) : (
              <Waypoints className="h-2.5 w-2.5 text-cyan-400" aria-hidden />
            )}
            {entityType === 'pod' ? 'pod probe' : 'node probe'}
          </p>
          <h3
            className="mt-0.5 truncate font-mono text-[12px] text-slate-100"
            title={name}
          >
            {name}
          </h3>
        </div>
        {status !== null ? (
          <span
            className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-widest ${status.className} ${
              status.alarming ? 'animate-pulse-glow' : ''
            }`}
          >
            {status.label}
          </span>
        ) : null}
      </header>

      {/* ----------------------------------------------------------- facts */}
      <div className="space-y-1 px-3 py-2">
        <InfoRow label={identityLabel} value={identityValue} tone="text-cyan-300" />
        <InfoRow label={contextLabel} value={contextValue} />
        <InfoRow label={peerLabel} value={peerValue} tone="text-slate-400" />
        {restarts !== null ? (
          <InfoRow
            label="RESTARTS"
            value={String(restarts)}
            tone={restarts > 0 ? 'text-rose-400' : 'text-slate-300'}
          />
        ) : null}
      </div>

      {/* ------------------------------------------------------ sparklines */}
      <div className="space-y-1.5 border-t border-slate-800/80 px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-widest text-slate-500">
            <Activity className="h-2.5 w-2.5 text-cyan-400" aria-hidden />
            cpu history
          </span>
          <span className="font-mono text-[9px] text-cyan-300">
            {pod !== null
              ? `${pod.cpuUsage.toFixed(1)}%`
              : node !== null
                ? `${node.cpuCapacity.toFixed(1)} cores`
                : `${displayCpu.length} pts`}
          </span>
        </div>
        <Sparkline
          series={displayCpu}
          gradientId="kv-spark-cpu"
          stroke="#22d3ee"
          fillTop="#22d3ee"
          height={36}
        />

        <div className="flex items-center justify-between pt-0.5">
          <span className="flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-widest text-slate-500">
            <MemoryStick className="h-2.5 w-2.5 text-violet-400" aria-hidden />
            mem history
          </span>
          <span className="font-mono text-[9px] text-violet-300">
            {pod !== null
              ? `${pod.memoryUsage.toFixed(1)}%`
              : node !== null
                ? `${node.memCapacity} MiB`
                : `${displayMem.length} pts`}
          </span>
        </div>
        <Sparkline
          series={displayMem}
          gradientId="kv-spark-mem"
          stroke="#a78bfa"
          fillTop="#a78bfa"
          height={36}
        />
      </div>

      {/* --------------------------------------------------------- actions */}
      <div className="space-y-1.5 border-t border-slate-800/80 px-3 py-2">
        <button
          type="button"
          onClick={handleDiagnose}
          className="flex w-full items-center justify-center gap-1.5 rounded border border-cyan-500/45 bg-cyan-500/10 px-2 py-1.5 font-mono text-[9px] uppercase tracking-widest text-cyan-300 transition-colors duration-150 hover:border-cyan-400 hover:bg-cyan-500/20 hover:text-cyan-200"
        >
          <Sparkles className="h-3 w-3 shrink-0" aria-hidden />
          交由 AI Copilot 根因诊断
        </button>

        <button
          type="button"
          onClick={handleHeal}
          className="flex w-full items-center justify-center gap-1.5 rounded border border-emerald-500/45 bg-emerald-500/10 px-2 py-1.5 font-mono text-[9px] uppercase tracking-widest text-emerald-300 transition-colors duration-150 hover:border-emerald-400 hover:bg-emerald-500/20 hover:text-emerald-200"
        >
          <RotateCcw className="h-3 w-3 shrink-0" aria-hidden />
          隔离并重启实例
        </button>

        <AnimatePresence>
          {healNotice === null ? null : (
            <motion.p
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18 }}
              className="flex items-center gap-1 font-mono text-[8px] uppercase tracking-widest text-emerald-400"
            >
              <ShieldAlert className="h-2.5 w-2.5" aria-hidden />
              {healNotice}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </motion.section>
  );
}

/* ==========================================================================
   Idle legend
   ========================================================================== */

function TopologyLegend(): ReactElement {
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="pointer-events-none w-[176px] rounded-lg border border-slate-800/80 bg-slate-900/70 px-2.5 py-2 backdrop-blur-md"
    >
      <p className="mb-1.5 flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-ultra-wide text-slate-500">
        <Waypoints className="h-2.5 w-2.5 text-cyan-400" aria-hidden />
        topology
      </p>

      <ul className="space-y-1">
        {LEGEND.map((entry) => (
          <li
            key={entry.label}
            className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-widest text-slate-400"
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${entry.dot}`}
              aria-hidden
            />
            {entry.label}
          </li>
        ))}
      </ul>

      <div className="mt-2 space-y-0.5 border-t border-slate-800/80 pt-1.5">
        {GESTURES.map((gesture) => (
          <p
            key={gesture}
            className="font-mono text-[8px] uppercase tracking-wider text-slate-600"
          >
            {gesture}
          </p>
        ))}
      </div>
    </motion.div>
  );
}

/* ==========================================================================
   NodeInspectHUD
   ========================================================================== */

/**
 * Top-left inspection HUD for the 3D viewport.
 *
 * Reads only DISCRETE store slices (`selectedEntityId`, `selectedEntityType`) and
 * the 1 Hz `summary.selectedEntity` copy, so it re-renders on selection and on the
 * telemetry tick - never per animation frame.
 */
export function NodeInspectHUD(): ReactElement {
  const selectedEntityId = useSelectedEntityId();
  const selectedEntityType = useSelectedEntityType();
  const summary = useClusterSummary();

  /* `summary.selectedEntity` is the detached snapshot the sparklines read. It can
     lag the id by up to one sync, and it is null for a master selection (the master
     has no probe card yet), so the card keys off BOTH. */
  const snapshot = summary.selectedEntity;

  const pod = snapshot?.type === 'pod' ? snapshot.entity : null;
  const node = snapshot?.type === 'node' ? snapshot.entity : null;

  /* Only pods and nodes get a probe card; the control plane keeps the legend. */
  const showProbe =
    selectedEntityId !== null &&
    (selectedEntityType === 'pod' || selectedEntityType === 'node') &&
    (pod !== null || node !== null);

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-20">
      <AnimatePresence mode="wait" initial={false}>
        {showProbe && selectedEntityType !== null ? (
          <InspectProbe
            key={`probe-${selectedEntityId ?? 'none'}`}
            entityType={selectedEntityType}
            pod={pod}
            node={node}
          />
        ) : (
          <TopologyLegend key="legend" />
        )}
      </AnimatePresence>
    </div>
  );
}

export default NodeInspectHUD;