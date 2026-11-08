'use client';

/**
 * KubeVision AI - generative pod telemetry card.
 *
 * Consumes `PodMetricsCardProps` with no mapping layer: the copilot tool result
 * is the props object. History is capped at the six-sample contract
 * (`TELEMETRY_HISTORY_LENGTH`) and drawn as one adaptive SVG, not a chart
 * library, so the card stays inside the copilot column without a canvas.
 */

import {
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';
import { Activity, AlertTriangle, Cpu, MemoryStick, Server } from 'lucide-react';
import type { PodMetricsCardProps } from '@/types/ai';
import type { PodStatus } from '@/types/cluster';

const HISTORY_LIMIT = 6;
const ALARM_THRESHOLD = 80;
const VIEW_W = 360;
const VIEW_H = 168;
const PAD = { left: 36, right: 12, top: 16, bottom: 22 } as const;

type SeriesKey = 'cpu' | 'mem';

interface ChartPoint {
  readonly x: number;
  readonly y: number;
  readonly value: number;
  readonly index: number;
}

interface StatusTone {
  readonly label: string;
  readonly className: string;
  readonly alarming: boolean;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}

function presentStatus(status: PodStatus): StatusTone {
  switch (status) {
    case 'Running':
      return {
        label: 'RUNNING',
        className: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-400',
        alarming: false,
      };
    case 'Pending':
      return {
        label: 'PENDING',
        className: 'border-amber-400/40 bg-amber-400/10 text-amber-400',
        alarming: false,
      };
    case 'Terminating':
      return {
        label: 'TERMINATING',
        className: 'border-slate-500/40 bg-slate-500/10 text-slate-300',
        alarming: false,
      };
    case 'CrashLoopBackOff':
      return {
        label: 'CRASHLOOPBACKOFF',
        className: 'border-rose-500/50 bg-rose-500/15 text-rose-400',
        alarming: true,
      };
    case 'OOMKilled':
      return {
        label: 'OOMKILLED',
        className: 'border-rose-500/50 bg-rose-500/15 text-rose-400',
        alarming: true,
      };
    default: {
      const exhaustive: never = status;
      return {
        label: exhaustive,
        className: 'border-slate-500/40 bg-slate-500/10 text-slate-300',
        alarming: false,
      };
    }
  }
}

function trailingSamples(values: readonly number[]): number[] {
  const start = Math.max(0, values.length - HISTORY_LIMIT);
  const samples: number[] = [];
  for (let index = start; index < values.length; index += 1) {
    const sample = values[index];
    if (sample === undefined) {
      continue;
    }
    samples.push(clampPercent(sample));
  }
  return samples;
}

function toPoints(samples: readonly number[]): ChartPoint[] {
  const plotW = VIEW_W - PAD.left - PAD.right;
  const plotH = VIEW_H - PAD.top - PAD.bottom;
  const span = Math.max(samples.length - 1, 1);
  const points: ChartPoint[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index];
    if (value === undefined) {
      continue;
    }
    const x =
      samples.length === 1
        ? PAD.left + plotW / 2
        : PAD.left + (plotW * index) / span;
    const y = PAD.top + plotH * (1 - value / 100);
    points.push({ x, y, value, index });
  }
  return points;
}

function linePath(points: readonly ChartPoint[]): string {
  let path = '';
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined) {
      continue;
    }
    const command = index === 0 ? 'M' : 'L';
    path += `${command}${point.x.toFixed(2)} ${point.y.toFixed(2)} `;
  }
  return path.trim();
}

function areaPath(points: readonly ChartPoint[]): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) {
    return '';
  }
  const baseline = VIEW_H - PAD.bottom;
  return `${linePath(points)} L${last.x.toFixed(2)} ${baseline.toFixed(2)} L${first.x.toFixed(2)} ${baseline.toFixed(2)} Z`;
}

function peakOf(samples: readonly number[]): number {
  let peak = 0;
  for (const sample of samples) {
    if (sample > peak) {
      peak = sample;
    }
  }
  return peak;
}

interface MeterProps {
  readonly label: string;
  readonly value: number;
  readonly icon: ReactElement;
}

