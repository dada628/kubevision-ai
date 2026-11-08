'use client';

/**
 * Bridge between the single edge-classifier worker and the auditor panel.
 *
 * `EdgeLogClassifier` is the only place that constructs the worker. This module
 * attaches that instance's `onmessage` / `postMessage` so the panel can submit
 * logs and render progress without creating a second ONNX session.
 *
 * The snapshot is a module singleton behind `useSyncExternalStore`. Audits
 * arrive many times a second during a burst; they must not travel through
 * Zustand or they would re-render the whole command surface.
 */

import { useSyncExternalStore } from 'react';
import type {
  EdgeAuditLabel,
  EdgeClassifierEngine,
  EdgeClassifierEvent,
  EdgeClassifyRequest,
  EdgeModelProgressStatus,
  LogEntry,
} from '@/types/ai';
import { EDGE_CLASSIFIER_MODEL_ID, isEdgeClassifierEvent } from '@/types/ai';
import { useClusterStore } from '@/store/useClusterStore';
import { getSnapshot } from '@/store/useTelemetryRef';
import { generateSyntheticLogs } from '@/utils/syntheticEngine';

/** Worker rejects ids longer than this. Keep the correlation key inside it. */
const ID_LIMIT = 256;
/** Result cards kept on screen. Older audits drop off the top of the burst. */
const MAX_CARDS = 12;
/** Stop enqueueing when the worker has not answered. */
const MAX_IN_FLIGHT = 24;

/** One finished on-device audit, joined with the pod that produced the line. */
export interface EdgeAuditCard {
  readonly requestId: string;
  readonly podName: string;
  readonly namespace: string;
  /** Verbatim line. Stays in this tab; the cloud prompt never reads it. */
  readonly rawText: string;
  readonly sanitized: string;
  readonly maskedCount: number;
  readonly label: EdgeAuditLabel;
  readonly confidence: number;
  readonly inferenceMs: number;
  readonly engine: EdgeClassifierEngine;
}

/** A line that has been posted and has not come back yet. */
export interface EdgeAuditPending {
  readonly requestId: string;
  readonly podName: string;
  readonly namespace: string;
}

/**
 * What the auditor panel renders. `idle` is the local state before the worker
 * has posted its first progress sample.
 */
export interface EdgeAuditorSnapshot {
  readonly attached: boolean;
  readonly percent: number;
  readonly progressStatus: EdgeModelProgressStatus | 'idle';
  readonly engine: EdgeClassifierEngine | null;
  readonly webGpuAvailable: boolean;
  readonly executionProvider: 'wasm' | null;
  readonly maskedSecrets: number;
  readonly inferenceCount: number;
  readonly inferenceSumMs: number;
  readonly cards: readonly EdgeAuditCard[];
  readonly pending: readonly EdgeAuditPending[];
  readonly lastNotice: string | null;
}

interface PendingMeta {
  readonly podName: string;
  readonly namespace: string;
  readonly rawText: string;
}

const INITIAL_SNAPSHOT: EdgeAuditorSnapshot = Object.freeze({
  attached: false,
  percent: 0,
  progressStatus: 'idle',
  engine: null,
  webGpuAvailable: false,
  executionProvider: null,
  maskedSecrets: 0,
  inferenceCount: 0,
  inferenceSumMs: 0,
  cards: Object.freeze([]),
  pending: Object.freeze([]),
  lastNotice: null,
});

let snapshot: EdgeAuditorSnapshot = INITIAL_SNAPSHOT;
let worker: Worker | null = null;
let requestSeq = 0;

const listeners = new Set<() => void>();
const pending = new Map<string, PendingMeta>();

function pendingViews(): readonly EdgeAuditPending[] {
  const views: EdgeAuditPending[] = [];
  for (const [requestId, meta] of pending) {
    views.push({
      requestId,
      podName: meta.podName,
      namespace: meta.namespace,
    });
  }
  views.reverse();
  return views;
}

function publish(next: Omit<EdgeAuditorSnapshot, 'pending'>): void {
  snapshot = { ...next, pending: pendingViews() };
  for (const listener of listeners) {
    listener();
  }
}

function base(): Omit<EdgeAuditorSnapshot, 'pending'> {
  return {
    attached: snapshot.attached,
    percent: snapshot.percent,
    progressStatus: snapshot.progressStatus,
    engine: snapshot.engine,
    webGpuAvailable: snapshot.webGpuAvailable,
    executionProvider: snapshot.executionProvider,
    maskedSecrets: snapshot.maskedSecrets,
    inferenceCount: snapshot.inferenceCount,
    inferenceSumMs: snapshot.inferenceSumMs,
    cards: snapshot.cards,
    lastNotice: snapshot.lastNotice,
  };
}

/**
 * Clock prefix shared with the cluster store's terminal lines.
 * Kept local so a worker message can be echoed without exporting the store helper.
 */
