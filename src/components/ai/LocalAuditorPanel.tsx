'use client';

/**
 * On-device log privacy auditor.
 *
 * Reads the single classifier worker through `edgeClassifierChannel`. Raw lines
 * are posted into that worker and kept only so the operator can reveal them
 * locally. The cloud copilot receives the worker's sanitized line.
 */

import { useEffect, useState, type ReactElement } from 'react';
import { Eye, EyeOff, ShieldAlert, Timer } from 'lucide-react';
import { useClusterStore } from '@/store/useClusterStore';
import {
  EDGE_CLASSIFIER_MODEL_ID,
  REDACTION_MARKERS,
  type EdgeAuditLabel,
  type LocalAuditorPanelProps,
  type RedactionMarker,
} from '@/types/ai';
import {
  auditLiveClusterLogs,
  useEdgeAuditorSnapshot,
  type EdgeAuditCard,
  type EdgeAuditorSnapshot,
} from '@/workers/edgeClassifierChannel';

const AUTO_AUDIT_INTERVAL_MS = 4_000;

const BADGE_CLASS: Record<EdgeAuditLabel, string> = {
  CRITICAL_PANIC: 'border-rose-500/70 bg-rose-500/15 text-rose-100',
  RESOURCE_EXHAUSTED: 'border-amber-400/70 bg-amber-400/15 text-amber-100',
  NETWORK_TIMEOUT: 'border-cyan-400/60 bg-cyan-400/10 text-cyan-100',
  NORMAL_INFO: 'border-emerald-400/60 bg-emerald-400/10 text-emerald-200',
};

const MARKER_CLASS: Record<RedactionMarker, string> = {
  [REDACTION_MARKERS.ip]: 'bg-cyan-400/25 text-cyan-100',
  [REDACTION_MARKERS.token]: 'bg-rose-500/30 text-rose-100',
  [REDACTION_MARKERS.key]: 'bg-amber-400/25 text-amber-100',
  [REDACTION_MARKERS.email]: 'bg-cyan-400/15 text-cyan-50',
};

const MARKER_PATTERN = new RegExp(
  `(${Object.values(REDACTION_MARKERS)
    .map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})`,
  'g',
);

function isRedactionMarker(value: string): value is RedactionMarker {
  return (Object.values(REDACTION_MARKERS) as readonly string[]).includes(value);
}

function runtimeLabel(webGpuAvailable: boolean): string {
  return webGpuAvailable ? 'WebGPU Accelerated' : 'WebAssembly SIMD';
}

function engineCaption(view: EdgeAuditorSnapshot): string {
  if (view.engine === 'transformers') {
    return 'DistilBERT 会话已就绪';
  }
  if (view.engine === 'vector') {
    return '向量引擎兜底';
  }
  if (
    view.progressStatus === 'download' ||
    view.progressStatus === 'progress' ||
    view.progressStatus === 'initiate'
  ) {
    return '正在拉取权重';
  }
  return view.attached ? '等待端侧引擎' : '引擎尚未挂载';
}

function cacheReady(view: EdgeAuditorSnapshot): boolean {
  return (
    view.percent >= 100 &&
    (view.progressStatus === 'ready' || view.progressStatus === 'fallback')
  );
}

function averageLatency(view: EdgeAuditorSnapshot): string {
  if (view.inferenceCount === 0) {
    return '— ms / log';
  }
  return `${(view.inferenceSumMs / view.inferenceCount).toFixed(1)} ms / log`;
}

function canEscalate(label: EdgeAuditLabel): boolean {
  return label === 'CRITICAL_PANIC' || label === 'RESOURCE_EXHAUSTED';
}

function diagnosisPrompt(card: EdgeAuditCard): string {
  const percent = (card.confidence * 100).toFixed(1);
  const latency = card.inferenceMs.toFixed(2);
  return [
    '请仅根据以下已在浏览器端侧完成脱敏的容器日志做根因诊断。',
    '日志里的 [REDACTED_IP]、[MASKED_TOKEN]、[MASKED_KEY]、[REDACTED_EMAIL] 是本地遮蔽标记，请不要还原或猜测被遮蔽的原文。',
    `来源 Pod: ${card.podName}`,
    `命名空间: ${card.namespace}`,
    `端侧语义分类: ${card.label} ${percent}%`,
    `端侧推理耗时: ${latency} ms`,
    '脱敏后的安全日志:',
    card.sanitized,
  ].join('\n');
}

function HighlightedSafeLog({ text }: { readonly text: string }): ReactElement {
  const parts = text.split(MARKER_PATTERN);
  return (
    <p className="whitespace-pre-wrap break-all font-mono text-xs leading-5 text-slate-200">
      {parts.map((part, index) => {
        if (isRedactionMarker(part)) {
          return (
            <mark
              key={`${part}-${index}`}
              className={`rounded px-1 font-semibold ${MARKER_CLASS[part]}`}
            >
              {part}
            </mark>
          );
        }
        return <span key={`text-${index}`}>{part}</span>;
      })}
    </p>
  );
}

