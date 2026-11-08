'use client';

/**
 * KubeVision AI - skeleton for an in-flight generative UI tool call.
 *
 * Mount this while the model is still streaming a tool's arguments and the
 * payload cannot be parsed yet. The silhouette follows the tool name when
 * enough of it has arrived; a partial or missing name stays on the generic
 * diagnostic frame so the column does not jump when the name token completes.
 *
 * Motion is CSS only. Nothing here reads the store or allocates per frame.
 */

import type { ReactElement } from 'react';
import { Sparkles } from 'lucide-react';
import type { GenUISkeletonProps } from '@/types/ai';

type SkeletonKind = 'metrics' | 'cause' | 'action' | 'generic';

function resolveKind(toolName: string | undefined): SkeletonKind {
  if (toolName === undefined) {
    return 'generic';
  }
  const normalized = toolName.replace(/[^a-z]/gi, '').toLowerCase();
  if (normalized.startsWith('podmetric')) {
    return 'metrics';
  }
  if (normalized.startsWith('rootcause')) {
    return 'cause';
  }
  if (normalized.startsWith('actionconfirm')) {
    return 'action';
  }
  return 'generic';
}

function displayName(toolName: string | undefined): string {
  if (toolName === undefined) {
    return 'tool call';
  }
  const trimmed = toolName.trim();
  return trimmed.length > 0 ? trimmed : 'tool call';
}

interface BoneProps {
  readonly className: string;
}

function Bone({ className }: BoneProps): ReactElement {
  return (
    <span
      className={`relative block overflow-hidden rounded bg-slate-800/90 ${className}`}
      aria-hidden
    >
      <span className="kv-genui-gleam absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-cyan-300/80 to-transparent" />
    </span>
  );
}

function MetricsSilhouette(): ReactElement {
  return (
    <div className="space-y-3" aria-hidden>
      <div className="flex gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Bone className="h-3 w-16" />
          <Bone className="h-2 w-full" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <Bone className="h-3 w-20" />
          <Bone className="h-2 w-full" />
        </div>
      </div>
      <div className="relative aspect-[360/168] overflow-hidden rounded-md border border-slate-800 bg-slate-950/80">
        <div className="absolute inset-3 flex flex-col justify-between">
          <Bone className="h-px w-full" />
          <Bone className="h-px w-full" />
          <Bone className="h-px w-full" />
          <Bone className="h-px w-full" />
        </div>
      </div>
      <Bone className="h-3 w-4/5" />
    </div>
  );
}

function CauseSilhouette(): ReactElement {
  return (
    <div className="space-y-2" aria-hidden>
      <Bone className="h-3 w-2/3" />
      <Bone className="h-12 w-full" />
      <Bone className="h-12 w-full" />
      <Bone className="h-12 w-5/6" />
    </div>
  );
}

function ActionSilhouette(): ReactElement {
  return (
    <div className="space-y-3" aria-hidden>
      <div className="grid grid-cols-3 gap-2">
        <Bone className="h-11" />
        <Bone className="h-11" />
        <Bone className="h-11" />
      </div>
      <Bone className="h-3 w-1/2" />
      <Bone className="h-14 w-full" />
      <Bone className="h-11 w-full" />
    </div>
  );
}

function GenericSilhouette(): ReactElement {
  return (
    <div className="space-y-2" aria-hidden>
      <Bone className="h-3 w-3/5" />
      <Bone className="h-3 w-full" />
      <Bone className="h-3 w-4/5" />
      <Bone className="h-16 w-full" />
    </div>
  );
}

export function GenUISkeleton({ toolName }: GenUISkeletonProps): ReactElement {
  const kind = resolveKind(toolName);
  const name = displayName(toolName);

  return (
    <article
      className="kv-panel relative overflow-hidden"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={`正在流式生成 ${name} 的工具参数`}
    >
      <span className="kv-genui-scan" aria-hidden />
      <header className="relative flex items-center justify-between gap-3 border-b border-slate-800 px-3 py-2.5">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-widest text-cyan-400">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            streaming tool args
          </p>
          <p className="mt-1 truncate font-mono text-sm text-slate-100" title={name}>
            {name}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-cyan-400/40 bg-cyan-400/10 px-2 py-1 font-mono text-xs tracking-widest text-cyan-300">
          生成中
        </span>
      </header>
      <div className="relative px-3 py-3">
        {kind === 'metrics' ? <MetricsSilhouette /> : null}
        {kind === 'cause' ? <CauseSilhouette /> : null}
        {kind === 'action' ? <ActionSilhouette /> : null}
        {kind === 'generic' ? <GenericSilhouette /> : null}
        <p className="mt-3 text-xs leading-5 text-slate-400">
          工具参数仍在流入，卡片会在参数闭合后替换这块骨架。
        </p>
      </div>
      <span className="sr-only">
        大模型正在流式生成 Tool Calling 参数，诊断卡片尚未完成。
      </span>
    </article>
  );
}
