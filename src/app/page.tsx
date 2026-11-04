import type { Metadata } from 'next';
import type { ReactElement } from 'react';
import { cn } from '@/utils/cn';

export const metadata: Metadata = {
  title: 'Cluster Situational Awareness',
};

interface StatusPillProps {
  readonly label: string;
  readonly tone: 'healthy' | 'elevated' | 'critical' | 'idle';
  readonly value: string;
}

const toneClass: Record<StatusPillProps['tone'], string> = {
  healthy: 'kv-status-healthy',
  elevated: 'kv-status-elevated',
  critical: 'kv-status-critical',
  idle: 'kv-status-idle',
};

function StatusPill({ label, tone, value }: StatusPillProps): ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/75 px-3 py-2 backdrop-blur-md">
      <span className="font-mono text-[10px] uppercase tracking-ultra-wide text-slate-500">
        {label}
      </span>
      <span className={cn('kv-status-pill', toneClass[tone])}>{value}</span>
    </div>
  );
}

const BOOT_MARKERS: readonly string[] = [
  'App Router mounting in src/app',
  'Tailwind dark tokens registered from tailwind.config.ts',
  'bg-cyber-grid utility available for HUD surfaces',
  'shadow-glow-cyan / glow-emerald / glow-rose wired',
  'R3F 60FPS canvas slot reserved for the next milestone',
];

export default function HomePage(): ReactElement {
  return (
    <main className="relative isolate flex min-h-screen flex-1 flex-col overflow-hidden bg-cyber-grid">
      <div className="pointer-events-none absolute inset-0 bg-void-bloom" aria-hidden />
      <div className="kv-grid-overlay" aria-hidden />

      <header className="relative z-10 flex items-center justify-between border-b border-slate-800/80 px-6 py-4 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg border border-cyan-500/30 bg-cyan-500/10 font-mono text-sm font-semibold text-cyan-400 shadow-glow-cyan">
            KV
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold tracking-wide text-slate-100">
              KubeVision AI
            </p>
            <p className="font-mono text-[10px] uppercase tracking-ultra-wide text-slate-500">
              Cloud-Native 3D Situational Awareness
            </p>
          </div>
        </div>
        <span className="kv-status-pill kv-status-healthy">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          theme online
        </span>
      </header>

      <section className="relative z-10 mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center gap-8 px-6 py-16">
        <div className="space-y-4">
          <p className="font-mono text-[11px] uppercase tracking-ultra-wide text-cyan-400/80">
            milestone 01 - theme foundation
          </p>
          <h1 className="font-display text-4xl font-semibold leading-tight tracking-tight text-slate-50 sm:text-5xl">
            Deep space command surface
            <span className="block text-cyan-400 text-glow-cyan">
              for Kubernetes telemetry
            </span>
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-slate-400">
            The engineering base is in place: strict TypeScript contract, Tailwind
            deep-space palette, HUD glass panels and glow semantics. The WebGL
            topology canvas and the on-device copilot mount into the reserved
            slots next.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatusPill label="pods" tone="healthy" value="128 ready" />
          <StatusPill label="nodes" tone="idle" value="6 online" />
          <StatusPill label="cpu" tone="elevated" value="78%" />
          <StatusPill label="alerts" tone="critical" value="2 critical" />
        </div>

        <div className="kv-panel">
          <div className="kv-panel-header">
            <span>bootstrap checklist</span>
            <span className="font-mono text-slate-600">v0.1.0</span>
          </div>
          <ul className="divide-y divide-slate-800/70">
            {BOOT_MARKERS.map((marker) => (
              <li
                key={marker}
                className="flex items-center gap-3 px-4 py-3 text-sm text-slate-300"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 shadow-glow-emerald" />
                <span className="font-mono text-xs tracking-wide">{marker}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap gap-3">
          <span className="rounded-lg border border-slate-800 bg-slate-900/75 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-emerald-400 shadow-glow-emerald">
            healthy
          </span>
          <span className="rounded-lg border border-slate-800 bg-slate-900/75 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-amber-400 shadow-glow-amber">
            elevated
          </span>
          <span className="rounded-lg border border-slate-800 bg-slate-900/75 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-rose-500 shadow-glow-rose">
            critical
          </span>
          <span className="rounded-lg border border-slate-800 bg-slate-900/75 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-cyan-400 shadow-glow-cyan">
            stream
          </span>
        </div>
      </section>
    </main>
  );
}
