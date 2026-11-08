'use client';

/**
 * KubeVision SRE copilot drawer.
 *
 * The right-hand column of the command surface. Every send, including a HUD
 * quick prompt and the bound-entity capsule, posts the live scene from
 * `readChatClusterContext`. Tool calls hydrate into the generative cards while
 * their arguments are still streaming, and a pod name in a finished card flies
 * the topology camera to that pod.
 */

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode } from 'react';
import { useChat, type Message } from 'ai/react';
import { Eraser, Loader2, Lock, SendHorizontal, Square, TriangleAlert } from 'lucide-react';
import { ActionConfirm } from '@/components/ai/GenUI/ActionConfirm';
import { GenUISkeleton } from '@/components/ai/GenUI/GenUISkeleton';
import { PodMetricsCard } from '@/components/ai/GenUI/PodMetricsCard';
import { RootCauseAlert } from '@/components/ai/GenUI/RootCauseAlert';
import { readChatClusterContext } from '@/components/ai/readChatClusterContext';
import { useActiveChaos, useClusterStore, useClusterSummary } from '@/store/useClusterStore';
import type { ActionConfirmProps, PodMetricsCardProps, RootCauseAlertProps } from '@/types/ai';

/** Composer block height. The transcript takes whatever remains above the handle. */
const COMPOSER_MIN_PX = 88;
const COMPOSER_MAX_PX = 360;
const COMPOSER_DEFAULT_PX = 156;
const TRANSCRIPT_MIN_PX = 120;
const RESIZE_HANDLE_PX = 32;
const COMPOSER_HEIGHT_KEY = 'kv-copilot-composer-height';

function clampComposerHeight(height: number, max: number): number {
  const upper = Math.max(COMPOSER_MIN_PX, max);
  return Math.min(upper, Math.max(COMPOSER_MIN_PX, Math.round(height)));
}

const ACTION_CHIPS = [
  { id: 'inspect', label: '全面巡检当前集群异常' },
  { id: 'oom', label: '诊断 OOMKilled 根因并生成自愈方案' },
  { id: 'balance', label: '分析各 Worker 节点负载均衡度' },
  { id: 'net', label: '评估当前网络吞吐瓶颈' },
] as const;

const INPUT_MAX_PX = 144;

/** Request ids already copied into the composer. Survives a strict-mode remount. */
const handledQuickPromptIds = new Set<number>();
/** Heal receipts already written into the transcript. */
const handledHealReceiptIds = new Set<number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPodMetricsCard(value: unknown): value is PodMetricsCardProps {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.podId === 'string' &&
    typeof value.podName === 'string' &&
    typeof value.namespace === 'string' &&
    typeof value.nodeId === 'string' &&
    typeof value.status === 'string' &&
    typeof value.cpuUsage === 'number' &&
    typeof value.memoryUsage === 'number' &&
    typeof value.restarts === 'number' &&
    Array.isArray(value.cpuHistory) &&
    Array.isArray(value.memHistory) &&
    typeof value.narrative === 'string' &&
    typeof value.atRisk === 'boolean'
  );
}

function isRootCauseAlert(value: unknown): value is RootCauseAlertProps {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.incidentId === 'string' &&
    typeof value.severity === 'string' &&
    typeof value.title === 'string' &&
    typeof value.rootCauseSummary === 'string' &&
    Array.isArray(value.evidenceChain) &&
    Array.isArray(value.recommendedActions) &&
    typeof value.confidence === 'number' &&
    typeof value.detectedAt === 'string' &&
    Array.isArray(value.affectedIds)
  );
}

function isActionConfirm(value: unknown): value is ActionConfirmProps {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.requestId === 'string' &&
    typeof value.actionType === 'string' &&
    typeof value.targetId === 'string' &&
    typeof value.targetLabel === 'string' &&
    typeof value.executionState === 'string' &&
    typeof value.rationale === 'string' &&
    typeof value.impactDescription === 'string'
  );
}