function clockLabel(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Writes one edge-inference line into TerminalEcho.
 *
 * The body never includes the raw log or the sanitized line: both can still
 * carry context the operator did not ask the terminal to keep. The count, the
 * label and the pod name are enough to read the same event the drawer shows.
 */
function echoEdgeWasm(message: string): void {
  useClusterStore
    .getState()
    .appendTerminalLog(`[${clockLabel()}] [EDGE-WASM] ${message}`);
}

function secretNoun(count: number): string {
  return count === 1 ? 'secret' : 'secrets';
}

function applyEvent(event: EdgeClassifierEvent): void {
  if (event.type === 'progress') {
    publish({
      ...base(),
      percent: event.progress.percent,
      progressStatus: event.progress.status,
    });
    return;
  }
  if (event.type === 'ready') {
    publish({
      ...base(),
      percent: 100,
      progressStatus: event.engine === 'vector' ? 'fallback' : 'ready',
      engine: event.engine,
      webGpuAvailable: event.webGpuAvailable,
      executionProvider: event.executionProvider,
    });
    const runtime = event.webGpuAvailable ? 'WebGPU Accelerated' : 'WebAssembly SIMD';
    const engine =
      event.engine === 'transformers' ? EDGE_CLASSIFIER_MODEL_ID : 'vector fallback';
    echoEdgeWasm(`Classifier ready · ${runtime} · ${engine}`);
    return;
  }
  if (event.type === 'fault') {
    if (event.logEntryId !== null) {
      pending.delete(event.logEntryId);
    }
    publish({ ...base(), lastNotice: event.message });
    echoEdgeWasm(`Inference fault · ${event.message}`);
    return;
  }
  const meta = pending.get(event.result.logEntryId);
  pending.delete(event.result.logEntryId);
  const card: EdgeAuditCard = {
    requestId: event.result.logEntryId,
    podName: meta?.podName ?? '未知 Pod',
    namespace: meta?.namespace ?? '—',
    rawText: meta?.rawText ?? '',
    sanitized: event.sanitized,
    maskedCount: event.maskedCount,
    label: event.result.label,
    confidence: event.result.confidence,
    inferenceMs: event.result.inferenceMs,
    engine: event.engine,
  };
  publish({
    ...base(),
    cards: [card, ...snapshot.cards].slice(0, MAX_CARDS),
    maskedSecrets: snapshot.maskedSecrets + event.maskedCount,
    inferenceCount: snapshot.inferenceCount + 1,
    inferenceSumMs: snapshot.inferenceSumMs + event.result.inferenceMs,
    lastNotice: null,
  });
  echoEdgeWasm(
    `Sanitized ${card.maskedCount} ${secretNoun(card.maskedCount)} & detected ${card.label} in pod ${card.podName}`,
  );
}

function enqueue(entry: LogEntry): boolean {
  if (worker === null || pending.size >= MAX_IN_FLIGHT) {
    return false;
  }
  requestSeq += 1;
  const requestId = `${entry.id}#${requestSeq}`;
  if (requestId.length > ID_LIMIT) {
    return false;
  }
  pending.set(requestId, {
    podName: entry.source.podName,
    namespace: entry.source.namespace,
    rawText: entry.rawText,
  });
  const command: EdgeClassifyRequest = {
    type: 'classify',
    logEntryId: requestId,
    text: entry.rawText,
  };
  worker.postMessage(command);
  return true;
}

/**
 * Register the worker created by `EdgeLogClassifier`.
 * The returned function detaches listeners. The caller still `terminate()`s.
 */
export function bindLogClassifierWorker(next: Worker): () => void {
  worker = next;
  next.onmessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isEdgeClassifierEvent(data)) {
      return;
    }
    applyEvent(data);
  };
  next.onerror = () => {
    publish({
      ...base(),
      lastNotice: '端侧 Worker 启动失败，分类结果无法返回。',
    });
    echoEdgeWasm('Inference fault · edge worker failed to start');
  };
  publish({ ...base(), attached: true, lastNotice: null });
  return () => {
    next.onmessage = null;
    next.onerror = null;
    if (worker === next) {
      worker = null;
    }
    pending.clear();
    publish({
      ...base(),
      attached: false,
      percent: 0,
      progressStatus: 'idle',
      engine: null,
      webGpuAvailable: false,
      executionProvider: null,
    });
  };
}

/**
 * Read the live cluster snapshot, synthesize the current container log burst,
 * and post each raw line to the edge worker. Returns how many lines were sent.
 */
export function auditLiveClusterLogs(): number {
  if (worker === null) {
    publish({ ...base(), lastNotice: '端侧引擎尚未挂载，无法送审。' });
    return 0;
  }
  const logs = generateSyntheticLogs(getSnapshot());
  if (logs.length === 0) {
    publish({ ...base(), lastNotice: '当前这一拍没有可审计的容器日志。' });
    return 0;
  }
  let posted = 0;
  for (const entry of logs) {
    if (enqueue(entry)) {
      posted += 1;
    }
  }
  publish({
    ...base(),
    lastNotice:
      posted === 0 ? '端侧仍在处理上一批日志，这一拍没有送出。' : null,
  });
  return posted;
}

export function subscribeAuditor(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAuditorSnapshot(): EdgeAuditorSnapshot {
  return snapshot;
}

export function getAuditorServerSnapshot(): EdgeAuditorSnapshot {
  return INITIAL_SNAPSHOT;
}

export function useEdgeAuditorSnapshot(): EdgeAuditorSnapshot {
  return useSyncExternalStore(
    subscribeAuditor,
    getAuditorSnapshot,
    getAuditorServerSnapshot,
  );
}