function LoadMeter({ label, value, icon }: MeterProps): ReactElement {
  const safe = clampPercent(value);
  const alarm = safe > ALARM_THRESHOLD;
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-widest text-slate-300">
          {icon}
          {label}
        </span>
        <span
          className={`font-mono text-xs tabular-nums ${alarm ? 'text-rose-400' : 'text-slate-100'}`}
        >
          {safe.toFixed(1)}%{alarm ? ' 超限' : ''}
        </span>
      </div>
      <div
        className="relative h-2 overflow-hidden rounded-full bg-slate-800"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(safe)}
        aria-valuetext={alarm ? `${safe.toFixed(1)}%，超过 80% 报警阈值` : `${safe.toFixed(1)}%`}
      >
        <span
          className={`absolute inset-y-0 left-0 w-full origin-left rounded-full ${
            alarm
              ? 'bg-gradient-to-r from-amber-400 to-rose-500'
              : 'bg-gradient-to-r from-cyan-400 to-emerald-400'
          }`}
          style={{ transform: `scaleX(${safe / 100})` }}
        />
        <span
          className="absolute inset-y-0 w-px bg-slate-100/80"
          style={{ left: '80%' }}
          aria-hidden
        />
      </div>
      <p className="mt-1 font-mono text-xs uppercase tracking-widest text-slate-400">
        阈值 80
      </p>
    </div>
  );
}