interface ToolView {
  readonly state: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: unknown;
}

function asToolView(value: object): ToolView | null {
  if (!('state' in value) || !('toolCallId' in value) || !('toolName' in value)) {
    return null;
  }
  const state = value.state;
  const toolCallId = value.toolCallId;
  const toolName = value.toolName;
  if (typeof state !== 'string' || typeof toolCallId !== 'string' || typeof toolName !== 'string') {
    return null;
  }
  const result = 'result' in value ? value.result : undefined;
  return { state, toolCallId, toolName, result };
}

function inlineText(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let cursor = 0;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(
        <strong key={`${match.index}-b`} className="font-semibold text-slate-50">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(
        <code key={`${match.index}-c`} className="rounded bg-slate-800 px-1 font-mono text-xs text-cyan-200">
          {token.slice(1, -1)}
        </code>,
      );
    }
    cursor = match.index + token.length;
    match = pattern.exec(text);
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes;
}

function RichText({ text }: { readonly text: string }): ReactElement {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="space-y-2 text-sm leading-6 text-slate-200">
      {blocks.map((block, index) => {
        const trimmed = block.trim();
        if (trimmed.length === 0) {
          return null;
        }
        if (trimmed.startsWith('## ')) {
          return (
            <h4 key={`h-${index}`} className="text-sm font-semibold leading-6 text-cyan-200">
              {inlineText(trimmed.slice(3))}
            </h4>
          );
        }
        return (
          <p key={`p-${index}`} className="whitespace-pre-wrap">
            {inlineText(trimmed)}
          </p>
        );
      })}
    </div>
  );
}

function ToolCard({
  tool,
  onFocusPod,
}: {
  readonly tool: ToolView;
  readonly onFocusPod: (podId: string) => void;
}): ReactElement {
  if (tool.state !== 'result') {
    return <GenUISkeleton toolName={tool.toolName} />;
  }
  if (tool.toolName === 'renderPodMetrics' && isPodMetricsCard(tool.result)) {
    return <PodMetricsCard {...tool.result} onFocusPod={onFocusPod} />;
  }
  if (tool.toolName === 'renderRootCauseAnalysis' && isRootCauseAlert(tool.result)) {
    return <RootCauseAlert {...tool.result} onFocusPod={onFocusPod} />;
  }
  if (tool.toolName === 'proposeRemediationAction' && isActionConfirm(tool.result)) {
    return <ActionConfirm {...tool.result} onFocusPod={onFocusPod} />;
  }
  return (
    <p className="rounded-lg border border-slate-800 bg-slate-900/75 px-3 py-2 text-sm text-slate-400" role="status">
      {tool.toolName} 的结果无法渲染成卡片。
    </p>
  );
}

function MessageBody({
  message,
  onFocusPod,
}: {
  readonly message: Message;
  readonly onFocusPod: (podId: string) => void;
}): ReactElement {
  const parts = message.parts ?? [];
  const seen = new Set<string>();
  const nodes: ReactElement[] = [];
  if (parts.length === 0 && message.content.length > 0) {
    nodes.push(<RichText key="content" text={message.content} />);
  }
  parts.forEach((part, index) => {
    if (part.type === 'text' && part.text.length > 0) {
      nodes.push(<RichText key={`text-${index}`} text={part.text} />);
    }
    if (part.type === 'tool-invocation') {
      const tool = asToolView(part.toolInvocation);
      if (tool !== null) {
        seen.add(tool.toolCallId);
        nodes.push(<ToolCard key={tool.toolCallId} tool={tool} onFocusPod={onFocusPod} />);
      }
    }
  });
  for (const invocation of message.toolInvocations ?? []) {
    const tool = asToolView(invocation);
    if (tool !== null && !seen.has(tool.toolCallId)) {
      nodes.push(<ToolCard key={tool.toolCallId} tool={tool} onFocusPod={onFocusPod} />);
    }
  }
  return <div className="flex flex-col gap-3">{nodes}</div>;
}

