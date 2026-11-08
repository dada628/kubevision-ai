'use client';

/**
 * Copilot column. Every send, including a HUD quick prompt, posts the live
 * scene from `readChatClusterContext` so the route diagnoses the 3D viewport
 * the operator is looking at.
 */

import { useEffect, type FormEvent, type KeyboardEvent, type ReactElement } from 'react';
import { useChat, type Message } from 'ai/react';
import { Loader2, SendHorizontal, Square } from 'lucide-react';
import { ActionConfirm } from '@/components/ai/GenUI/ActionConfirm';
import { GenUISkeleton } from '@/components/ai/GenUI/GenUISkeleton';
import { PodMetricsCard } from '@/components/ai/GenUI/PodMetricsCard';
import { RootCauseAlert } from '@/components/ai/GenUI/RootCauseAlert';
import { readChatClusterContext } from '@/components/ai/readChatClusterContext';
import {
  useActiveChaos,
  useClusterStore,
  useClusterSummary,
  useSelectedEntityId,
} from '@/store/useClusterStore';
import type { ActionConfirmProps, PodMetricsCardProps, RootCauseAlertProps } from '@/types/ai';

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

function ToolCard({ tool }: { readonly tool: ToolView }): ReactElement {
  if (tool.state !== 'result') {
    return <GenUISkeleton toolName={tool.toolName} />;
  }
  if (tool.toolName === 'renderPodMetrics' && isPodMetricsCard(tool.result)) {
    return <PodMetricsCard {...tool.result} />;
  }
  if (tool.toolName === 'renderRootCauseAnalysis' && isRootCauseAlert(tool.result)) {
    return <RootCauseAlert {...tool.result} />;
  }
  if (tool.toolName === 'proposeRemediationAction' && isActionConfirm(tool.result)) {
    return <ActionConfirm {...tool.result} />;
  }
  return (
    <p className="rounded-lg border border-slate-800 bg-slate-900/75 px-3 py-2 text-xs text-slate-400" role="status">
      {tool.toolName} 的结果无法渲染成卡片。
    </p>
  );
}

function MessageView({ message }: { readonly message: Message }): ReactElement {
  const parts = message.parts ?? [];
  if (parts.length === 0) {
    return <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-200">{message.content}</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {parts.map((part, index) => {
        if (part.type === 'text') {
          if (part.text.length === 0) {
            return null;
          }
          return (
            <p key={`${message.id}-text-${index}`} className="whitespace-pre-wrap text-xs leading-relaxed text-slate-200">
              {part.text}
            </p>
          );
        }
        if (part.type === 'tool-invocation') {
          const tool = asToolView(part.toolInvocation);
          if (tool === null) {
            return null;
          }
          return <ToolCard key={tool.toolCallId} tool={tool} />;
        }
        return null;
      })}
    </div>
  );
}

export function CopilotPanel(): ReactElement {
  const selectedEntityId = useSelectedEntityId();
  const activeChaos = useActiveChaos();
  const abnormalPodCount = useClusterSummary().abnormalPodCount;
  const quickPrompt = useClusterStore((state) => state.quickPromptTrigger);
  const consumeQuickPrompt = useClusterStore((state) => state.consumeQuickPrompt);

  const { messages, input, handleInputChange, handleSubmit, append, status, stop, error } = useChat({
    api: '/api/chat',
    experimental_prepareRequestBody: ({ messages: nextMessages }) => ({
      messages: nextMessages,
      clusterContext: readChatClusterContext(),
    }),
  });

  useEffect(() => {
    if (quickPrompt === null || quickPrompt.length === 0) {
      return;
    }
    consumeQuickPrompt();
    void append({ role: 'user', content: quickPrompt });
  }, [append, consumeQuickPrompt, quickPrompt]);

  const busy = status === 'submitted' || status === 'streaming';
  const selectionLabel = selectedEntityId ?? '无';

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    handleSubmit(event);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col gap-3" aria-label="AI Copilot">
      <p className="rounded-lg border border-slate-800 bg-slate-900/75 px-3 py-2 text-xs leading-relaxed text-slate-300 backdrop-blur-md">
        每次发送都会附带当前场景：选中{' '}
        <span className="font-mono text-cyan-300">{selectionLabel}</span>
        ，混沌 <span className="font-mono text-amber-300">{activeChaos}</span>
        ，非 Running Pod <span className="font-mono text-rose-300">{abnormalPodCount}</span>
        。超过 80% 的 Pod 也会一并写入异常列表。
      </p>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain pr-1" aria-live="polite">
        {messages.length === 0 ? (
          <p className="text-xs leading-relaxed text-slate-400">
            询问当前异常、根因或自愈动作。右侧检查器里的「根因诊断」也会带着选中实体发到这里。
          </p>
        ) : (
          messages.map((message) => (
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
              <MessageView message={message} />
            </article>
          ))
        )}
        {error !== undefined ? (
          <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200" role="alert">
            对话请求失败：{error.message}
          </p>
        ) : null}
      </div>

      <form className="flex shrink-0 flex-col gap-2" onSubmit={onSubmit}>
        <label htmlFor="copilot-prompt" className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
          诊断问题
        </label>
        <textarea
          id="copilot-prompt"
          value={input}
          onChange={handleInputChange}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder="例如：诊断当前选中的 Pod"
          className="min-h-11 w-full resize-y rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs leading-relaxed text-slate-100 outline-none ring-cyan-400 placeholder:text-slate-600 focus:ring-2"
        />
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={busy || input.trim().length === 0}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-cyan-400/40 bg-cyan-400/15 px-4 text-xs font-medium text-cyan-200 outline-none ring-cyan-400 focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <SendHorizontal className="h-4 w-4" aria-hidden />}
            发送
          </button>
          {busy ? (
            <button
              type="button"
              onClick={stop}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-700 px-4 text-xs text-slate-200 outline-none ring-cyan-400 focus:ring-2"
            >
              <Square className="h-4 w-4" aria-hidden />
              停止
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