export function PodMetricsCard(props: PodMetricsCardProps): ReactElement {
  const {
    podId,
    podName,
    namespace,
    nodeId,
    status,
    cpuUsage,
    memoryUsage,
    restarts,
    cpuHistory,
    memHistory,
    narrative,
    atRisk,
    onFocusPod,
  } = props;

  const rawId = useId().replace(/:/g, '');
  const cpuGradId = `${rawId}-cpu-area`;
  const memGradId = `${rawId}-mem-area`;
  const statusTone = presentStatus(status);
  const cpuSamples = useMemo(() => trailingSamples(cpuHistory), [cpuHistory]);
  const memSamples = useMemo(() => trailingSamples(memHistory), [memHistory]);
  const cpuPoints = useMemo(() => toPoints(cpuSamples), [cpuSamples]);
  const memPoints = useMemo(() => toPoints(memSamples), [memSamples]);
  const sampleCount = Math.max(cpuSamples.length, memSamples.length);
  const peak = peakOf([...cpuSamples, ...memSamples]);
  const peakAlarm = peak > ALARM_THRESHOLD;
  const plotH = VIEW_H - PAD.top - PAD.bottom;
  const peakY = PAD.top + plotH * (1 - peak / 100);
  const cpuAlarm = clampPercent(cpuUsage) > ALARM_THRESHOLD;
  const memAlarm = clampPercent(memoryUsage) > ALARM_THRESHOLD;
  const alarming = atRisk || statusTone.alarming || cpuAlarm || memAlarm;

  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, sampleCount - 1));
  const [pinnedSeries, setPinnedSeries] = useState<SeriesKey | null>(null);

  const safeIndex =
    sampleCount === 0 ? 0 : Math.min(activeIndex, sampleCount - 1);
  const activeCpu = cpuPoints[safeIndex];
  const activeMem = memPoints[safeIndex];

  const moveIndex = (next: number): void => {
    if (sampleCount === 0) {
      return;
    }
    const clamped = Math.min(sampleCount - 1, Math.max(0, next));
    setActiveIndex(clamped);
  };

  const onChartKey = (event: KeyboardEvent<SVGSVGElement>): void => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      moveIndex(safeIndex + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      moveIndex(safeIndex - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      moveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      moveIndex(sampleCount - 1);
    }
  };

  const onChartPointer = (event: PointerEvent<SVGSVGElement>): void => {
    if (sampleCount === 0) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) {
      return;
    }
    const localX = ((event.clientX - bounds.left) / bounds.width) * VIEW_W;
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    const probe = cpuPoints.length > 0 ? cpuPoints : memPoints;
    for (let index = 0; index < probe.length; index += 1) {
      const point = probe[index];
      if (point === undefined) {
        continue;
      }
      const distance = Math.abs(point.x - localX);
      if (distance < best) {
        best = distance;
        nearest = point.index;
      }
    }
    setActiveIndex(nearest);
  };

  const seriesOpacity = (key: SeriesKey): number => {
    if (pinnedSeries === null || pinnedSeries === key) {
      return 1;
    }
    return 0.28;
  };

  const readout =
    activeCpu !== undefined || activeMem !== undefined
      ? `周期 ${safeIndex + 1}/${Math.max(sampleCount, 1)} · CPU ${
          activeCpu !== undefined ? activeCpu.value.toFixed(1) : '—'
        }% · MEM ${activeMem !== undefined ? activeMem.value.toFixed(1) : '—'}%`
      : '近 6 个周期暂无样本';

  const gridLines = [0, 25, 50, 75, 100];

  return (
    <article
      className={`kv-panel overflow-hidden ${alarming ? 'shadow-glow-rose' : ''}`}
      aria-label={`${podName} 遥测快照`}
    >
      <header className="flex items-start justify-between gap-3 border-b border-slate-800 px-3 py-2.5">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-widest text-cyan-400">
            <Activity className="h-3.5 w-3.5" aria-hidden />
            pod telemetry
          </p>
          {onFocusPod === undefined ? (
            <h3 className="mt-1 truncate text-sm font-semibold text-slate-100" title={podName}>
              {podName}
            </h3>
          ) : (
            <h3 className="mt-1 truncate text-sm font-semibold text-slate-100">
              <button
                type="button"
                title={podName}
                aria-label={`在三维场景中聚焦 ${podName}`}
                onClick={() => onFocusPod(podId)}
                className="inline-flex min-h-11 max-w-full items-center truncate rounded-sm text-left text-cyan-300 underline decoration-cyan-400/40 underline-offset-4 outline-none ring-cyan-400 hover:text-cyan-200 focus-visible:ring-2"
              >
                {podName}
              </button>
            </h3>
          )}
          <p className="mt-0.5 truncate font-mono text-xs text-slate-400">
            {namespace}
            <span className="px-1 text-slate-600">/</span>
            <Server className="mr-1 inline h-3 w-3" aria-hidden />
            {nodeId}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span
            className={`rounded-full border px-2 py-1 font-mono text-xs tracking-widest ${statusTone.className} ${
              statusTone.alarming ? 'animate-pulse-glow' : ''
            }`}
          >
            {statusTone.label}
          </span>
          {atRisk ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/50 bg-rose-500/10 px-2 py-1 font-mono text-xs tracking-widest text-rose-400">
              <AlertTriangle className="h-3 w-3" aria-hidden />
              需关注
            </span>
          ) : null}
        </div>
      </header>

      <div className="space-y-3 px-3 py-3">
        <p className="font-mono text-xs uppercase tracking-widest text-slate-400">
          uid {podId}
          <span className="px-1.5 text-slate-700">·</span>
          restarts {restarts}
        </p>

        <div className="flex gap-3">
          <LoadMeter
            label="CPU"
            value={cpuUsage}
            icon={<Cpu className="h-3.5 w-3.5 text-cyan-400" aria-hidden />}
          />
          <LoadMeter
            label="Memory"
            value={memoryUsage}
            icon={<MemoryStick className="h-3.5 w-3.5 text-amber-400" aria-hidden />}
          />
        </div>

        <div className="flex gap-2">
          <SeriesToggle
            label="CPU"
            pressed={pinnedSeries === 'cpu'}
            onClick={() => setPinnedSeries((current) => (current === 'cpu' ? null : 'cpu'))}
          />
          <SeriesToggle
            label="MEM"
            pressed={pinnedSeries === 'mem'}
            onClick={() => setPinnedSeries((current) => (current === 'mem' ? null : 'mem'))}
          />
          <p className="ml-auto self-center font-mono text-xs tabular-nums text-slate-300" aria-live="polite">
            {readout}
          </p>
        </div>

        <div className="relative aspect-[360/168] w-full overflow-hidden rounded-md border border-slate-800 bg-slate-950/80">
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            className="h-full w-full touch-manipulation focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
            role="img"
            aria-label={`近 ${sampleCount} 个周期负载。峰值 ${peak.toFixed(1)}%。${readout}`}
            tabIndex={0}
            onKeyDown={onChartKey}
            onPointerMove={onChartPointer}
          >
            <defs>
              <linearGradient id={cpuGradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={cpuAlarm ? '#fb7185' : '#22d3ee'} stopOpacity="0.45" />
                <stop offset="100%" stopColor={cpuAlarm ? '#fb7185' : '#22d3ee'} stopOpacity="0" />
              </linearGradient>
              <linearGradient id={memGradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={memAlarm ? '#fb7185' : '#fbbf24'} stopOpacity="0.35" />
                <stop offset="100%" stopColor={memAlarm ? '#fb7185' : '#fbbf24'} stopOpacity="0" />
              </linearGradient>
            </defs>

            {gridLines.map((tick) => {
              const y = PAD.top + plotH * (1 - tick / 100);
              return (
                <g key={tick}>
                  <line
                    x1={PAD.left}
                    x2={VIEW_W - PAD.right}
                    y1={y}
                    y2={y}
                    stroke="rgb(51 65 85)"
                    strokeWidth="1"
                  />
                  <text
                    x={PAD.left - 6}
                    y={y + 3}
                    textAnchor="end"
                    fill="rgb(148 163 184)"
                    fontSize="11"
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
                  >
                    {tick}
                  </text>
                </g>
              );
            })}

            {cpuPoints.map((point) => (
              <line
                key={`grid-x-${point.index}`}
                x1={point.x}
                x2={point.x}
                y1={PAD.top}
                y2={VIEW_H - PAD.bottom}
                stroke="rgb(30 41 59)"
                strokeWidth="1"
              />
            ))}

            {sampleCount > 0 ? (
              <g>
                <line
                  x1={PAD.left}
                  x2={VIEW_W - PAD.right}
                  y1={peakY}
                  y2={peakY}
                  stroke={peakAlarm ? '#fb7185' : '#22d3ee'}
                  strokeWidth="1.25"
                  strokeDasharray="4 3"
                />
                <text
                  x={VIEW_W - PAD.right}
                  y={peakY < 28 ? peakY + 14 : peakY - 6}
                  textAnchor="end"
                  fill={peakAlarm ? '#fb7185' : '#67e8f9'}
                  fontSize="12"
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
                >
                  {`峰值 ${peak.toFixed(1)}%`}
                </text>
              </g>
            ) : (
              <text
                x={VIEW_W / 2}
                y={VIEW_H / 2}
                textAnchor="middle"
                fill="rgb(148 163 184)"
                fontSize="13"
              >
                近 6 个周期暂无样本
              </text>
            )}

            {memPoints.length > 0 ? (
              <g opacity={seriesOpacity('mem')}>
                <path d={areaPath(memPoints)} fill={`url(#${memGradId})`} />
                <path
                  d={linePath(memPoints)}
                  fill="none"
                  stroke={memAlarm ? '#fb7185' : '#fbbf24'}
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            ) : null}

            {cpuPoints.length > 0 ? (
              <g opacity={seriesOpacity('cpu')}>
                <path d={areaPath(cpuPoints)} fill={`url(#${cpuGradId})`} />
                <path
                  d={linePath(cpuPoints)}
                  fill="none"
                  stroke={cpuAlarm ? '#fb7185' : '#22d3ee'}
                  strokeWidth="2.25"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            ) : null}

            {activeCpu !== undefined ? (
              <circle cx={activeCpu.x} cy={activeCpu.y} r="3.5" fill="#22d3ee" />
            ) : null}
            {activeMem !== undefined ? (
              <circle cx={activeMem.x} cy={activeMem.y} r="3.5" fill="#fbbf24" />
            ) : null}
          </svg>
        </div>

        <table className="sr-only">
          <caption>近 6 个周期 CPU 与内存利用率</caption>
          <thead>
            <tr>
              <th>周期</th>
              <th>CPU</th>
              <th>Memory</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: sampleCount }, (_, index) => {
              const cpu = cpuSamples[index];
              const mem = memSamples[index];
              return (
                <tr key={index}>
                  <td>{index + 1}</td>
                  <td>{cpu !== undefined ? cpu.toFixed(1) : '—'}</td>
                  <td>{mem !== undefined ? mem.toFixed(1) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <p className="text-sm leading-6 text-slate-300">{narrative}</p>
      </div>
    </article>
  );
}

interface SeriesToggleProps {
  readonly label: string;
  readonly pressed: boolean;
  readonly onClick: () => void;
}

function SeriesToggle({ label, pressed, onClick }: SeriesToggleProps): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`min-h-11 min-w-11 rounded-md border px-3 font-mono text-xs tracking-widest touch-manipulation transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 ${
        pressed
          ? 'border-cyan-400/60 bg-cyan-400/10 text-cyan-300'
          : 'border-slate-700 bg-slate-900/80 text-slate-300 hover:border-slate-500 hover:text-slate-100'
      }`}
    >
      {label}
    </button>
  );
}