export function CopilotDrawer(): ReactElement {
  const summary = useClusterSummary();
  const selected = summary.selectedEntity;
  const activeChaos = useActiveChaos();
  const faultCount = summary.podStatusCounts.OOMKilled + summary.podStatusCounts.CrashLoopBackOff;
  const chaosActive = activeChaos !== 'NONE';
  const anomalyCount = faultCount > 0 ? faultCount : chaosActive ? Math.max(summary.abnormalPodCount, 1) : 0;
  const showAnomaly = anomalyCount > 0;
  const anomalyCritical = faultCount > 0;
  const quickPrompt = useClusterStore((state) => state.quickPromptTrigger);
  const consumeQuickPrompt = useClusterStore((state) => state.consumeQuickPrompt);
  const triggerQuickPrompt = useClusterStore((state) => state.triggerQuickPrompt);
  const healReceipt = useClusterStore((state) => state.healReceipt);
  const consumeHealReceipt = useClusterStore((state) => state.consumeHealReceipt);
  const focusEntity = useClusterStore((state) => state.focusEntity);

  const { messages, input, handleInputChange, handleSubmit, append, status, stop, error, setMessages, setInput } =
    useChat({
      api: '/api/chat',
      experimental_prepareRequestBody: ({ messages: nextMessages }) => ({
        messages: nextMessages,
        clusterContext: readChatClusterContext(),
      }),
    });

  const scrollerRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const busy = status === 'submitted' || status === 'streaming';
  const online = error === undefined;
  const boundName = selected?.entity.name ?? null;

  const [composerHeight, setComposerHeight] = useState(COMPOSER_DEFAULT_PX);
  const [splitHeight, setSplitHeight] = useState(0);
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);

  const composerMax = splitHeight === 0
    ? COMPOSER_MAX_PX
    : Math.max(COMPOSER_MIN_PX, splitHeight - RESIZE_HANDLE_PX - TRANSCRIPT_MIN_PX);
  const composerPx = clampComposerHeight(composerHeight, composerMax);

  useEffect(() => {
    const stored = window.localStorage.getItem(COMPOSER_HEIGHT_KEY);
    const parsed = stored === null ? Number.NaN : Number(stored);
    if (Number.isFinite(parsed)) {
      setComposerHeight(clampComposerHeight(parsed, COMPOSER_MAX_PX));
    }
  }, []);

  useEffect(() => {
    const split = splitRef.current;
    if (split === null) {
      return;
    }
    const measure = (): void => {
      setSplitHeight(split.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(split);
    return () => {
      observer.disconnect();
    };
  }, []);

  const commitComposerHeight = (height: number): void => {
    const next = clampComposerHeight(height, composerMax);
    setComposerHeight(next);
    window.localStorage.setItem(COMPOSER_HEIGHT_KEY, String(next));
  };

  const onResizePointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: composerPx,
    };
  };

  const onResizePointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) {
      return;
    }
    /* The grip sits on top of the composer. Pointer Y and the grip move together:
       dragging down shortens the composer, dragging up lengthens it. */
    setComposerHeight(clampComposerHeight(drag.startHeight - (event.clientY - drag.startY), composerMax));
  };

  const onResizePointerUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    commitComposerHeight(drag.startHeight - (event.clientY - drag.startY));
  };

  const onResizeKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      commitComposerHeight(composerPx + step);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      commitComposerHeight(composerPx - step);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      commitComposerHeight(composerMax);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      commitComposerHeight(COMPOSER_MIN_PX);
    }
  };

  useEffect(() => {
    if (quickPrompt === null) {
      return;
    }
    if (handledQuickPromptIds.has(quickPrompt.id)) {
      consumeQuickPrompt();
      return;
    }
    handledQuickPromptIds.add(quickPrompt.id);
    const prompt = quickPrompt.prompt;
    consumeQuickPrompt();
    setInput(prompt);
    window.setTimeout(() => {
      stop();
      void append({ role: 'user', content: prompt });
      setInput('');
    }, 0);
  }, [append, consumeQuickPrompt, quickPrompt, setInput, stop]);

  useEffect(() => {
    if (healReceipt === null) {
      return;
    }
    if (handledHealReceiptIds.has(healReceipt.id)) {
      consumeHealReceipt();
      return;
    }
    handledHealReceiptIds.add(healReceipt.id);
    const summaryText = healReceipt.summary;
    const receiptId = healReceipt.id;
    consumeHealReceipt();
    setMessages((current) => [
      ...current,
      {
        id: `heal-receipt-${receiptId}`,
        role: 'system',
        content: summaryText,
        createdAt: new Date(),
      },
    ]);
  }, [consumeHealReceipt, healReceipt, setMessages]);

  useEffect(() => {
    if (status === 'submitted') {
      pinnedToBottomRef.current = true;
    }
  }, [status]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const transcript = transcriptRef.current;
    if (scroller === null || transcript === null) {
      return;
    }

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let lastTop = scroller.scrollTop;
    let stalled = 0;

    const distanceFromBottom = (): number =>
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;

    const tick = (): void => {
      if (!pinnedToBottomRef.current) {
        frame = 0;
        return;
      }
      const distance = distanceFromBottom();
      if (distance <= 1) {
        frame = 0;
        stalled = 0;
        lastTop = scroller.scrollTop;
        return;
      }
      const moved = scroller.scrollTop !== lastTop;
      lastTop = scroller.scrollTop;
      const catchUp = motionQuery.matches || distance > 180 || stalled >= 2;
      if (!moved || catchUp) {
        const behavior: ScrollBehavior = catchUp ? 'auto' : 'smooth';
        scroller.scrollTo({ top: scroller.scrollHeight, behavior });
      }
      stalled = moved ? 0 : stalled + 1;
      frame = window.requestAnimationFrame(tick);
    };

    const scheduleAnchor = (): void => {
      if (frame !== 0) {
        return;
      }
      frame = window.requestAnimationFrame(tick);
    };

    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0) {
        pinnedToBottomRef.current = false;
        return;
      }
      if (distanceFromBottom() < 48) {
        pinnedToBottomRef.current = true;
        scheduleAnchor();
      }
    };

    let touchY = 0;
    const onTouchStart = (event: TouchEvent): void => {
      touchY = event.touches[0]?.clientY ?? touchY;
    };
    const onTouchMove = (event: TouchEvent): void => {
      const nextY = event.touches[0]?.clientY ?? touchY;
      if (nextY > touchY + 8) {
        pinnedToBottomRef.current = false;
      }
      touchY = nextY;
    };

    const observer = new ResizeObserver(scheduleAnchor);
    observer.observe(transcript);
    scroller.addEventListener('wheel', onWheel, { passive: true });
    scroller.addEventListener('touchstart', onTouchStart, { passive: true });
    scroller.addEventListener('touchmove', onTouchMove, { passive: true });
    scheduleAnchor();

    return () => {
      observer.disconnect();
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('touchstart', onTouchStart);
      scroller.removeEventListener('touchmove', onTouchMove);
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

  useEffect(() => {
    const field = inputRef.current;
    if (field === null) {
      return;
    }
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, INPUT_MAX_PX)}px`;
  }, [input]);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    handleSubmit(event);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const ask = (prompt: string): void => {
    if (busy || prompt.trim().length === 0) {
      return;
    }
    void append({ role: 'user', content: prompt });
  };

  const launchAnomalyDiagnosis = (): void => {
    triggerQuickPrompt(
      '检测到容器实例异常，请立即启动 SRE 根因分析：给出异常 Pod 的实时指标、根因证据链，以及需要人工确认的自愈指令。',
    );
  };

  const diagnoseBound = (): void => {
    if (selected === null) {
      return;
    }
    const kind = selected.type === 'node' ? 'Node' : selected.type === 'master' ? 'Master' : 'Pod';
    ask(`请对 ${kind} ${selected.entity.name} 发起专项根因诊断。ID: ${selected.entity.id}`);
  };

  const clearSession = (): void => {
    stop();
    setMessages([]);
    setInput('');
  };

  const focusPod = (podId: string): void => {
    focusEntity(podId, 'pod');
  };

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden" aria-label="KubeVision SRE Copilot">
      <header className="shrink-0 space-y-2 border-b border-slate-800 pb-2">
        {showAnomaly ? (
          <div
            role="status"
            className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 ${
              anomalyCritical
                ? 'animate-pulse-glow border-rose-500/60 bg-rose-500/15 shadow-glow-rose'
                : 'animate-pulse-glow border-amber-400/60 bg-amber-400/15 shadow-glow-amber'
            }`}
          >
            <TriangleAlert
              className={`h-4 w-4 shrink-0 ${anomalyCritical ? 'text-rose-300' : 'text-amber-300'}`}
              aria-hidden
            />
            <p className={`min-w-0 flex-1 text-sm leading-6 ${anomalyCritical ? 'text-rose-100' : 'text-amber-100'}`}>
              检测到 {anomalyCount} 个容器实例异常，是否立即启动 SRE 根因分析？
            </p>
            <button
              type="button"
              onClick={launchAnomalyDiagnosis}
              className={`inline-flex min-h-11 shrink-0 items-center rounded-lg border px-3 text-sm font-medium outline-none ring-cyan-400 focus-visible:ring-2 ${
                anomalyCritical
                  ? 'border-rose-300/50 bg-rose-500/20 text-rose-50 hover:bg-rose-500/30'
                  : 'border-amber-300/50 bg-amber-400/20 text-amber-50 hover:bg-amber-400/30'
              }`}
            >
              一键启动诊断
            </button>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold tracking-wide text-slate-100">KubeVision SRE Copilot</h2>
          <p className="mt-1 flex items-center gap-1.5 font-mono text-xs uppercase tracking-widest text-slate-400">
            <span
              className={`h-2 w-2 rounded-full ${online ? 'bg-emerald-400 shadow-glow-emerald' : 'bg-rose-500 shadow-glow-rose'}`}
              aria-hidden
            />
            <span className={online ? 'text-emerald-300' : 'text-rose-300'}>{online ? '在线' : '中断'}</span>
            {busy ? <span className="text-cyan-300">· 生成中</span> : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {selected === null || boundName === null ? (
            <p className="inline-flex min-h-11 items-center rounded-full border border-slate-800 bg-slate-900/75 px-3 font-mono text-xs text-slate-500">
              未绑定实体
            </p>
          ) : (
            <button
              type="button"
              onClick={diagnoseBound}
              disabled={busy}
              title={boundName}
              aria-label={`快速诊断已绑定的 ${boundName}`}
              className="inline-flex min-h-11 max-w-[10rem] items-center gap-1.5 rounded-full border border-cyan-400/50 bg-cyan-400/10 px-3 font-mono text-xs text-cyan-200 outline-none ring-cyan-400 hover:bg-cyan-400/20 focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">{boundName}</span>
            </button>
          )}
          <button
            type="button"
            onClick={clearSession}
            disabled={messages.length === 0 && !busy}
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-xs text-slate-200 outline-none ring-cyan-400 hover:border-slate-500 focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Eraser className="h-4 w-4" aria-hidden />
            清空会话
          </button>
        </div>
        </div>
      </header>

      <div ref={splitRef} className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-y-auto overflow-anchor-none overscroll-contain py-3"
      >
        <div ref={transcriptRef} className="flex flex-col gap-3" aria-live="polite">
        {messages.length === 0 ? (
          <p className="text-sm leading-6 text-slate-400">
            询问当前异常、根因或自愈动作。点上方青色标签，或点检查器里的「根因诊断」，都会带上当前绑定的实体。
          </p>
        ) : (
          messages.map((message) => {
            if (message.role === 'system') {
              return (
                <article
                  key={message.id}
                  role="status"
                  className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 shadow-glow-emerald"
                >
                  <p className="font-mono text-xs uppercase tracking-widest text-emerald-300">系统 · 自愈验证</p>
                  <p className="mt-1 text-sm leading-6 text-emerald-50">{message.content}</p>
                </article>
              );
            }
            return (
            <article
              key={message.id}
              className={
                message.role === 'user'
                  ? 'rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2'
                  : 'flex flex-col gap-3'
              }
            >
              <p className="font-mono text-xs uppercase tracking-widest text-slate-500">
                {message.role === 'user' ? '你' : 'SRE'}
              </p>
              <MessageBody message={message} onFocusPod={focusPod} />
            </article>
            );
          })
        )}
        {error !== undefined ? (
          <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200" role="alert">
            对话请求失败：{error.message}
          </p>
        ) : null}
        </div>
      </div>

      <button
        type="button"
        role="separator"
        aria-orientation="horizontal"
        aria-label="拖动调整聊天正文高度"
        title="分隔条跟随指针"
        aria-valuemin={COMPOSER_MIN_PX}
        aria-valuemax={Math.round(composerMax)}
        aria-valuenow={composerPx}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        onKeyDown={onResizeKeyDown}
        className="group flex h-8 w-full shrink-0 cursor-row-resize touch-none items-center justify-center outline-none ring-cyan-400 focus-visible:ring-2"
      >
        <span className="h-1 w-10 rounded-full bg-slate-700 transition-colors duration-150 group-hover:bg-cyan-400 group-focus-visible:bg-cyan-400" />
      </button>

      <form
        className="shrink-0 space-y-2 overflow-y-auto overscroll-contain border-t border-slate-800 pt-3"
        style={{ height: composerPx }}
        onSubmit={onSubmit}
      >
        <div className="flex flex-nowrap gap-2 overflow-x-auto overscroll-contain pb-1" aria-label="快捷指令">
          {ACTION_CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              disabled={busy}
              onClick={() => ask(chip.label)}
              className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-slate-700 bg-slate-900/75 px-3 text-left text-sm leading-5 text-slate-200 outline-none ring-cyan-400 hover:border-cyan-400/50 hover:text-cyan-100 focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {chip.label}
            </button>
          ))}
        </div>
        <label htmlFor="sre-copilot-prompt" className="block font-mono text-xs uppercase tracking-widest text-slate-500">
          诊断问题
        </label>
        <textarea
          ref={inputRef}
          id="sre-copilot-prompt"
          value={input}
          rows={1}
          onChange={handleInputChange}
          onKeyDown={onKeyDown}
          placeholder="例如：诊断当前选中的 Pod"
          className="max-h-36 min-h-11 w-full resize-none overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm leading-6 text-slate-100 outline-none ring-cyan-400 placeholder:text-slate-600 focus:ring-2"
        />
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={busy || input.trim().length === 0}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-cyan-400/40 bg-cyan-400/15 px-4 text-sm font-medium text-cyan-100 outline-none ring-cyan-400 focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <SendHorizontal className="h-4 w-4" aria-hidden />}
            发送
          </button>
          {busy ? (
            <button
              type="button"
              onClick={stop}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-700 px-4 text-sm text-slate-200 outline-none ring-cyan-400 focus-visible:ring-2"
            >
              <Square className="h-4 w-4" aria-hidden />
              停止
            </button>
          ) : null}
        </div>
      </form>
      </div>
    </section>
  );
}