function StatusCard({ view }: { readonly view: EdgeAuditorSnapshot }): ReactElement {
  const percent = Math.max(0, Math.min(100, Math.round(view.percent)));
  const ready = cacheReady(view);
  return (
    <section
      aria-label="端侧引擎状态"
      className="shrink-0 rounded-lg border border-slate-800 bg-slate-900/75 p-3 backdrop-blur-md"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Runtime</p>
          <p className="mt-1 text-sm font-medium text-cyan-200">{runtimeLabel(view.webGpuAvailable)}</p>
        </div>
        <p
          className={`shrink-0 rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-widest ${
            view.engine === 'vector'
              ? 'border-amber-400/50 text-amber-200'
              : view.engine === 'transformers'
                ? 'border-emerald-400/50 text-emerald-200'
                : 'border-slate-700 text-slate-400'
          }`}
        >
          {engineCaption(view)}
        </p>
      </div>

      <p className="mt-3 font-mono text-[10px] uppercase tracking-widest text-slate-500">Model</p>
      <p className="mt-1 break-all font-mono text-xs leading-5 text-slate-200">{EDGE_CLASSIFIER_MODEL_ID}</p>

      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
            IndexedDB 权重缓存
          </span>
          <span className="font-mono text-xs text-cyan-200">{ready ? '100% Ready' : `${percent}%`}</span>
        </div>
        <div
          role="progressbar"
          aria-label="IndexedDB 权重缓存"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1.5 overflow-hidden rounded-full bg-slate-800"
        >
          <div
            className="h-full rounded-full bg-cyan-400 motion-reduce:transition-none transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-md border border-slate-800 bg-slate-950/60 px-2 py-2">
          <dt className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
            Masked Secrets Count
          </dt>
          <dd className="mt-1 font-mono text-lg text-cyan-200">{view.maskedSecrets}</dd>
          <dd className="font-mono text-[10px] text-slate-500">累计已脱敏敏感字段</dd>
        </div>
        <div className="rounded-md border border-slate-800 bg-slate-950/60 px-2 py-2">
          <dt className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-slate-500">
            <Timer className="h-3 w-3" aria-hidden />
            平均端侧推理延迟
          </dt>
          <dd className="mt-1 font-mono text-lg text-cyan-200">{averageLatency(view)}</dd>
        </div>
      </dl>

      <p className="mt-3 flex flex-wrap items-center gap-1.5 font-mono text-[10px] leading-4 text-slate-500">
        <span>高亮</span>
        <mark className={`rounded px-1 font-semibold ${MARKER_CLASS[REDACTION_MARKERS.ip]}`}>
          {REDACTION_MARKERS.ip}
        </mark>
        <mark className={`rounded px-1 font-semibold ${MARKER_CLASS[REDACTION_MARKERS.token]}`}>
          {REDACTION_MARKERS.token}
        </mark>
      </p>
    </section>
  );
}

function AuditCard({
  card,
  revealed,
  onToggle,
  onDiagnose,
}: {
  readonly card: EdgeAuditCard;
  readonly revealed: boolean;
  readonly onToggle: () => void;
  readonly onDiagnose: () => void;
}): ReactElement {
  const percent = (card.confidence * 100).toFixed(1);
  const showRaw = revealed && card.rawText.length > 0;
  return (
    <article className="rounded-lg border border-slate-800 bg-slate-900/75 p-3 backdrop-blur-md">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm text-slate-100">{card.podName}</p>
          <p className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">
            {card.namespace}
          </p>
        </div>
        <span
          className={`inline-flex max-w-full items-center rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-wide ${BADGE_CLASS[card.label]}`}
        >
          {card.label} {percent}%
        </span>
      </div>

      <p className="mt-2 font-mono text-[11px] text-slate-400">
        {card.engine === 'transformers' ? 'Transformers.js' : '向量引擎'}
        {' · '}
        {card.inferenceMs.toFixed(2)} ms
        {card.maskedCount > 0 ? ` · 本条遮蔽 ${card.maskedCount}` : ''}
      </p>

      <div className="mt-2 grid grid-cols-2 gap-1" role="group" aria-label={`${card.podName} 日志视图`}>
        <button
          type="button"
          aria-pressed={!showRaw}
          onClick={() => {
            if (showRaw) {
              onToggle();
            }
          }}
          className={`inline-flex min-h-11 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2 text-xs outline-none ring-cyan-400 focus-visible:ring-2 ${
            showRaw
              ? 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200'
              : 'border-cyan-400/50 bg-cyan-400/10 text-cyan-100'
          }`}
        >
          <EyeOff className="h-3.5 w-3.5" aria-hidden />
          本地脱敏
        </button>
        <button
          type="button"
          aria-pressed={showRaw}
          disabled={card.rawText.length === 0}
          onClick={() => {
            if (!showRaw) {
              onToggle();
            }
          }}
          className={`inline-flex min-h-11 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2 text-xs outline-none ring-cyan-400 focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40 ${
            showRaw
              ? 'border-rose-500/60 bg-rose-500/15 text-rose-100'
              : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200'
          }`}
        >
          <Eye className="h-3.5 w-3.5" aria-hidden />
          原始含敏感信息
        </button>
      </div>

      <div className="mt-2 rounded-md border border-slate-800 bg-slate-950/70 p-2">
        {showRaw ? (
          <>
            <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-rose-300">
              仅本机可见，不会发往云端
            </p>
            <p className="whitespace-pre-wrap break-all font-mono text-xs leading-5 text-rose-100">{card.rawText}</p>
          </>
        ) : (
          <HighlightedSafeLog text={card.sanitized.length > 0 ? card.sanitized : '（空日志）'} />
        )}
      </div>

      {canEscalate(card.label) ? (
        <button
          type="button"
          onClick={onDiagnose}
          className={`mt-2 inline-flex min-h-11 w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-3 text-left text-xs font-medium leading-snug outline-none ring-cyan-400 focus-visible:ring-2 ${
            card.label === 'CRITICAL_PANIC'
              ? 'border-rose-500/60 bg-rose-500/15 text-rose-50 hover:bg-rose-500/25'
              : 'border-amber-400/60 bg-amber-400/15 text-amber-50 hover:bg-amber-400/25'
          }`}
        >
          <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
          仅将脱敏摘要发送至云端 Copilot 深度诊断
        </button>
      ) : null}
    </article>
  );
}

