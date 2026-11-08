'use client';

/**
 * Developer performance overlay.
 *
 * Opened from the top bar or Shift+P. It polls the frame budget four times a
 * second. The canvas never pushes these numbers through React, so leaving the
 * panel open cannot become a second 60 Hz render loop.
 */

import { useEffect, useState, type ReactElement } from 'react';
import { X } from 'lucide-react';
import { useEdgeAuditorSnapshot } from '@/workers/edgeClassifierChannel';
import { readPerfReading } from '@/store/renderBudget';
import type { EdgeAuditorSnapshot } from '@/workers/edgeClassifierChannel';
import type { PerfFrameReading, PerfTelemetryHUDProps, PerfTransport } from '@/types/perf';
import { INSTANCED_POD_BATCHES, PERF_FPS_LOWER } from '@/types/perf';

const POLL_MS = 250;

function toneForFps(fps: number, paused: boolean): string {
  if (paused) {
    return 'text-slate-300';
  }
  if (fps < PERF_FPS_LOWER) {
    return 'text-rose-300';
  }
  if (fps < 50) {
    return 'text-amber-300';
  }
  return 'text-emerald-300';
}

function strokeForFps(fps: number): string {
  if (fps < PERF_FPS_LOWER) {
    return '#fb7185';
  }
  if (fps < 50) {
    return '#fbbf24';
  }
  return '#34d399';
}

function formatMs(value: number): string {
  return `${value.toFixed(1)} ms`;
}

function transportLabel(transport: PerfTransport): string {
  if (transport === 'sse') {
    return 'SSE';
  }
  if (transport === 'local') {
    return '本地模拟';
  }
  return '等待首帧';
}

function workerThread(view: EdgeAuditorSnapshot): { readonly state: string; readonly detail: string } {
  if (!view.attached) {
    return { state: '未挂载', detail: '线程未创建' };
  }
  if (view.engine === 'transformers') {
    return { state: '运行中', detail: 'Transformers.js' };
  }
  if (view.engine === 'vector') {
    return { state: '运行中', detail: '向量引擎兜底' };
  }
  return { state: '运行中', detail: '加载权重' };
}

