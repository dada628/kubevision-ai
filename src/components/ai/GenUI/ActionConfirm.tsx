'use client';

/**
 * KubeVision AI - human-in-the-loop self-heal confirm card.
 *
 * The copilot never mutates the cluster. This card waits for an explicit
 * click, plays an 800ms stream, then calls `healEntity`. `drain_node` stays
 * disabled until the blast-radius checkbox is checked. The success lock is
 * only shown after the live snapshot actually returns to Running / Ready.
 */

import { useEffect, useId, useState, type ReactElement } from 'react';
import { Check, OctagonAlert, ShieldAlert } from 'lucide-react';
import {
  CONFIRMABLE_ACTION_TYPES,
  type ActionConfirmProps,
  type ActionExecutionState,
  type ConfirmableActionType,
} from '@/types/ai';
import { useClusterStore } from '@/store/useClusterStore';
import { getSnapshot, HEAL_CPU_CEILING } from '@/store/useTelemetryRef';

const HEAL_STREAM_MS = 800;

const SUCCESS_LOCK_LABEL = '✓ 已成功下发 Kube-API 并完成自愈验证';

interface ActionMeta {
  readonly title: string;
  readonly summary: string;
}

const ACTION_META: Record<ConfirmableActionType, ActionMeta> = {
  restart_pod: {
    title: '重启隔离',
    summary: '删除并重建目标 Pod，重启计数加一。',
  },
  scale_deployment: {
    title: '重启扩缩容',
    summary: '把负载分摊到更多副本，单 Pod 利用率回落。',
  },
  drain_node: {
    title: '节点排空',
    summary: '排空节点并恢复其上全部 Pod 为运行态。',
  },
};

type LocalPhase = 'ready' | 'streaming' | 'locked' | 'failed' | 'cancelled';

function phaseFromExecution(state: ActionExecutionState): LocalPhase {
  switch (state) {
    case 'succeeded':
      return 'locked';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'idle':
    case 'pending_confirmation':
    case 'executing':
      return 'ready';
  }
}

function resolveScaleTargets(targetId: string): string[] {
  const pods = getSnapshot().pods;
  for (const pod of pods) {
    if (pod.id === targetId || pod.name === targetId) {
      return [pod.id];
    }
  }
  const prefix = `${targetId}-`;
  const replicas: string[] = [];
  for (const pod of pods) {
    if (pod.id.startsWith(prefix) || pod.name.startsWith(prefix)) {
      replicas.push(pod.id);
    }
  }
  return replicas;
}

function podRecovered(podId: string): boolean {
  const pod = getSnapshot().pods.find((item) => item.id === podId);
  return (
    pod !== undefined &&
    pod.status === 'Running' &&
    pod.cpuUsage < HEAL_CPU_CEILING
  );
}

/**
 * Issues `healEntity` for the concrete pod or node ids behind this card.
 * Returns false when the live pool does not contain the target, so the card
 * cannot claim a green recovery that the 3D scene did not perform.
 */
function dispatchHeal(targetId: string, actionType: ConfirmableActionType): boolean {
  const heal = useClusterStore.getState().healEntity;

  if (actionType === 'drain_node') {
    const node = getSnapshot().nodes.find((item) => item.id === targetId);
    heal(targetId, actionType);
    if (node === undefined) {
      return false;
    }
    const hosted = getSnapshot().pods.filter((pod) => pod.nodeId === targetId);
    const nodeReady = getSnapshot().nodes.find((item) => item.id === targetId)?.status === 'Ready';
    return nodeReady && hosted.every((pod) => podRecovered(pod.id));
  }

  if (actionType === 'restart_pod') {
    const exists = getSnapshot().pods.some((pod) => pod.id === targetId);
    heal(targetId, actionType);
    return exists && podRecovered(targetId);
  }

  const replicas = resolveScaleTargets(targetId);
  if (replicas.length === 0) {
    heal(targetId, actionType);
    return false;
  }
  for (const replicaId of replicas) {
    heal(replicaId, actionType);
  }
  return replicas.every((replicaId) => podRecovered(replicaId));
}

