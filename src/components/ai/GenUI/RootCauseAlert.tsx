'use client';

/**
 * KubeVision AI - generative root-cause card.
 *
 * Evidence is rendered as a chronological propagation tree (oldest cause at
 * the root) even though the payload lists the strongest signal first. Weights
 * stay on a stacked bar so contribution and time are not collapsed into one
 * ordering.
 */

import { useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { GitBranch, ShieldAlert } from 'lucide-react';
import type {
  EvidenceItem,
  RecommendedActionKind,
  RootCauseAlertProps,
} from '@/types/ai';
import type { IncidentSeverity } from '@/types/cluster';
import { getSnapshot } from '@/store/useTelemetryRef';

interface SeverityTone {
  readonly label: string;
  readonly className: string;
  readonly pulse: boolean;
}

const SOURCE_LABEL: Record<EvidenceItem['source'], string> = {
  metrics: '指标',
  logs: '日志',
  events: '事件',
  topology: '拓扑',
};

const ACTION_LABEL: Record<RecommendedActionKind, string> = {
  restart_pod: '重启隔离',
  scale_deployment: '重启扩缩容',
  drain_node: '节点排空',
  inspect_logs: '检查日志',
};

function presentSeverity(severity: IncidentSeverity): SeverityTone {
  switch (severity) {
    case 'P0':
      return {
        label: 'P0 CRITICAL',
        className: 'border-rose-500/60 bg-rose-500/15 text-rose-400 shadow-glow-rose',
        pulse: true,
      };
    case 'P1':
      return {
        label: 'P1 MAJOR',
        className: 'border-amber-400/50 bg-amber-400/10 text-amber-400 shadow-glow-amber',
        pulse: false,
      };
    case 'P2':
      return {
        label: 'P2 WATCH',
        className: 'border-cyan-400/40 bg-cyan-400/10 text-cyan-300',
        pulse: false,
      };
    default: {
      const exhaustive: never = severity;
      return {
        label: exhaustive,
        className: 'border-slate-600 bg-slate-800 text-slate-300',
        pulse: false,
      };
    }
  }
}

function clockLabel(iso: string): string {
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return match?.[1] ?? iso;
}

function humanizeSignal(signal: string): string {
  const spaced = signal.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced.length > 0 ? spaced : signal;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

interface ChainNode {
  readonly item: EvidenceItem;
  readonly origin: number;
}

function focusableTitle(
  title: string,
  onFocusPod: ((podId: string) => void) | undefined,
): ReactNode {
  if (onFocusPod === undefined) {
    return title;
  }
  const labels: { id: string; label: string }[] = [];
  for (const pod of getSnapshot().pods) {
    const label = pod.name.length > 0 ? pod.name : pod.id;
    if (label.length >= 4 && title.includes(label)) {
      labels.push({ id: pod.id, label });
    }
  }
  labels.sort((left, right) => right.label.length - left.label.length);
  if (labels.length === 0) {
    return title;
  }
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let guard = 0;
  while (cursor < title.length && guard < title.length) {
    guard += 1;
    let found: { id: string; label: string } | null = null;
    for (const entry of labels) {
      if (title.startsWith(entry.label, cursor)) {
        found = entry;
        break;
      }
    }
    if (found === null) {
      let next = title.length;
      for (const entry of labels) {
        const at = title.indexOf(entry.label, cursor + 1);
        if (at >= 0 && at < next) {
          next = at;
        }
      }
      nodes.push(title.slice(cursor, next));
      cursor = next;
      continue;
    }
    const target = found;
    const start = cursor;
    nodes.push(
      <button
        key={`${target.id}-${start}`}
        type="button"
        aria-label={`在三维场景中聚焦 ${target.label}`}
        onClick={() => onFocusPod(target.id)}
        className="inline-flex min-h-11 items-center rounded-sm text-left text-cyan-300 underline decoration-cyan-400/40 underline-offset-4 outline-none ring-cyan-400 hover:text-cyan-200 focus-visible:ring-2"
      >
        {target.label}
      </button>,
    );
    cursor += target.label.length;
  }
  return nodes;
}

export function RootCauseAlert(props: RootCauseAlertProps): ReactElement {
  const {
    incidentId,
    severity,
    title,
    rootCauseSummary,
    evidenceChain,
    recommendedActions,
    confidence,
    detectedAt,
    affectedIds,
    onFocusPod,
  } = props;

  const tone = presentSeverity(severity);
  const confidencePct = Math.round(clampUnit(confidence) * 100);

  const chain = useMemo<ChainNode[]>(() => {
    const tagged = evidenceChain.map((item, origin) => ({ item, origin }));
    tagged.sort((left, right) => {
      const leftMs = Date.parse(left.item.observedAt);
      const rightMs = Date.parse(right.item.observedAt);
      const leftOk = Number.isFinite(leftMs);
      const rightOk = Number.isFinite(rightMs);
      if (leftOk && rightOk && leftMs !== rightMs) {
        return leftMs - rightMs;
      }
      return left.origin - right.origin;
    });
    return tagged;
  }, [evidenceChain]);

  const [selected, setSelected] = useState(0);
  const [showAllAffected, setShowAllAffected] = useState(false);
  const stepRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = chain.length === 0 ? 0 : Math.min(selected, chain.length - 1);
  const activeOrigin = chain[selectedIndex]?.origin ?? -1;

  const focusStep = (index: number): void => {
    const next = Math.min(chain.length - 1, Math.max(0, index));
    setSelected(next);
    stepRefs.current[next]?.focus();
  };

  const onStepKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusStep(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusStep(index - 1);
    }
  };
  const visibleAffected = showAllAffected ? affectedIds : affectedIds.slice(0, 4);
  const hiddenAffected = Math.max(0, affectedIds.length - visibleAffected.length);

  return (
    <article className="kv-panel overflow-hidden" aria-label={`根因报告 ${incidentId}`}>
      <header className="space-y-2 border-b border-slate-800 px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-xs tracking-widest ${tone.className} ${
              tone.pulse ? 'animate-pulse-glow' : ''
            }`}
          >
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
            {tone.label}
          </span>
          <p className="text-right">
            <span className="block font-mono text-xs uppercase tracking-widest text-slate-400">
              置信度
            </span>
            <span className="font-mono text-sm tabular-nums text-cyan-300">{confidencePct}%</span>
          </p>
        </div>
        <h3 className="text-sm font-semibold leading-6 text-slate-100">{focusableTitle(title, onFocusPod)}</h3>
        <p className="text-sm leading-6 text-slate-300">{rootCauseSummary}</p>
        <p className="font-mono text-xs text-slate-400">
          检出 {clockLabel(detectedAt)}
          <span className="px-1.5 text-slate-600">·</span>
          {incidentId}
        </p>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-slate-800"
          role="meter"
          aria-label="根因置信度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={confidencePct}
        >
          <span
            className="block h-full origin-left rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400"
            style={{ transform: `scaleX(${confidencePct / 100})`, width: '100%' }}
          />
        </div>
      </header>

      <div className="px-3 py-3">
        <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-slate-300">
          <GitBranch className="h-3.5 w-3.5 text-cyan-400" aria-hidden />
          故障传播链路与关键证据链
        </h4>

        {chain.length === 0 ? (
          <p className="text-sm text-slate-400">证据链为空，无法展开传播路径。</p>
        ) : (
          <ol aria-label="故障传播链路与关键证据链">
            {chain.map((node, index) => {
              const active = index === selectedIndex;
              const weightPct = Math.round(clampUnit(node.item.weight) * 100);
              const isLast = index === chain.length - 1;
              return (
                <li key={`${node.item.signal}-${node.origin}`} className="relative pl-5">
                  {isLast ? null : (
                    <span
                      className="absolute bottom-0 left-0 top-3 w-px bg-slate-700"
                      aria-hidden
                    />
                  )}
                  <span
                    className={`absolute left-0 top-3 h-px w-3 ${active ? 'bg-cyan-400' : 'bg-slate-600'}`}
                    aria-hidden
                  />
                  <span
                    className={`absolute left-0 top-3 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border ${
                      active
                        ? 'border-cyan-300 bg-cyan-400'
                        : 'border-slate-500 bg-slate-900'
                    }`}
                    aria-hidden
                  />
                  <button
                    type="button"
                    ref={(node) => {
                      stepRefs.current[index] = node;
                    }}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => setSelected(index)}
                    onKeyDown={(event) => onStepKey(event, index)}
                    className={`mb-2 min-h-11 w-full rounded-md border px-2.5 py-2 text-left touch-manipulation transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 ${
                      active
                        ? 'border-cyan-400/50 bg-cyan-400/10'
                        : 'border-slate-800 bg-slate-950/40 hover:border-slate-600'
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs uppercase tracking-widest text-slate-400">
                        {String(index + 1).padStart(2, '0')}
                        <span className="px-1 text-slate-600">→</span>
                        {clockLabel(node.item.observedAt)}
                        <span className="px-1 text-slate-600">·</span>
                        {SOURCE_LABEL[node.item.source]}
                      </span>
                      <span className="font-mono text-xs tabular-nums text-slate-300">
                        权重 {weightPct}%
                      </span>
                    </span>
                    <span className="mt-1 block text-sm font-medium leading-5 text-slate-100">
                      {humanizeSignal(node.item.signal)}
                    </span>
                    <span className="mt-0.5 block text-sm leading-5 text-slate-300">
                      {node.item.detail}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}

        <h4 className="mb-1.5 mt-1 text-xs font-semibold uppercase tracking-widest text-slate-300">
          证据贡献
        </h4>
        <div className="flex h-2 overflow-hidden rounded-full bg-slate-800" aria-hidden>
          {evidenceChain.map((item, index) => (
            <span
              key={`${item.signal}-bar-${index}`}
              className={index === activeOrigin ? 'bg-cyan-400' : 'bg-slate-500'}
              style={{ width: `${clampUnit(item.weight) * 100}%` }}
            />
          ))}
        </div>
        <ul className="mt-2 space-y-1">
          {evidenceChain.map((item, index) => (
            <li key={`${item.signal}-legend-${index}`} className="flex justify-between gap-2 text-xs text-slate-300">
              <span className="truncate">{humanizeSignal(item.signal)}</span>
              <span className="shrink-0 font-mono tabular-nums">
                {Math.round(clampUnit(item.weight) * 100)}%
              </span>
            </li>
          ))}
        </ul>

        <h4 className="mb-1.5 mt-3 text-xs font-semibold uppercase tracking-widest text-slate-300">
          建议处置
        </h4>
        <ul className="space-y-1.5">
          {recommendedActions.map((action) => (
            <li
              key={`${action.kind}-${action.label}`}
              className="flex items-start justify-between gap-2 rounded-md border border-slate-800 bg-slate-950/50 px-2.5 py-2"
            >
              <span className="min-w-0">
                <span className="block text-sm text-slate-100">{action.label}</span>
                <span className="font-mono text-xs uppercase tracking-widest text-slate-400">
                  {ACTION_LABEL[action.kind]} · {action.kind}
                </span>
              </span>
              <span
                className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-xs tracking-widest ${
                  action.requiresConfirmation
                    ? 'border-amber-400/40 text-amber-300'
                    : 'border-slate-700 text-slate-400'
                }`}
              >
                {action.requiresConfirmation ? '需确认' : '只读'}
              </span>
            </li>
          ))}
        </ul>

        <h4 className="mb-1.5 mt-3 text-xs font-semibold uppercase tracking-widest text-slate-300">
          受影响对象
        </h4>
        <ul className="flex flex-wrap gap-1.5">
          {visibleAffected.map((id) => (
            <li
              key={id}
              className="max-w-full truncate rounded border border-slate-700 bg-slate-900/80 px-2 py-1 font-mono text-xs text-slate-300"
              title={id}
            >
              {id}
            </li>
          ))}
        </ul>
        {affectedIds.length > 4 ? (
          <button
            type="button"
            onClick={() => setShowAllAffected((open) => !open)}
            className="mt-2 min-h-11 rounded-md border border-slate-700 px-3 text-sm text-slate-200 touch-manipulation hover:border-cyan-400/50 hover:text-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
          >
            {showAllAffected ? '收起受影响对象' : `展开其余 ${hiddenAffected} 个对象`}
          </button>
        ) : null}
      </div>
    </article>
  );
}