function Sparkline({ samples }: { readonly samples: readonly number[] }): ReactElement {
  const width = 220;
  const height = 46;
  if (samples.length < 2) {
    return <p className="font-mono text-xs text-slate-400">采样中</p>;
  }
  let peak = PERF_FPS_LOWER;
  for (const sample of samples) {
    if (sample > peak) {
      peak = sample;
    }
  }
  const ceiling = Math.max(peak, 60);
  const step = width / (samples.length - 1);
  let path = '';
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    const x = index * step;
    const y = height - (sample / ceiling) * (height - 2) - 1;
    path += index === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  const floorY = height - (PERF_FPS_LOWER / ceiling) * (height - 2) - 1;
  const last = samples[samples.length - 1] ?? 0;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-12 w-full"
      role="img"
      aria-label={`帧率折线，最近一点 ${Math.round(last)} FPS，下限 ${PERF_FPS_LOWER}`}
    >
      <line
        x1="0"
        x2={width}
        y1={floorY}
        y2={floorY}
        stroke="#fb7185"
        strokeDasharray="3 3"
        strokeWidth="1"
      />
      <path d={path} fill="none" stroke={strokeForFps(last)} strokeWidth="1.6" />
    </svg>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}): ReactElement {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/60 px-2 py-2">
      <p className="font-mono text-[11px] uppercase tracking-widest text-slate-400">{label}</p>
      <p className="mt-1 font-mono text-sm text-slate-100">{value}</p>
      {hint !== undefined ? <p className="mt-0.5 font-mono text-[11px] text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function PerfTelemetryHUD({ onClose }: PerfTelemetryHUDProps): ReactElement {
  const [reading, setReading] = useState<PerfFrameReading>(() => readPerfReading());
  const worker = useEdgeAuditorSnapshot();

  useEffect(() => {
    const timer = window.setInterval(() => {
      setReading(readPerfReading());
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const thread = workerThread(worker);
  const savedDraws = Math.max(0, reading.activePodCount - INSTANCED_POD_BATCHES);
  const latency =
    reading.sseLatencyMs === null ? '—' : `${Math.round(reading.sseLatencyMs)} ms`;
  const dprLabel = reading.degraded ? '1.0' : '≤2';

  return (
    <section
      aria-label="开发者性能遥测"
      className="pointer-events-auto fixed bottom-36 left-3 z-40 w-[min(22rem,calc(100vw-1.5rem))] rounded-lg border border-slate-800 bg-slate-900/75 p-3 shadow-glow-cyan backdrop-blur-md"
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-100">性能遥测</h2>
          <p className="mt-0.5 font-mono text-[11px] text-slate-400">Shift+P · 开发者 HUD</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="隐藏性能遥测"
          className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md border border-slate-700 text-slate-200 outline-none ring-cyan-400 hover:border-slate-500 focus-visible:ring-2"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <span
          className={`rounded-full border px-2 py-1 font-mono text-[11px] ${
            reading.degraded
              ? 'border-amber-400/60 text-amber-200'
              : 'border-emerald-400/50 text-emerald-200'
          }`}
        >
          {reading.degraded ? `已降级 · dpr ${dprLabel} · 星尘 ${reading.sparkleCount}` : `满画质 · dpr ${dprLabel}`}
        </span>
        <span
          className={`rounded-full border px-2 py-1 font-mono text-[11px] ${
            reading.paused
              ? 'border-slate-600 text-slate-300'
              : 'border-cyan-400/40 text-cyan-200'
          }`}
        >
          {reading.paused ? '动画已暂停' : '动画运行中'}
        </span>
      </div>

      <div className="mt-3">
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-mono text-[11px] uppercase tracking-widest text-slate-400">FPS</p>
          <p className={`font-mono text-2xl tabular-nums ${toneForFps(reading.fps, reading.paused)}`}>
            {Math.round(reading.fps)}
            <span className="ml-1 text-xs text-slate-400">FPS</span>
          </p>
        </div>
        <Sparkline samples={reading.history} />
        <p className="font-mono text-[11px] text-slate-500">虚线为 {PERF_FPS_LOWER} FPS 下限</p>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Metric label="Frame Time" value={formatMs(reading.frameMs)} />
        <Metric
          label="WebGL Draw Calls"
          value={reading.history.length > 0 ? String(reading.drawCalls) : '—'}
          hint="上一帧 renderer.info"
        />
        <div className="col-span-2 rounded-md border border-cyan-400/40 bg-cyan-400/10 px-2 py-2">
          <p className="font-mono text-[11px] uppercase tracking-widest text-cyan-200">
            InstancedMesh 单批次
          </p>
          <p className="mt-1 font-mono text-sm text-cyan-50">
            {INSTANCED_POD_BATCHES} 次绘制承载 {reading.activePodCount} 个活跃 Pod
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-cyan-200/80">
            逐 Pod 绘制需要 {reading.activePodCount} 次，实例化省下 {savedDraws} 次 Draw Call
          </p>
        </div>
        <Metric label="活跃 Pod 实例" value={String(reading.activePodCount)} hint="不含 Pending" />
        <Metric
          label="SSE 遥测延迟"
          value={latency}
          hint={transportLabel(reading.transport)}
        />
        <div className="col-span-2 rounded-md border border-slate-800 bg-slate-950/60 px-2 py-2">
          <p className="font-mono text-[11px] uppercase tracking-widest text-slate-400">
            端侧 Web Worker
          </p>
          <p className="mt-1 font-mono text-sm text-slate-100">
            {thread.state}
            <span className="text-slate-400"> · {thread.detail}</span>
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-slate-500">
            权重缓存 {Math.round(worker.percent)}%
            {worker.webGpuAvailable ? ' · WebGPU 可用' : ' · WebAssembly SIMD'}
          </p>
        </div>
      </div>
    </section>
  );
}

export default PerfTelemetryHUD;
