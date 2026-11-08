/**
 * KubeVision AI - edge log classifier worker.
 *
 * Owns the Transformers.js session so ONNX, WASM and the model shards never
 * touch the render thread. The main thread posts `EdgeClassifierCommand`s and
 * receives `EdgeClassifierEvent`s.
 *
 * Startup dynamically imports `@xenova/transformers`, forces remote models
 * (`env.allowLocalModels = false`) and arms two caches: the browser Cache API
 * (primary, mirrored into IndexedDB on every `put`) and an IndexedDB custom
 * cache (used when `caches.open` is blocked). Download progress is aggregated
 * across shards into one integer in [0, 100] and posted as it moves.
 *
 * Each line is sanitized, then scored by the built-in vector engine. When the
 * DistilBERT SST-2 pipeline is ready, its POSITIVE / NEGATIVE scores are fused
 * into those logits. If the mirror is unreachable, the session times out, or
 * the runtime has no Cache / WebGPU / WASM path, the vector engine answers
 * alone. Classify never waits on a download, and a single forward pass cannot
 * stall the worker: the load budget and the inference budget both reject into
 * the fallback.
 *
 * WebGPU is probed (`navigator.gpu.requestAdapter`) and reported on `ready`.
 * `@xenova/transformers@2.17.2` hard-codes the ONNX execution provider to
 * `wasm` and does not export that list, so the session itself runs on WASM.
 *
 * Constructed by `EdgeLogClassifier` after mount:
 *   new Worker(new URL('../workers/logClassifier.worker.ts', import.meta.url), { type: 'module' })
 */

import { EDGE_AUDIT_ACTION_THRESHOLD } from '@/types/ai';
import type {
  EdgeAuditResult,
  EdgeClassifierEvent,
  EdgeClassifyRequest,
  EdgeModelProgressStatus,
} from '@/types/ai';
import { isEdgeClassifierCommand, isEdgeModelProgressStatus } from '@/types/ai';
import type { EdgeClassifierEngine } from '@/types/ai';
import {
  fuseVectorAndSentiment,
  inferLogVector,
  rankFusedLogits,
} from '@/utils/edgeVectorClassifier';
import type { PolarityScores } from '@/utils/edgeVectorClassifier';
import { sanitizeRawLog } from '@/utils/logSanitizer';

const MODEL_ID = 'Xenova/distilbert-base-uncased-finetuned-sst-2-english';
const LOAD_TIMEOUT_MS = 45_000;
const FIRST_INFERENCE_BUDGET_MS = 6_000;
const INFERENCE_BUDGET_MS = 2_500;
const IDB_BUDGET_MS = 800;
const TEXT_LIMIT = 4096;
const ID_LIMIT = 256;
const IDB_NAME = 'kubevision-edge-models';
const IDB_STORE = 'shards';

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

interface MutableTransformersEnv {
  allowLocalModels: boolean;
  allowRemoteModels: boolean;
  useBrowserCache: boolean;
  useFS: boolean;
  useFSCache: boolean;
  useCustomCache: boolean;
  customCache: ModelCache | null;
}

interface ModelCache {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
}

interface ShardRecord {
  readonly buffer: ArrayBuffer;
  readonly contentType: string;
}

interface ShardProgress {
  loaded: number;
  total: number;
  ratio: number;
}

interface ProgressPayload {
  readonly status: string;
  readonly file?: unknown;
  readonly progress?: unknown;
  readonly loaded?: unknown;
  readonly total?: unknown;
}

type TextClassifyFn = (text: string) => Promise<unknown>;

interface SentimentHit {
  readonly label: string;
  readonly score: number;
}

let readyClassifier: TextClassifyFn | null = null;
let engineMode: 'loading' | EdgeClassifierEngine = 'loading';
let vectorAnnounced = false;
let modelWarmed = false;
let webGpuAvailable = false;
let lastPostedPercent = -1;
let chain: Promise<void> = Promise.resolve();
let dbPromise: Promise<IDBDatabase> | null = null;

const shards = new Map<string, ShardProgress>();

function post(message: EdgeClassifierEvent): void {
  scope.postMessage(message);
}