export function ActionConfirm(props: ActionConfirmProps): ReactElement {
  const {
    requestId,
    actionType,
    targetId,
    targetLabel,
    executionState,
    rationale,
    desiredReplicas,
    impactDescription,
    errorMessage,
  } = props;

  const checkboxId = useId();
  const hintId = useId();
  const riskRequired = actionType === 'drain_node';
  const meta = ACTION_META[actionType];

  const [phase, setPhase] = useState<LocalPhase>(() => phaseFromExecution(executionState));
  const [riskAck, setRiskAck] = useState(false);
  const [streamToken, setStreamToken] = useState(0);
  const [localFailure, setLocalFailure] = useState<string | null>(
    executionState === 'failed' ? (errorMessage ?? '自愈指令被拒绝') : null,
  );

  useEffect(() => {
    setRiskAck(false);
    setLocalFailure(executionState === 'failed' ? (errorMessage ?? '自愈指令被拒绝') : null);
    setPhase(phaseFromExecution(executionState));
  }, [requestId, executionState, errorMessage]);

  useEffect(() => {
    if (phase !== 'streaming') {
      return;
    }
    const timer = window.setTimeout(() => {
      const ok = dispatchHeal(targetId, actionType);
      if (ok) {
        setLocalFailure(null);
        setPhase('locked');
        return;
      }
      setLocalFailure(`自愈未完成：未在场景中确认 ${targetLabel} 已恢复为运行态。`);
      setPhase('failed');
    }, HEAL_STREAM_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [phase, streamToken, targetId, actionType, targetLabel]);

  const riskBlocked = riskRequired && !riskAck;
  const canExecute = (phase === 'ready' || phase === 'failed') && !riskBlocked;
  const shownError = phase === 'failed' ? (localFailure ?? errorMessage ?? null) : null;

  const execute = (): void => {
    if (!canExecute) {
      return;
    }
    setLocalFailure(null);
    setPhase('streaming');
    setStreamToken((token) => token + 1);
  };

  return (
    <article className="kv-panel overflow-hidden" aria-label={`自愈确认 ${targetLabel}`}>
      <header className="flex items-start justify-between gap-3 border-b border-slate-800 px-3 py-2.5">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-widest text-cyan-400">
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
            kube-api confirm
          </p>
          <h3 className="mt-1 truncate text-sm font-semibold text-slate-100">{meta.title}</h3>
          <p className="mt-0.5 font-mono text-xs text-slate-400">{requestId}</p>
        </div>
        <span className="shrink-0 rounded-full border border-slate-700 px-2 py-1 font-mono text-xs uppercase tracking-widest text-slate-300">
          {actionType}
        </span>
      </header>

      <div className="space-y-3 px-3 py-3">
        <ul className="grid grid-cols-3 gap-2">
          {CONFIRMABLE_ACTION_TYPES.map((kind) => {
            const active = kind === actionType;
            const entry = ACTION_META[kind];
            return (
              <li
                key={kind}
                aria-current={active ? 'true' : undefined}
                className={`rounded-md border px-2 py-2 ${
                  active
                    ? 'border-cyan-400/50 bg-cyan-400/10'
                    : 'border-slate-800 bg-slate-950/40'
                }`}
              >
                <span className={`block text-xs font-medium ${active ? 'text-cyan-200' : 'text-slate-400'}`}>
                  {entry.title}
                </span>
                <span className="mt-0.5 block truncate font-mono text-xs uppercase tracking-widest text-slate-500">
                  {kind}
                </span>
              </li>
            );
          })}
        </ul>

        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-sm">
          <dt className="text-slate-400">目标</dt>
          <dd className="truncate font-mono text-slate-100" title={targetLabel}>
            {targetLabel}
          </dd>
          <dt className="text-slate-400">对象 ID</dt>
          <dd className="truncate font-mono text-xs text-cyan-300" title={targetId}>
            {targetId}
          </dd>
          {actionType === 'scale_deployment' && desiredReplicas !== undefined ? (
            <>
              <dt className="text-slate-400">期望副本</dt>
              <dd className="font-mono tabular-nums text-slate-100">{desiredReplicas}</dd>
            </>
          ) : null}
        </dl>

        <p className="text-sm leading-6 text-slate-300">{rationale}</p>
        <p className="text-xs leading-5 text-slate-400">{meta.summary}</p>

        <div className="rounded-md border border-amber-400/30 bg-amber-400/5 p-2.5">
          <label htmlFor={checkboxId} className="flex min-h-11 cursor-pointer items-start gap-3">
            <input
              id={checkboxId}
              type="checkbox"
              checked={riskAck}
              disabled={phase === 'streaming' || phase === 'locked' || phase === 'cancelled'}
              onChange={(event) => setRiskAck(event.target.checked)}
              className="mt-1 h-5 w-5 shrink-0 accent-amber-400"
            />
            <span>
              <span className="flex items-center gap-1.5 text-sm font-medium text-amber-200">
                <OctagonAlert className="h-4 w-4" aria-hidden />
                高危操作风险提示
              </span>
              <span id={hintId} className="mt-1 block text-sm leading-6 text-slate-300">
                {impactDescription}
              </span>
              {riskRequired ? (
                <span className="mt-1 block text-xs text-amber-300">
                  节点排空必须勾选后才能执行。
                </span>
              ) : (
                <span className="mt-1 block text-xs text-slate-400">
                  当前动作不强制勾选。排空节点时此项为必选。
                </span>
              )}
            </span>
          </label>
        </div>

        {shownError !== null ? (
          <p role="alert" className="text-sm leading-6 text-rose-300">
            {shownError}
          </p>
        ) : null}

        {phase === 'cancelled' ? (
          <p className="text-sm text-slate-300">该自愈请求已取消，不会下发到 Kube-API。</p>
        ) : null}

        <div className="min-h-[4.75rem]">
          {phase === 'locked' ? (
            <p
              role="status"
              className="flex min-h-11 items-center gap-2 rounded-md border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 text-sm font-medium leading-6 text-emerald-400 shadow-glow-emerald"
            >
              <Check className="h-4 w-4 shrink-0" aria-hidden />
              {SUCCESS_LOCK_LABEL}
            </p>
          ) : null}

          {phase === 'streaming' ? (
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="正在下发自愈指令"
              aria-busy="true"
              className="space-y-2"
            >
              <p className="text-sm text-cyan-200">正在下发自愈指令…</p>
              <div className="relative h-2 overflow-hidden rounded-full bg-slate-800">
                <span className="kv-heal-fill absolute inset-0 rounded-full bg-gradient-to-r from-cyan-500 via-cyan-200 to-emerald-400" />
                <span className="kv-heal-gleam absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
              </div>
            </div>
          ) : null}

          {phase === 'ready' || phase === 'failed' ? (
            <button
              type="button"
              onClick={execute}
              disabled={!canExecute}
              aria-describedby={hintId}
              className="min-h-11 w-full rounded-md border border-cyan-400/50 bg-cyan-400/10 px-3 text-sm font-semibold text-cyan-100 touch-manipulation transition-colors hover:bg-cyan-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-900 disabled:text-slate-400"
            >
              立即执行自愈指令
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