export function LocalAuditorPanel({ onOpenCopilot }: LocalAuditorPanelProps): ReactElement {
  const view = useEdgeAuditorSnapshot();
  const [auto, setAuto] = useState(false);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!auto) {
      return;
    }
    auditLiveClusterLogs();
    const timer = window.setInterval(() => {
      auditLiveClusterLogs();
    }, AUTO_AUDIT_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [auto]);

  const toggleReveal = (requestId: string): void => {
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(requestId)) {
        next.delete(requestId);
      } else {
        next.add(requestId);
      }
      return next;
    });
  };

  const diagnose = (card: EdgeAuditCard): void => {
    useClusterStore.getState().triggerQuickPrompt(diagnosisPrompt(card));
    onOpenCopilot();
  };

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col gap-2 overflow-hidden" aria-label="Edge Log Auditor">
      <StatusCard view={view} />

      <div className="flex shrink-0 flex-col gap-2">
        <button
          type="button"
          onClick={() => {
            auditLiveClusterLogs();
          }}
          disabled={!view.attached}
          className="inline-flex min-h-11 w-full cursor-pointer items-center justify-center rounded-lg border border-cyan-400/50 bg-cyan-400/15 px-3 text-sm font-medium text-cyan-50 outline-none ring-cyan-400 hover:bg-cyan-400/25 focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          抓取并审计当前集群容器日志流
        </button>
        <button
          type="button"
          aria-pressed={auto}
          onClick={() => {
            setAuto((current) => !current);
          }}
          disabled={!view.attached && !auto}
          className={`inline-flex min-h-11 w-full cursor-pointer items-center justify-center rounded-lg border px-3 text-sm outline-none ring-cyan-400 focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40 ${
            auto
              ? 'border-emerald-400/60 bg-emerald-400/15 text-emerald-100'
              : 'border-slate-700 text-slate-200 hover:border-slate-500'
          }`}
        >
          {auto ? '停止自动周期审计 · 4s' : '开启自动周期审计 · 4s'}
        </button>
        <p role="status" className="font-mono text-[11px] leading-5 text-slate-400">
          {view.pending.length > 0 ? `送审中 ${view.pending.length} 条` : '空闲'}
          {` · 已返回 ${view.cards.length} 条`}
          {view.lastNotice !== null ? ` · ${view.lastNotice}` : ''}
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1">
        {view.pending.map((item) => (
          <article
            key={item.requestId}
            className="rounded-lg border border-dashed border-slate-700 bg-slate-900/40 px-3 py-3"
          >
            <p className="truncate font-mono text-sm text-slate-200">{item.podName}</p>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-cyan-300">审计中</p>
          </article>
        ))}
        {view.cards.map((card) => (
          <AuditCard
            key={card.requestId}
            card={card}
            revealed={revealed.has(card.requestId)}
            onToggle={() => {
              toggleReveal(card.requestId);
            }}
            onDiagnose={() => {
              diagnose(card);
            }}
          />
        ))}
        {view.cards.length === 0 && view.pending.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-800 px-3 py-6 text-center text-sm leading-6 text-slate-400">
            尚未审计。抓取当前集群容器日志后，端侧分类和脱敏结果会显示在这里。
          </p>
        ) : null}
      </div>
    </section>
  );
}

export default LocalAuditorPanel;