function withTimeout<T>(promise: Promise<T>, budgetMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${budgetMs}ms`));
    }, budgetMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('edge task failed'));
      },
    );
  });
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function roundInferenceMs(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return 0;
  }
  const rounded = Number(elapsedMs.toFixed(2));
  return rounded < 0 ? 0 : rounded;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function toProgressStatus(status: string): EdgeModelProgressStatus {
  return isEdgeModelProgressStatus(status) ? status : 'progress';
}

function isProgressPayload(value: unknown): value is ProgressPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return typeof (value as { status?: unknown }).status === 'string';
}

function aggregatePercent(): number {
  let loaded = 0;
  let total = 0;
  let ratioSum = 0;
  let count = 0;
  for (const shard of shards.values()) {
    ratioSum += shard.ratio;
    count += 1;
    if (shard.total > 0) {
      loaded += Math.max(0, shard.loaded);
      total += shard.total;
    }
  }
  const ratio = total > 0 ? loaded / total : count > 0 ? ratioSum / count : 0;
  return clampPercent(Math.max(0, Math.min(1, ratio)) * 100);
}

function publish(
  percent: number,
  status: EdgeModelProgressStatus,
  file: string | null,
): void {
  const shown = status === 'ready' || status === 'fallback' ? 100 : Math.min(99, clampPercent(percent));
  if (shown === lastPostedPercent && status === 'progress') {
    return;
  }
  lastPostedPercent = shown;
  post({
    type: 'progress',
    progress: { percent: shown, status, file },
  });
}

function noteProgress(value: unknown): void {
  if (!isProgressPayload(value)) {
    return;
  }
  const file = typeof value.file === 'string' ? value.file : 'model';
  const current = shards.get(file) ?? { loaded: 0, total: 0, ratio: 0 };
  if (value.status === 'done') {
    current.ratio = 1;
    if (current.total > 0) {
      current.loaded = current.total;
    }
  } else if (typeof value.progress === 'number' && Number.isFinite(value.progress)) {
    current.ratio = Math.max(0, Math.min(1, value.progress / 100));
  }
  if (typeof value.loaded === 'number' && Number.isFinite(value.loaded)) {
    current.loaded = Math.max(0, value.loaded);
  }
  if (typeof value.total === 'number' && Number.isFinite(value.total) && value.total > 0) {
    current.total = value.total;
  }
  shards.set(file, current);
  publish(aggregatePercent(), toProgressStatus(value.status), file);
}

function cacheKeyOf(request: RequestInfo | URL): string {
  if (typeof request === 'string') {
    return request;
  }
  if (request instanceof URL) {
    return request.toString();
  }
  return request.url;
}

function isShardRecord(value: unknown): value is ShardRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as { buffer?: unknown; contentType?: unknown };
  return record.buffer instanceof ArrayBuffer && typeof record.contentType === 'string';
}

function openModelDb(): Promise<IDBDatabase> {
  if (dbPromise !== null) {
    return dbPromise;
  }
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(IDB_STORE)) {
        database.createObjectStore(IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('Failed to open the model database'));
    };
  });
  return dbPromise;
}

async function persistShard(key: string, response: Response): Promise<void> {
  const buffer = await response.arrayBuffer();
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  const record: ShardRecord = { buffer, contentType };
  const database = await openModelDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(IDB_STORE, 'readwrite');
    transaction.objectStore(IDB_STORE).put(record, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'));
  });
}

async function writeShard(key: string, response: Response): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    return;
  }
  try {
    await withTimeout(persistShard(key, response), IDB_BUDGET_MS);
  } catch {
    // Quota, private mode, or a locked database. The Cache API copy still stands.
  }
}

async function readShard(key: string): Promise<Response | undefined> {
  if (typeof indexedDB === 'undefined') {
    return undefined;
  }
  try {
    return await withTimeout(loadShard(key), IDB_BUDGET_MS);
  } catch {
    return undefined;
  }
}

async function loadShard(key: string): Promise<Response | undefined> {
  const database = await openModelDb();
  const record = await new Promise<ShardRecord | undefined>((resolve, reject) => {
    const transaction = database.transaction(IDB_STORE, 'readonly');
    const request = transaction.objectStore(IDB_STORE).get(key);
    request.onsuccess = () => {
      const value: unknown = request.result;
      resolve(isShardRecord(value) ? value : undefined);
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
  });
  if (record === undefined) {
    return undefined;
  }
  return new Response(record.buffer, {
    headers: { 'content-type': record.contentType },
  });
}

const indexedDbCache: ModelCache = {
  match(request: RequestInfo | URL): Promise<Response | undefined> {
    return readShard(cacheKeyOf(request));
  },
  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    await writeShard(cacheKeyOf(request), response);
  },
};

function wrapCache(opened: Cache): Cache {
  const dual = {
    async match(request: RequestInfo, options?: CacheQueryOptions): Promise<Response | undefined> {
      try {
        const hit = await opened.match(request, options);
        if (hit !== undefined) {
          return hit;
        }
      } catch {
        // Cache API match failed; IndexedDB is the second store.
      }
      return readShard(cacheKeyOf(request));
    },
    async put(request: RequestInfo, response: Response): Promise<void> {
      let forIdb: Response | null = null;
      try {
        forIdb = response.clone();
      } catch {
        forIdb = null;
      }
      await opened.put(request, response);
      if (forIdb !== null) {
        await writeShard(cacheKeyOf(request), forIdb);
      }
    },
    delete: opened.delete.bind(opened),
    keys: opened.keys.bind(opened),
    add: opened.add.bind(opened),
    addAll: opened.addAll.bind(opened),
    matchAll: opened.matchAll.bind(opened),
  };
  return dual as unknown as Cache;
}

function patchCacheApi(): void {
  if (typeof caches === 'undefined') {
    return;
  }
  const storage = caches as unknown as {
    open: (cacheName: string) => Promise<Cache>;
  };
  if (storage.open.name === 'openDualCache') {
    return;
  }
  const nativeOpen = storage.open.bind(caches);
  const openDualCache = async (cacheName: string): Promise<Cache> => {
    const opened = await nativeOpen(cacheName);
    return wrapCache(opened);
  };
  storage.open = openDualCache;
}

function configureEnv(env: object): void {
  const mutable = env as unknown as MutableTransformersEnv;
  mutable.allowLocalModels = false;
  mutable.allowRemoteModels = true;
  mutable.useFS = false;
  mutable.useFSCache = false;
  mutable.useBrowserCache = typeof caches !== 'undefined';
  mutable.useCustomCache = true;
  mutable.customCache = indexedDbCache;
  patchCacheApi();
}

function isSentimentHit(value: unknown): value is SentimentHit {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as { label?: unknown; score?: unknown };
  return typeof record.label === 'string' && typeof record.score === 'number' && Number.isFinite(record.score);
}

function readHits(output: unknown): SentimentHit[] {
  if (Array.isArray(output)) {
    const nested = output[0];
    if (Array.isArray(nested)) {
      return nested.filter(isSentimentHit);
    }
    return output.filter(isSentimentHit);
  }
  return isSentimentHit(output) ? [output] : [];
}

function readPolarity(output: unknown): PolarityScores {
  let positive = 0;
  let negative = 0;
  let sawPositive = false;
  let sawNegative = false;
  for (const hit of readHits(output)) {
    const label = hit.label.toUpperCase();
    if (label === 'POSITIVE') {
      positive = hit.score;
      sawPositive = true;
    } else if (label === 'NEGATIVE') {
      negative = hit.score;
      sawNegative = true;
    }
  }
  if (sawPositive && !sawNegative) {
    negative = Math.min(1, Math.max(0, 1 - positive));
  } else if (sawNegative && !sawPositive) {
    positive = Math.min(1, Math.max(0, 1 - negative));
  } else if (!sawPositive && !sawNegative) {
    return { positive: 0.5, negative: 0.5 };
  }
  return {
    positive: Math.min(1, Math.max(0, positive)),
    negative: Math.min(1, Math.max(0, negative)),
  };
}

async function createClassifier(): Promise<TextClassifyFn> {
  const transformers = await import('@xenova/transformers');
  configureEnv(transformers.env);
  const classifier = await transformers.pipeline(
    'text-classification',
    MODEL_ID,
    {
      quantized: true,
      progress_callback: (update: unknown) => {
        try {
          noteProgress(update);
        } catch {
          // Progress bookkeeping must never reject the download.
        }
      },
    },
  );
  const invoke = classifier as unknown as (
    text: string,
    options: { readonly topk: number },
  ) => Promise<unknown>;
  return (text: string) => invoke(text, { topk: 2 });
}

function announceVector(): void {
  if (engineMode === 'transformers' || vectorAnnounced) {
    return;
  }
  engineMode = 'vector';
  vectorAnnounced = true;
  publish(100, 'fallback', null);
  post({
    type: 'ready',
    engine: 'vector',
    percent: 100,
    webGpuAvailable,
    executionProvider: 'wasm',
  });
}

function announceModel(classifier: TextClassifyFn): void {
  readyClassifier = classifier;
  engineMode = 'transformers';
  vectorAnnounced = true;
  publish(100, 'ready', null);
  post({
    type: 'ready',
    engine: 'transformers',
    percent: 100,
    webGpuAvailable,
    executionProvider: 'wasm',
  });
}

function bootstrap(): void {
  try {
    publish(0, 'initiate', null);
    const pending = createClassifier();
    const timer = setTimeout(() => {
      if (engineMode !== 'transformers') {
        announceVector();
      }
    }, LOAD_TIMEOUT_MS);
    pending.then(
      (classifier) => {
        clearTimeout(timer);
        announceModel(classifier);
      },
      () => {
        clearTimeout(timer);
        if (engineMode !== 'transformers') {
          announceVector();
        }
      },
    );
  } catch {
    announceVector();
  }
}

async function polarityFromModel(text: string): Promise<PolarityScores | null> {
  if (text.trim().length === 0) {
    return null;
  }
  const classifier = readyClassifier;
  if (classifier === null || engineMode !== 'transformers') {
    return null;
  }
  const budgetMs = modelWarmed ? INFERENCE_BUDGET_MS : FIRST_INFERENCE_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  const inference = enqueue(async () => readPolarity(await classifier(text)));
  try {
    const winner = await Promise.race([inference, budget]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (winner !== null) {
      modelWarmed = true;
    }
    return winner;
  } catch {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    return null;
  }
}

async function handleClassify(command: EdgeClassifyRequest): Promise<void> {
  if (command.logEntryId.length === 0 || command.logEntryId.length > ID_LIMIT) {
    post({
      type: 'fault',
      message: 'Classifier command is missing a log id',
      logEntryId: command.logEntryId.length > 0 ? command.logEntryId.slice(0, ID_LIMIT) : null,
    });
    return;
  }

  const clipped = command.text.length > TEXT_LIMIT ? command.text.slice(0, TEXT_LIMIT) : command.text;
  let sanitized = clipped;
  let maskedCount = 0;
  try {
    const masked = sanitizeRawLog(clipped);
    sanitized = masked.sanitized;
    maskedCount = masked.maskedCount;
  } catch {
    sanitized = clipped;
    maskedCount = 0;
  }

  const vectorStarted = performance.now();
  const inference = inferLogVector(sanitized);
  const vectorMs = performance.now() - vectorStarted;

  const modelStarted = performance.now();
  const polarity = await polarityFromModel(sanitized);
  const modelMs = performance.now() - modelStarted;

  const fused = fuseVectorAndSentiment(inference.logits, inference.priors, polarity);
  const hypotheses = rankFusedLogits(fused);
  const top = hypotheses[0];
  if (top === undefined) {
    post({
      type: 'fault',
      message: 'Classifier produced no label',
      logEntryId: command.logEntryId,
    });
    return;
  }

  const result: EdgeAuditResult = {
    label: top.label,
    confidence: top.confidence,
    inferenceMs: roundInferenceMs(polarity === null ? vectorMs : vectorMs + modelMs),
    logEntryId: command.logEntryId,
    hypotheses,
    belowThreshold: top.confidence < EDGE_AUDIT_ACTION_THRESHOLD,
  };
  post({
    type: 'audit',
    engine: polarity === null ? 'vector' : 'transformers',
    sanitized,
    maskedCount,
    result,
  });
}

function browserNavigator():
  | (Navigator & { readonly gpu?: { readonly requestAdapter?: () => Promise<unknown> } })
  | null {
  if (typeof navigator === 'undefined') {
    return null;
  }
  return navigator;
}

function probeWebGpu(): void {
  const nav = browserNavigator();
  const gpu = nav?.gpu;
  if (gpu?.requestAdapter === undefined) {
    webGpuAvailable = false;
    return;
  }
  void withTimeout(gpu.requestAdapter(), 1_500).then(
    (adapter) => {
      webGpuAvailable = adapter !== null && adapter !== undefined;
    },
    () => {
      webGpuAvailable = false;
    },
  );
}

scope.onmessage = (event: MessageEvent) => {
  const data: unknown = event.data;
  if (!isEdgeClassifierCommand(data)) {
    post({
      type: 'fault',
      message: 'Unrecognized classifier command',
      logEntryId: null,
    });
    return;
  }
  if (data.type === 'warmup') {
    return;
  }
  void handleClassify(data).catch(() => {
    post({
      type: 'fault',
      message: 'Classifier command failed',
      logEntryId: data.logEntryId,
    });
  });
};

probeWebGpu();
bootstrap();
