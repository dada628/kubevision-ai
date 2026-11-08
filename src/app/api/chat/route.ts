/**
 * KubeVision AI - streaming SRE copilot.
 *
 * ROUTE: POST /api/chat
 *
 * The browser sends the AI SDK `useChat` body (`messages`) plus a
 * `clusterContext` read from the live store at send time: `selectedEntityId`,
 * `selectedEntityType`, `activeChaos`, `abnormalPods` and the telemetry
 * `snapshot`. The response is an AI SDK data stream
 * (`X-Vercel-AI-Data-Stream: v1`) so tool calls render straight into
 * PodMetricsCard, RootCauseAlert and ActionConfirm.
 *
 * TWO PIPELINES, ONE PROTOCOL
 * - A usable `OPENAI_API_KEY` (optional `OPENAI_BASE_URL` / `OPENAI_MODEL` for
 *   DeepSeek, Qwen and other OpenAI-compatible gateways) runs `streamText`
 *   with the three tools below. Tool `execute` overwrites model numbers with
 *   the snapshot so a card cannot disagree with the 3D scene.
 * - No key, a placeholder key, or a provider failure before the first text or
 *   tool part, switches to the deterministic simulator. It types the diagnosis
 *   in small chunks and emits the same three tool payloads. Public reviewers
 *   get the full generative UI with zero configuration.
 */

import {
  createDataStreamResponse,
  formatDataStreamPart,
  streamText,
  tool,
  type CoreMessage,
  type DataStreamWriter,
} from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import {
  ACTION_EXECUTION_STATES,
  CONFIRMABLE_ACTION_TYPES,
  RECOMMENDED_ACTION_KINDS,
  type ActionConfirmProps,
  type PodMetricsCardProps,
  type RootCauseAlertProps,
} from '@/types/ai';
import {
  INCIDENT_SEVERITIES,
  INITIAL_CLUSTER_SNAPSHOT,
  POD_STATUSES,
  clampPercentage,
  isChaosScenario,
  isIncidentSeverity,
  isNodeStatus,
  isPodStatus,
} from '@/types/cluster';
import type {
  ChaosScenario,
  IncidentSeverity,
  NodeStatus,
  PodStatus,
  TelemetrySnapshot,
} from '@/types/cluster';
import { CHAOS_TARGET_RACK, RACK_WORKER_LABEL, isEntityType } from '@/types/store';
import type { EntityType } from '@/types/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Vercel Node 函数墙钟上限。流式工具调用在此时限内结束，超时由客户端中止。 */
export const maxDuration = 30;

const TYPEWRITER_CHARS = 3;
const TYPEWRITER_MS = 14;
const TOOL_ARG_CHARS = 48;
const TOOL_ARG_MS = 22;
const MODEL_FIRST_BYTE_MS = 12_000;

const DEFAULT_QUESTION =
  '请基于当前集群快照做一次完整诊断：指出异常 Pod 的实时指标、根因证据链，并给出需要人工确认的自愈指令。';

/* ==========================================================================
   Tool schemas — the card payloads, so the UI maps a result with no adapter
   ========================================================================== */

const renderPodMetricsParameters = z.object({
  podId: z.string().min(1).describe('PodEntity.id'),
  podName: z.string().min(1),
  namespace: z.string().min(1),
  nodeId: z.string().min(1),
  status: z.enum(POD_STATUSES),
  cpuUsage: z.number().min(0).max(100),
  memoryUsage: z.number().min(0).max(100),
  restarts: z.number().int().nonnegative(),
  cpuHistory: z.array(z.number().min(0).max(100)).max(6),
  memHistory: z.array(z.number().min(0).max(100)).max(6),
  narrative: z.string().min(1).max(280).describe('One plain sentence, no markdown'),
  atRisk: z.boolean(),
});

const evidenceSchema = z.object({
  signal: z.string().min(1),
  detail: z.string().min(1),
  weight: z.number().min(0).max(1),
  source: z.enum(['metrics', 'logs', 'events', 'topology']),
  observedAt: z.string().min(1),
});

const recommendedActionSchema = z.object({
  kind: z.enum(RECOMMENDED_ACTION_KINDS),
  label: z.string().min(1),
  requiresConfirmation: z.boolean(),
});

const renderRootCauseAnalysisParameters = z.object({
  incidentId: z.string().min(1),
  severity: z.enum(INCIDENT_SEVERITIES),
  title: z.string().min(1).max(80),
  rootCauseSummary: z.string().min(1).max(480),
  evidenceChain: z.array(evidenceSchema).min(1),
  recommendedActions: z.array(recommendedActionSchema).min(1),
  confidence: z.number().min(0).max(1),
  detectedAt: z.string().min(1),
  affectedIds: z.array(z.string().min(1)).min(1),
});

const proposeRemediationActionParameters = z.object({
  requestId: z.string().min(1),
  actionType: z.enum(CONFIRMABLE_ACTION_TYPES),
  targetId: z.string().min(1).describe('Pod id, Deployment name, or node id'),
  targetLabel: z.string().min(1),
  executionState: z.enum(ACTION_EXECUTION_STATES),
  rationale: z.string().min(1).max(280),
  desiredReplicas: z.number().int().positive().optional(),
  impactDescription: z.string().min(1).max(320),
  errorMessage: z.string().optional(),
});

const SRE_SYSTEM_PROMPT = `你是 KubeVision 的一线 SRE，负责一套三机架 Kubernetes 集群的实时诊断。
回答会渲染成生成式 UI：指标卡、根因卡和自愈确认卡。Markdown 只写结论，不替代卡片。

规则：
1. 使用用户的语言。用户用中文就用中文。先调用工具，再写不超过 8 行的结论。
2. 数字只能来自本次请求附带的集群快照。找不到对象就直接说明，禁止编造 Pod 名、IP、令牌或密钥。
3. 出现 OOMKilled、CrashLoopBackOff、CPU 或内存超过 80%、节点 HighLoad 或 NetworkPartition 时，调用：
   - renderPodMetrics：该 Pod 的实时指标，触发 PodMetricsCard。
   - renderRootCauseAnalysis：按时间排列的证据链，权重之和约等于 1，触发 RootCauseAlert。
   - proposeRemediationAction：待确认的自愈指令，触发 ActionConfirm。executionState 必须是 pending_confirmation，禁止声称已经执行。
4. drain_node 的 impactDescription 必须写明会驱逐该节点上的全部 Pod。
5. scale_deployment 的 targetId 是 Deployment 名称，不是 Pod 名称，并给出正整数 desiredReplicas。
6. restart_pod 的 targetId 是 Pod id。
7. 快照开头的 selectedEntityId、activeChaos、abnormalPods 来自前端当次请求的 3D 场景。问题没有点名其他对象时，先诊断选中实体；没有选中时诊断当前混沌场景的受灾对象；再没有则诊断异常 Pod。工具参数里的名字如果和这三项冲突，以这三项为准。
8. 不要在正文里粘贴工具 JSON。`;

type FallbackReason = 'no-key' | 'model-error';
type ToolKind = 'metrics' | 'cause' | 'action';
type FocusMode = 'oom' | 'crash' | 'saturation' | 'partition' | 'steady';
type Intent = 'metrics' | 'cause' | 'action' | 'full';

interface ContextPod {
  readonly id: string;
  readonly name: string;
  readonly namespace: string;
  readonly nodeId: string;
  readonly status: PodStatus;
  readonly cpuUsage: number;
  readonly memoryUsage: number;
  readonly restarts: number;
  readonly cpuHistory: number[];
  readonly memHistory: number[];
}

interface ContextNode {
  readonly id: string;
  readonly name: string;
  readonly status: NodeStatus;
}

interface ContextAlert {
  readonly severity: IncidentSeverity;
  readonly sourceId: string;
  readonly title: string;
  readonly resolved: boolean;
}

interface SceneHints {
  readonly selectedEntityId: string | null;
  readonly selectedEntityType: EntityType | null;
  readonly activeChaos: ChaosScenario;
  readonly abnormalPodIds: readonly string[];
}

interface ClusterView extends SceneHints {
  readonly timestamp: string;
  readonly pods: readonly ContextPod[];
  readonly nodes: readonly ContextNode[];
  readonly alerts: readonly ContextAlert[];
}

type FocusReason = 'named' | 'selection' | 'chaos' | 'abnormal' | 'rank';

interface Focus {
  readonly pod: ContextPod;
  readonly node: ContextNode | null;
  readonly mode: FocusMode;
  readonly reason: FocusReason;
}

const EMPTY_SCENE: SceneHints = {
  selectedEntityId: null,
  selectedEntityType: null,
  activeChaos: 'NONE',
  abnormalPodIds: [],
};

/* ==========================================================================
   Request parsing
   ========================================================================== */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
    } else if (isRecord(part) && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('');
}

function toCoreMessages(value: unknown): CoreMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const messages: CoreMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const role = item.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      continue;
    }
    const text = readText(item.content).trim();
    if (text.length === 0) {
      continue;
    }
    messages.push({ role, content: text });
  }
  return messages;
}

function lastUserText(messages: readonly CoreMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return '';
}

function readClusterContext(body: Record<string, unknown>): unknown {
  if ('clusterContext' in body) {
    return body.clusterContext;
  }
  if (isRecord(body.data) && 'clusterContext' in body.data) {
    return body.data.clusterContext;
  }
  return undefined;
}

function unwrapSnapshot(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if (Array.isArray(value.pods)) {
    return value;
  }
  if ('snapshot' in value) {
    return value.snapshot;
  }
  return value;
}

function asHistory(value: unknown, fallback: number): number[] {
  const samples: number[] = [];
  if (Array.isArray(value)) {
    for (const sample of value) {
      if (typeof sample === 'number' && Number.isFinite(sample)) {
        samples.push(clampPercentage(sample));
      }
    }
  }
  const tail = samples.slice(-6);
  return tail.length > 0 ? tail : [clampPercentage(fallback)];
}

function parsePod(value: unknown): ContextPod | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== 'string' || value.id.length === 0) {
    return null;
  }
  if (typeof value.name !== 'string' || value.name.length === 0) {
    return null;
  }
  const cpu = typeof value.cpuUsage === 'number' ? value.cpuUsage : 0;
  const mem = typeof value.memoryUsage === 'number' ? value.memoryUsage : 0;
  const restarts = typeof value.restarts === 'number' ? value.restarts : 0;
  return {
    id: value.id,
    name: value.name,
    namespace: typeof value.namespace === 'string' ? value.namespace : 'default',
    nodeId: typeof value.nodeId === 'string' ? value.nodeId : 'unknown',
    status: isPodStatus(value.status) ? value.status : 'Running',
    cpuUsage: clampPercentage(cpu),
    memoryUsage: clampPercentage(mem),
    restarts: Math.max(0, Math.round(restarts)),
    cpuHistory: asHistory(value.cpuHistory, cpu),
    memHistory: asHistory(value.memHistory, mem),
  };
}

function parseNode(value: unknown): ContextNode | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== 'string' || typeof value.name !== 'string') {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    status: isNodeStatus(value.status) ? value.status : 'Ready',
  };
}

function parseAlert(value: unknown): ContextAlert | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.sourceId !== 'string' || typeof value.title !== 'string') {
    return null;
  }
  return {
    severity: isIncidentSeverity(value.severity) ? value.severity : 'P2',
    sourceId: value.sourceId,
    title: value.title,
    resolved: value.resolved === true,
  };
}

function viewFromSnapshot(snapshot: TelemetrySnapshot, scene: SceneHints = EMPTY_SCENE): ClusterView {
  return {
    timestamp: snapshot.timestamp,
    pods: snapshot.pods.map((pod) => ({
      id: pod.id,
      name: pod.name,
      namespace: pod.namespace,
      nodeId: pod.nodeId,
      status: pod.status,
      cpuUsage: clampPercentage(pod.cpuUsage),
      memoryUsage: clampPercentage(pod.memoryUsage),
      restarts: Math.max(0, Math.round(pod.restarts)),
      cpuHistory: asHistory(pod.cpuHistory, pod.cpuUsage),
      memHistory: asHistory(pod.memHistory, pod.memoryUsage),
    })),
    nodes: snapshot.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      status: node.status,
    })),
    alerts: snapshot.activeAlerts.map((alert) => ({
      severity: alert.severity,
      sourceId: alert.sourceId,
      title: alert.title,
      resolved: alert.resolved,
    })),
    selectedEntityId: scene.selectedEntityId,
    selectedEntityType: scene.selectedEntityType,
    activeChaos: scene.activeChaos,
    abnormalPodIds: scene.abnormalPodIds,
  };
}

function readAbnormalPods(value: unknown): { pods: ContextPod[]; ids: string[] } {
  if (!Array.isArray(value)) {
    return { pods: [], ids: [] };
  }
  const pods: ContextPod[] = [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) {
      ids.push(item);
      continue;
    }
    const pod = parsePod(item);
    if (pod !== null) {
      pods.push(pod);
      ids.push(pod.id);
    }
  }
  return { pods, ids };
}

function readScene(raw: Record<string, unknown>): { scene: SceneHints; abnormalPods: ContextPod[] } {
  const selected =
    typeof raw.selectedEntityId === 'string' && raw.selectedEntityId.trim().length > 0
      ? raw.selectedEntityId.trim()
      : null;
  const abnormal = readAbnormalPods(raw.abnormalPods);
  return {
    scene: {
      selectedEntityId: selected,
      selectedEntityType: isEntityType(raw.selectedEntityType) ? raw.selectedEntityType : null,
      activeChaos: isChaosScenario(raw.activeChaos) ? raw.activeChaos : 'NONE',
      abnormalPodIds: abnormal.ids,
    },
    abnormalPods: abnormal.pods,
  };
}

function mergePods(snapshotPods: readonly ContextPod[], abnormalPods: readonly ContextPod[]): ContextPod[] {
  if (snapshotPods.length === 0) {
    return [...abnormalPods];
  }
  const known = new Set(snapshotPods.map((pod) => pod.id));
  const extra = abnormalPods.filter((pod) => !known.has(pod.id));
  return extra.length === 0 ? [...snapshotPods] : [...snapshotPods, ...extra];
}

function parseCluster(value: unknown): ClusterView {
  if (!isRecord(value)) {
    return viewFromSnapshot(INITIAL_CLUSTER_SNAPSHOT);
  }
  const { scene, abnormalPods } = readScene(value);
  const raw = unwrapSnapshot(value);
  if (!isRecord(raw) || !Array.isArray(raw.pods)) {
    if (abnormalPods.length > 0) {
      return {
        timestamp:
          typeof value.timestamp === 'string' ? value.timestamp : INITIAL_CLUSTER_SNAPSHOT.timestamp,
        pods: abnormalPods,
        nodes: [],
        alerts: [],
        ...scene,
      };
    }
    return viewFromSnapshot(INITIAL_CLUSTER_SNAPSHOT, scene);
  }
  const parsed: ContextPod[] = [];
  for (const item of raw.pods) {
    const pod = parsePod(item);
    if (pod !== null) {
      parsed.push(pod);
    }
  }
  const pods = mergePods(parsed, abnormalPods);
  if (pods.length === 0) {
    return viewFromSnapshot(INITIAL_CLUSTER_SNAPSHOT, scene);
  }
  const nodes: ContextNode[] = [];
  if (Array.isArray(raw.nodes)) {
    for (const item of raw.nodes) {
      const node = parseNode(item);
      if (node !== null) {
        nodes.push(node);
      }
    }
  }
  const alerts: ContextAlert[] = [];
  if (Array.isArray(raw.activeAlerts)) {
    for (const item of raw.activeAlerts) {
      const alert = parseAlert(item);
      if (alert !== null) {
        alerts.push(alert);
      }
    }
  }
  return {
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : INITIAL_CLUSTER_SNAPSHOT.timestamp,
    pods,
    nodes,
    alerts,
    ...scene,
  };
}

function usableApiKey(raw: string | undefined): raw is string {
  if (raw === undefined) {
    return false;
  }
  const key = raw.trim();
  if (key.length < 12) {
    return false;
  }
  const lowered = key.toLowerCase();
  return (
    lowered !== 'changeme' &&
    !lowered.includes('your-api-key') &&
    !lowered.includes('your_api_key') &&
    !lowered.includes('sk-xxx')
  );
}

function normalizeBaseUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveModelId(baseURL: string | undefined): string {
  const explicit = process.env.OPENAI_MODEL?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const host = (baseURL ?? '').toLowerCase();
  if (host.includes('deepseek')) {
    return 'deepseek-chat';
  }
  if (host.includes('dashscope') || host.includes('aliyuncs') || host.includes('qwen')) {
    return 'qwen-plus';
  }
  return 'gpt-4o-mini';
}

/* ==========================================================================
   Diagnosis built from the snapshot
   ========================================================================== */

function nodeOf(view: ClusterView, nodeId: string): ContextNode | null {
  for (const node of view.nodes) {
    if (node.id === nodeId || node.name === nodeId) {
      return node;
    }
  }
  return null;
}

function rankPod(pod: ContextPod): number {
  if (pod.status === 'OOMKilled') {
    return 500 + pod.memoryUsage;
  }
  if (pod.status === 'CrashLoopBackOff') {
    return 400 + pod.memoryUsage;
  }
  if (pod.memoryUsage >= 80) {
    return 300 + pod.memoryUsage;
  }
  if (pod.cpuUsage >= 80) {
    return 200 + pod.cpuUsage;
  }
  if (pod.status === 'Pending') {
    return 120;
  }
  if (pod.status === 'Terminating') {
    return 40;
  }
  return pod.cpuUsage * 0.4 + pod.memoryUsage * 0.2;
}

function selectPod(view: ClusterView, question: string, hint?: string): ContextPod {
  const q = `${question} ${hint ?? ''}`.toLowerCase();
  let best: ContextPod | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const pod of view.pods) {
    let score = rankPod(pod);
    if (q.includes(pod.id.toLowerCase()) || q.includes(pod.name.toLowerCase())) {
      score += 1000;
    }
    const deployment = deploymentOf(pod.name);
    if (deployment.length >= 4 && q.includes(deployment.toLowerCase())) {
      score += 1200;
    } else {
      const head = pod.name.split('-')[0] ?? '';
      if (head.length >= 5 && q.includes(head.toLowerCase())) {
        score += 800;
      }
    }
    if (score > bestScore) {
      best = pod;
      bestScore = score;
    }
  }
  if (best === null) {
    throw new Error('cluster view has no pods');
  }
  return best;
}

function classify(pod: ContextPod, node: ContextNode | null): FocusMode {
  if (pod.status === 'OOMKilled' || pod.memoryUsage >= 96) {
    return 'oom';
  }
  if (pod.status === 'CrashLoopBackOff') {
    return 'crash';
  }
  if (node?.status === 'NetworkPartition') {
    return 'partition';
  }
  if (node?.status === 'HighLoad' || pod.cpuUsage >= 80) {
    return 'saturation';
  }
  return 'steady';
}

function worstPod(pods: readonly ContextPod[]): ContextPod | null {
  let best: ContextPod | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const pod of pods) {
    const score = rankPod(pod);
    if (score > bestScore) {
      best = pod;
      bestScore = score;
    }
  }
  return best;
}

function worstOnNode(view: ClusterView, nodeId: string): ContextPod | null {
  const hosted: ContextPod[] = [];
  for (const pod of view.pods) {
    if (pod.nodeId === nodeId) {
      hosted.push(pod);
    }
  }
  return worstPod(hosted);
}

function findPod(view: ClusterView, id: string): ContextPod | null {
  for (const pod of view.pods) {
    if (pod.id === id || pod.name === id) {
      return pod;
    }
  }
  return null;
}

function questionNamesPod(view: ClusterView, text: string): ContextPod | null {
  const q = text.toLowerCase();
  let best: ContextPod | null = null;
  let bestScore = 0;
  for (const pod of view.pods) {
    let named = 0;
    if (q.includes(pod.id.toLowerCase()) || q.includes(pod.name.toLowerCase())) {
      named += 1000;
    }
    const deployment = deploymentOf(pod.name);
    if (deployment.length >= 4 && q.includes(deployment.toLowerCase())) {
      named += 1200;
    } else {
      const head = pod.name.split('-')[0] ?? '';
      if (head.length >= 5 && q.includes(head.toLowerCase())) {
        named += 800;
      }
    }
    if (named === 0) {
      continue;
    }
    const score = named + rankPod(pod);
    if (best === null || score > bestScore) {
      best = pod;
      bestScore = score;
    }
  }
  return best;
}

function chaosNode(view: ClusterView): ContextNode | null {
  const rack = CHAOS_TARGET_RACK[view.activeChaos];
  if (rack === null) {
    return null;
  }
  const label = RACK_WORKER_LABEL[rack];
  for (const node of view.nodes) {
    if (node.name === label || node.id === label) {
      return node;
    }
  }
  return null;
}

function chaosCandidates(view: ClusterView): ContextPod[] {
  const node = chaosNode(view);
  const onNode =
    node === null ? [...view.pods] : view.pods.filter((pod) => pod.nodeId === node.id);
  if (view.activeChaos === 'NODE_CPU_SPIKE') {
    const running = onNode.filter((pod) => pod.status === 'Running');
    return running.length > 0 ? running : onNode;
  }
  if (view.activeChaos === 'POD_OOM_SWARM') {
    const hot = onNode.filter((pod) => pod.status === 'OOMKilled' || pod.memoryUsage >= 80);
    return hot.length > 0 ? hot : onNode;
  }
  if (view.activeChaos === 'NET_PACKET_LOSS') {
    const stranded = onNode.filter((pod) => pod.status === 'Pending' || pod.status === 'Terminating');
    return stranded.length > 0 ? stranded : onNode;
  }
  return onNode;
}

function finishFocus(pod: ContextPod, node: ContextNode | null, mode: FocusMode, reason: FocusReason): Focus {
  return { pod, node, mode, reason };
}

function namedNode(view: ClusterView, text: string): ContextNode | null {
  const q = text.toLowerCase();
  for (const node of view.nodes) {
    if (q.includes(node.id.toLowerCase()) || q.includes(node.name.toLowerCase())) {
      return node;
    }
  }
  return null;
}

function focusOf(view: ClusterView, question: string, hint?: string): Focus {
  const haystack = `${question} ${hint ?? ''}`;
  const askedDrain = /排空|驱逐|drain/.test(haystack.toLowerCase());
  const picked = namedNode(view, haystack);
  if (picked !== null && askedDrain) {
    const pod = worstOnNode(view, picked.id) ?? selectPod(view, question, hint);
    const mode = picked.status === 'NetworkPartition' ? 'partition' : classify(pod, picked);
    return finishFocus(pod, picked, mode, 'named');
  }
  const namedPod = questionNamesPod(view, question);
  if (namedPod !== null) {
    const node = nodeOf(view, namedPod.nodeId);
    return finishFocus(namedPod, node, classify(namedPod, node), 'named');
  }
  if (view.selectedEntityId !== null && view.selectedEntityType !== 'master') {
    if (view.selectedEntityType !== 'node') {
      const selectedPod = findPod(view, view.selectedEntityId);
      if (selectedPod !== null) {
        const node = nodeOf(view, selectedPod.nodeId);
        return finishFocus(selectedPod, node, classify(selectedPod, node), 'selection');
      }
    }
    if (view.selectedEntityType !== 'pod') {
      const selectedNode = nodeOf(view, view.selectedEntityId);
      if (selectedNode !== null) {
        const pod = worstOnNode(view, selectedNode.id) ?? selectPod(view, question, hint);
        const mode =
          selectedNode.status === 'NetworkPartition' || view.activeChaos === 'NET_PACKET_LOSS'
            ? 'partition'
            : classify(pod, selectedNode);
        return finishFocus(pod, selectedNode, mode, 'selection');
      }
    }
  }
  if (view.activeChaos !== 'NONE') {
    const victim = worstPod(chaosCandidates(view));
    if (victim !== null) {
      const node = nodeOf(view, victim.nodeId);
      const classified = classify(victim, node);
      const mode =
        view.activeChaos === 'NET_PACKET_LOSS'
          ? 'partition'
          : view.activeChaos === 'NODE_CPU_SPIKE' && classified !== 'oom' && classified !== 'crash'
            ? 'saturation'
            : classified === 'steady' && view.activeChaos === 'POD_OOM_SWARM'
              ? 'oom'
              : classified;
      return finishFocus(victim, node, mode, 'chaos');
    }
  }
  const abnormal = view.pods.filter(
    (pod) => view.abnormalPodIds.includes(pod.id) || view.abnormalPodIds.includes(pod.name),
  );
  const abnormalPod = worstPod(abnormal);
  if (abnormalPod !== null) {
    const node = nodeOf(view, abnormalPod.nodeId);
    return finishFocus(abnormalPod, node, classify(abnormalPod, node), 'abnormal');
  }
  const pod = selectPod(view, question, hint);
  const node = nodeOf(view, pod.nodeId);
  return finishFocus(pod, node, classify(pod, node), 'rank');
}

function detectIntent(question: string): Intent {
  const q = question.toLowerCase();
  const wantsCause = /根因|原因|为什么|为何|oom|crash|崩溃|证据|分析|诊断/.test(q);
  const wantsAction = /自愈|修复|重启|扩容|缩容|排空|驱逐|drain|restart|scale|处置/.test(q);
  const wantsMetrics = /指标|cpu|内存|memory|利用率|metrics|负载|telemetry|走势/.test(q);
  const hits = [wantsCause, wantsAction, wantsMetrics].filter(Boolean).length;
  if (hits === 0 || hits >= 2) {
    return 'full';
  }
  if (wantsCause) {
    return 'cause';
  }
  if (wantsAction) {
    return 'action';
  }
  return 'metrics';
}

function planTools(intent: Intent, mode: FocusMode): ToolKind[] {
  if (intent === 'metrics' && mode === 'steady') {
    return ['metrics'];
  }
  if (intent === 'cause') {
    return ['cause', 'metrics', 'action'];
  }
  if (intent === 'action') {
    return ['action', 'metrics', 'cause'];
  }
  return ['metrics', 'cause', 'action'];
}

function isAtRisk(pod: ContextPod): boolean {
  return (
    pod.status !== 'Running' ||
    pod.cpuUsage > 80 ||
    pod.memoryUsage > 80 ||
    pod.restarts > 0
  );
}

function shiftIso(iso: string, deltaMs: number): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return iso;
  }
  return new Date(parsed + deltaMs).toISOString();
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) {
    return text;
  }
  return chars.slice(0, max).join('');
}

function deploymentOf(podName: string): string {
  const parts = podName.split('-');
  if (parts.length >= 3) {
    return parts.slice(0, -2).join('-');
  }
  return podName;
}

function replicaCount(view: ClusterView, deployment: string): number {
  const prefix = `${deployment}-`;
  let count = 0;
  for (const pod of view.pods) {
    if (pod.name === deployment || pod.name.startsWith(prefix)) {
      count += 1;
    }
  }
  return Math.max(1, count);
}

function narratePod(focus: Focus): string {
  const { pod, node } = focus;
  const where = node !== null ? node.name : pod.nodeId;
  if (focus.mode === 'oom') {
    return `${pod.name} 在 ${where} 上内存 ${pod.memoryUsage.toFixed(1)}%，已触及 cgroup 上限并进入 ${pod.status}。`;
  }
  if (focus.mode === 'crash') {
    return `${pod.name} 处于 ${pod.status}，累计重启 ${pod.restarts} 次，所在节点 ${where}。`;
  }
  if (focus.mode === 'partition') {
    return `${where} 报告网络分区，${pod.name} 的指标已不能代表真实服务能力。`;
  }
  if (focus.mode === 'saturation') {
    return `${pod.name} CPU ${pod.cpuUsage.toFixed(1)}%，${where} 处于高负载，延迟会先于错误预算耗尽。`;
  }
  return `${pod.name} 当前 ${pod.status}，CPU ${pod.cpuUsage.toFixed(1)}%，内存 ${pod.memoryUsage.toFixed(1)}%，未超过告警阈值。`;
}

function buildPodMetrics(view: ClusterView, question: string, hint?: string, narrative?: string): PodMetricsCardProps {
  const focus = focusOf(view, question, hint);
  const sentence = narrative !== undefined && narrative.trim().length > 0 ? narrative.trim() : narratePod(focus);
  return renderPodMetricsParameters.parse({
    podId: focus.pod.id,
    podName: focus.pod.name,
    namespace: focus.pod.namespace,
    nodeId: focus.pod.nodeId,
    status: focus.pod.status,
    cpuUsage: focus.pod.cpuUsage,
    memoryUsage: focus.pod.memoryUsage,
    restarts: focus.pod.restarts,
    cpuHistory: focus.pod.cpuHistory,
    memHistory: focus.pod.memHistory,
    narrative: clip(sentence, 280),
    atRisk: isAtRisk(focus.pod),
  });
}

function severityOf(mode: FocusMode, pod: ContextPod): IncidentSeverity {
  if (mode === 'oom' && (pod.memoryUsage >= 90 || pod.restarts >= 3)) {
    return 'P0';
  }
  if (mode === 'crash' && pod.restarts >= 5) {
    return 'P0';
  }
  if (mode === 'oom' || mode === 'crash' || mode === 'partition') {
    return 'P1';
  }
  if (mode === 'saturation') {
    return 'P1';
  }
  return 'P2';
}

function confidenceOf(mode: FocusMode): number {
  if (mode === 'oom') {
    return 0.93;
  }
  if (mode === 'crash') {
    return 0.88;
  }
  if (mode === 'partition') {
    return 0.9;
  }
  if (mode === 'saturation') {
    return 0.84;
  }
  return 0.62;
}

function buildRootCause(view: ClusterView, question: string, hint?: string): RootCauseAlertProps {
  const focus = focusOf(view, question, hint);
  const { pod, node } = focus;
  const when = view.timestamp;
  const nodeLabel = node?.name ?? pod.nodeId;
  const deployment = deploymentOf(pod.name);
  const severity = severityOf(focus.mode, pod);
  let title = `${pod.name} 运行正常，未形成事故`;
  let summary = `${pod.name} 的 CPU 与内存都低于 80%，节点 ${nodeLabel} 也没有分区或高负载标记。继续观察即可。`;
  let chain: z.infer<typeof evidenceSchema>[] = [
    {
      signal: 'metrics.within_slo',
      detail: `CPU ${pod.cpuUsage.toFixed(1)}%，内存 ${pod.memoryUsage.toFixed(1)}%，最近 ${pod.cpuHistory.length} 个周期没有越过 80% 阈值。`,
      weight: 0.7,
      source: 'metrics',
      observedAt: shiftIso(when, -2000),
    },
    {
      signal: 'topology.node_ready',
      detail: `${nodeLabel} 状态 ${node?.status ?? 'Ready'}，调度器没有把这个 Pod 标成不可达。`,
      weight: 0.3,
      source: 'topology',
      observedAt: when,
    },
  ];
  if (focus.mode === 'oom') {
    title = `${pod.name} 内存触顶后被 cgroup OOM killer 回收`;
    summary = `${pod.name} 内存 ${pod.memoryUsage.toFixed(1)}%，状态 ${pod.status}。入口流量抬升后工作集越过限制，内核按 cgroup 回收了容器，kubelet 记下重启。`;
    chain = [
      {
        signal: 'Ingress Traffic Surge',
        detail: `${pod.namespace}/${pod.name} 所在路径的请求抬升与内存曲线同向，先于 OOM 约一个采样周期。`,
        weight: 0.22,
        source: 'metrics',
        observedAt: shiftIso(when, -5000),
      },
      {
        signal: 'Pod Memory Limit Exceeded (512Mi)',
        detail: `内存 ${pod.memoryUsage.toFixed(1)}%，历史末值 ${pod.memHistory[pod.memHistory.length - 1] ?? pod.memoryUsage}%，已越过 80% 告警线并贴着 limit。`,
        weight: 0.33,
        source: 'events',
        observedAt: shiftIso(when, -2000),
      },
      {
        signal: 'Linux Kernel Cgroup OOM Killer Invoked',
        detail: `内核在 ${pod.name} 的 cgroup 上调用 OOM killer，容器进入 ${pod.status}，累计重启 ${pod.restarts} 次。`,
        weight: 0.45,
        source: 'logs',
        observedAt: when,
      },
    ];
  } else if (focus.mode === 'crash') {
    title = `${pod.name} 陷入 CrashLoopBackOff`;
    summary = `${pod.name} 已重启 ${pod.restarts} 次，状态 ${pod.status}。进程在就绪探针通过前退出，退避窗口会继续拉长。`;
    chain = [
      {
        signal: 'pod.restart_burst',
        detail: `重启计数 ${pod.restarts}，CPU 在退出间隙掉到 ${pod.cpuUsage.toFixed(1)}%，不是一条平稳的服务曲线。`,
        weight: 0.4,
        source: 'metrics',
        observedAt: shiftIso(when, -4000),
      },
      {
        signal: 'kubelet.backoff',
        detail: `kubelet 已把 ${pod.name} 标为 CrashLoopBackOff，下一次启动会按指数退避推迟。`,
        weight: 0.35,
        source: 'events',
        observedAt: shiftIso(when, -1500),
      },
      {
        signal: 'container.exit',
        detail: `容器在 ${nodeLabel} 上反复退出。隔离重启可以清空这次沙箱，但先要确认不是配置错误。`,
        weight: 0.25,
        source: 'logs',
        observedAt: when,
      },
    ];
  } else if (focus.mode === 'partition') {
    title = `${nodeLabel} 网络分区，${pod.name} 指标失真`;
    summary = `${nodeLabel} 为 NetworkPartition。该节点上的 Pod 看起来像是 Pending 或零流量，实际是 kubelet 心跳丢失，不是应用自己缩到了零。`;
    chain = [
      {
        signal: 'node.network_partition',
        detail: `${nodeLabel} 状态 NetworkPartition，控制面无法再相信它的就绪探针。`,
        weight: 0.5,
        source: 'topology',
        observedAt: shiftIso(when, -3000),
      },
      {
        signal: 'pod.metrics_collapsed',
        detail: `${pod.name} CPU ${pod.cpuUsage.toFixed(1)}%、内存 ${pod.memoryUsage.toFixed(1)}%，读数随心跳一起塌陷。`,
        weight: 0.3,
        source: 'metrics',
        observedAt: shiftIso(when, -1000),
      },
      {
        signal: 'kubelet.unreachable',
        detail: '节点心跳超时后，调度器不会把新 Pod 放上来，已在跑的副本需要排空或等待恢复。',
        weight: 0.2,
        source: 'events',
        observedAt: when,
      },
    ];
  } else if (focus.mode === 'saturation') {
    title = `${nodeLabel} 高负载，${pod.name} CPU ${pod.cpuUsage.toFixed(1)}%`;
    summary = `${nodeLabel} 处于高负载，${deployment} 的热点副本把 CPU 推到 ${pod.cpuUsage.toFixed(1)}%。这是容量问题，不是进程崩溃。`;
    chain = [
      {
        signal: 'node.high_load',
        detail: `${nodeLabel} 状态 ${node?.status ?? 'HighLoad'}，同节点副本共享这条算力。`,
        weight: 0.34,
        source: 'topology',
        observedAt: shiftIso(when, -4000),
      },
      {
        signal: 'pod.cpu_saturation',
        detail: `${pod.name} CPU ${pod.cpuUsage.toFixed(1)}%，最近样本 ${pod.cpuHistory.join(' → ')}。`,
        weight: 0.46,
        source: 'metrics',
        observedAt: shiftIso(when, -1500),
      },
      {
        signal: 'scheduler.pressure',
        detail: '继续把流量打在同一副本上会先消耗错误预算。扩容可以把单副本利用率拉回阈值以下。',
        weight: 0.2,
        source: 'events',
        observedAt: when,
      },
    ];
  }
  const actionKind = chooseAction(focus, question).actionType;
  return renderRootCauseAnalysisParameters.parse({
    incidentId: `inc-${pod.id}`,
    severity,
    title: clip(title, 80),
    rootCauseSummary: clip(summary, 480),
    evidenceChain: chain,
    recommendedActions: [
      {
        kind: actionKind,
        label: actionKind === 'drain_node' ? `排空 ${nodeLabel}` : actionKind === 'scale_deployment' ? `扩容 ${deployment}` : `重启隔离 ${pod.name}`,
        requiresConfirmation: true,
      },
      {
        kind: 'inspect_logs',
        label: `核对 ${pod.name} 最近容器日志`,
        requiresConfirmation: false,
      },
    ],
    confidence: confidenceOf(focus.mode),
    detectedAt: shiftIso(when, -5000),
    affectedIds: node !== null ? [pod.id, node.id] : [pod.id],
  });
}

interface ActionChoice {
  readonly actionType: ActionConfirmProps['actionType'];
}

function chooseAction(focus: Focus, question: string): ActionChoice {
  const q = question.toLowerCase();
  const asksDrain = /排空|驱逐|drain/.test(q);
  const asksScale = /扩容|缩容|副本|scale/.test(q);
  if ((asksDrain || focus.mode === 'partition') && focus.node !== null) {
    return { actionType: 'drain_node' };
  }
  if (asksScale || focus.mode === 'saturation') {
    return { actionType: 'scale_deployment' };
  }
  return { actionType: 'restart_pod' };
}

function buildAction(view: ClusterView, question: string, hint?: string): ActionConfirmProps {
  const focus = focusOf(view, question, hint);
  const choice = chooseAction(focus, question);
  const deployment = deploymentOf(focus.pod.name);
  const nodeLabel = focus.node?.name ?? focus.pod.nodeId;
  if (choice.actionType === 'drain_node' && focus.node !== null) {
    return proposeRemediationActionParameters.parse({
      requestId: `heal-drain-${focus.node.id}`,
      actionType: 'drain_node',
      targetId: focus.node.id,
      targetLabel: focus.node.name,
      executionState: 'pending_confirmation',
      rationale: `${nodeLabel} 上的故障已经影响到调度，排空可以把工作负载移走。`,
      impactDescription: `排空 ${focus.node.name} 会驱逐该节点上的全部 Pod，属于高危操作，执行前必须勾选风险确认。`,
    });
  }
  if (choice.actionType === 'scale_deployment') {
    const replicas = replicaCount(view, deployment);
    return proposeRemediationActionParameters.parse({
      requestId: `heal-scale-${deployment}`,
      actionType: 'scale_deployment',
      targetId: deployment,
      targetLabel: deployment,
      executionState: 'pending_confirmation',
      rationale: `${focus.pod.name} 的单副本负载过高，把 ${deployment} 从 ${replicas} 扩到 ${replicas + 1} 可以摊薄 CPU。`,
      desiredReplicas: Math.min(6, replicas + 1),
      impactDescription: `只增加 ${deployment} 的副本数，不会删除现有 Pod，也不会排空节点。`,
    });
  }
  return proposeRemediationActionParameters.parse({
    requestId: `heal-restart-${focus.pod.id}`,
    actionType: 'restart_pod',
    targetId: focus.pod.id,
    targetLabel: focus.pod.name,
    executionState: 'pending_confirmation',
    rationale: `${focus.pod.name} 当前是 ${focus.pod.status}，隔离重启会重建这个沙箱并让它回到 Running。`,
    impactDescription: `只重建 ${focus.pod.namespace}/${focus.pod.name} 这一个副本，同节点其他 Pod 保持不动。`,
  });
}

function digest(view: ClusterView): string {
  const lines: string[] = [
    `timestamp: ${view.timestamp}`,
    `selectedEntityId: ${view.selectedEntityId ?? 'none'}`,
    `selectedEntityType: ${view.selectedEntityType ?? 'none'}`,
    `activeChaos: ${view.activeChaos}`,
    `abnormalPods: ${view.abnormalPodIds.length === 0 ? 'none' : view.abnormalPodIds.join(',')}`,
  ];
  for (const node of view.nodes) {
    lines.push(`node ${node.name} id=${node.id} status=${node.status}`);
  }
  for (const pod of view.pods) {
    lines.push(
      `pod ${pod.name} id=${pod.id} ns=${pod.namespace} node=${pod.nodeId} status=${pod.status} cpu=${pod.cpuUsage.toFixed(1)} mem=${pod.memoryUsage.toFixed(1)} restarts=${pod.restarts}`,
    );
  }
  for (const alert of view.alerts) {
    if (!alert.resolved) {
      lines.push(`alert ${alert.severity} ${alert.sourceId} ${alert.title}`);
    }
  }
  return lines.join('\n');
}

const FOCUS_REASON_LINE: Record<FocusReason, string> = {
  named: '定位依据：提问里点名的对象。',
  selection: '定位依据：当前 3D 场景选中的实体。',
  chaos: '定位依据：正在进行的混沌故障场景。',
  abnormal: '定位依据：当前异常 Pod 列表。',
  rank: '定位依据：快照里负载最高的 Pod。',
};

function composeLead(view: ClusterView, focus: Focus, reason: FallbackReason): string {
  const where = focus.node?.name ?? focus.pod.nodeId;
  const banner =
    reason === 'no-key'
      ? '未检测到可用的 OPENAI_API_KEY，以下由内置 SRE 仿真器按当前快照确定性生成，无需密钥即可走完生成式 UI。'
      : '模型接口没有返回可用结果，已降级到内置 SRE 仿真器。卡片数字仍取自当前集群快照。';
  const scene = `选中 ${view.selectedEntityId ?? '无'}，混沌 ${view.activeChaos}，异常 Pod ${view.abnormalPodIds.length} 个。`;
  return [
    '## 现场判断',
    '',
    banner,
    '',
    scene,
    FOCUS_REASON_LINE[focus.reason],
    '',
    `\`${focus.pod.name}\`（\`${focus.pod.namespace}\` / \`${where}\`）状态 **${focus.pod.status}**，CPU ${focus.pod.cpuUsage.toFixed(1)}%，内存 ${focus.pod.memoryUsage.toFixed(1)}%，重启 ${focus.pod.restarts} 次。`,
    '',
    narratePod(focus),
    '',
    '下面按顺序给出指标卡、根因证据链和待确认的自愈指令。',
    '',
  ].join('\n');
}

function composeClose(action: ActionConfirmProps): string {
  const drain =
    action.actionType === 'drain_node'
      ? '这次建议是节点排空，确认卡会锁住执行按钮，直到勾选高危操作风险提示。'
      : '确认卡不会直接调用 Kube-API。若要排空整台节点，请明确说「排空」并加上节点名。';
  return ['', '### 处置边界', '', drain, ''].join('\n');
}

/* ==========================================================================
   Simulator stream
   ========================================================================== */

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      finish();
    };
    function finish(): void {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function pieces(text: string, size: number): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let index = 0; index < chars.length; index += size) {
    out.push(chars.slice(index, index + size).join(''));
  }
  return out;
}

async function writeText(writer: DataStreamWriter, text: string, signal: AbortSignal): Promise<boolean> {
  for (const piece of pieces(text, TYPEWRITER_CHARS)) {
    if (signal.aborted) {
      return false;
    }
    writer.write(formatDataStreamPart('text', piece));
    await delay(TYPEWRITER_MS, signal);
  }
  return !signal.aborted;
}

async function writeTool(
  writer: DataStreamWriter,
  toolName: string,
  toolCallId: string,
  payload: PodMetricsCardProps | RootCauseAlertProps | ActionConfirmProps,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) {
    return false;
  }
  writer.write(formatDataStreamPart('tool_call_streaming_start', { toolCallId, toolName }));
  const json = JSON.stringify(payload);
  for (const piece of pieces(json, TOOL_ARG_CHARS)) {
    if (signal.aborted) {
      return false;
    }
    writer.write(formatDataStreamPart('tool_call_delta', { toolCallId, argsTextDelta: piece }));
    await delay(TOOL_ARG_MS, signal);
  }
  if (signal.aborted) {
    return false;
  }
  writer.write(formatDataStreamPart('tool_call', { toolCallId, toolName, args: payload }));
  writer.write(formatDataStreamPart('tool_result', { toolCallId, result: payload }));
  return true;
}

function simulatorResponse(
  view: ClusterView,
  question: string,
  reason: FallbackReason,
  signal: AbortSignal,
): Response {
  const focus = focusOf(view, question);
  const tools = planTools(detectIntent(question), focus.mode);
  const metrics = buildPodMetrics(view, question);
  const cause = buildRootCause(view, question);
  const action = buildAction(view, question);
  const lead = composeLead(view, focus, reason);
  const close = composeClose(action);
  const completionTokens = Array.from(lead + close).length;

  return createDataStreamResponse({
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-KubeVision-SRE-Mode': 'simulator',
    },
    execute: async (writer) => {
      writer.write(formatDataStreamPart('start_step', { messageId: `sre-${focus.pod.id}` }));
      const typed = await writeText(writer, lead, signal);
      if (!typed) {
        return;
      }
      for (const kind of tools) {
        const payload = kind === 'metrics' ? metrics : kind === 'cause' ? cause : action;
        const toolName =
          kind === 'metrics'
            ? 'renderPodMetrics'
            : kind === 'cause'
              ? 'renderRootCauseAnalysis'
              : 'proposeRemediationAction';
        const wrote = await writeTool(writer, toolName, `kv-${kind}-${focus.pod.id}`, payload, signal);
        if (!wrote) {
          return;
        }
      }
      const closed = await writeText(writer, close, signal);
      if (!closed) {
        return;
      }
      const usage = { promptTokens: 0, completionTokens };
      writer.write(
        formatDataStreamPart('finish_step', {
          isContinued: false,
          finishReason: 'stop',
          usage,
        }),
      );
      writer.write(formatDataStreamPart('finish_message', { finishReason: 'stop', usage }));
    },
  });
}

/* ==========================================================================
   Live model
   ========================================================================== */

function createSreTools(view: ClusterView, question: string) {
  return {
    renderPodMetrics: tool({
      description:
        '提取目标 Pod 的实时 CPU、内存、重启次数和近 6 个周期曲线，供前端渲染 PodMetricsCard。参数中的数字会被服务端用集群快照覆盖。',
      parameters: renderPodMetricsParameters,
      execute: async (args) => buildPodMetrics(view, question, args.podId, args.narrative),
    }),
    renderRootCauseAnalysis: tool({
      description:
        '针对 OOMKilled、CrashLoopBackOff 或高负载节点输出结构化根因证据链，供前端渲染 RootCauseAlert。',
      parameters: renderRootCauseAnalysisParameters,
      execute: async (args) => buildRootCause(view, question, args.affectedIds[0] ?? args.incidentId),
    }),
    proposeRemediationAction: tool({
      description:
        '给出尚未执行的自愈指令。restart_pod、scale_deployment 或 drain_node，供前端渲染 ActionConfirm。executionState 必须保持 pending_confirmation。',
      parameters: proposeRemediationActionParameters,
      execute: async (args) => buildAction(view, `${question}\n${args.actionType}`, args.targetId),
    }),
  };
}

function chunkHas(text: string, code: string): boolean {
  return text.startsWith(`${code}:`) || text.includes(`\n${code}:`);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) {
    length += part.byteLength;
  }
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

async function openModelStream(
  view: ClusterView,
  messages: CoreMessage[],
  question: string,
  signal: AbortSignal,
): Promise<Response | null> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!usableApiKey(apiKey)) {
    return null;
  }
  const baseURL = normalizeBaseUrl(process.env.OPENAI_BASE_URL);
  const provider = createOpenAI({
    apiKey,
    baseURL,
    compatibility: baseURL !== undefined && !baseURL.includes('api.openai.com') ? 'compatible' : 'strict',
  });
  const modelAbort = new AbortController();
  const onUserAbort = (): void => {
    modelAbort.abort();
  };
  signal.addEventListener('abort', onUserAbort);
  const timer = setTimeout(() => {
    modelAbort.abort();
  }, MODEL_FIRST_BYTE_MS);

  try {
    const result = streamText({
      model: provider.chat(resolveModelId(baseURL)),
      system: `${SRE_SYSTEM_PROMPT}\n\n# 当前集群快照\n${digest(view)}`,
      messages,
      tools: createSreTools(view, question),
      toolChoice: 'auto',
      maxSteps: 4,
      maxRetries: 0,
      temperature: 0.2,
      toolCallStreaming: true,
      abortSignal: modelAbort.signal,
    });
    const reader = result.toDataStream({ sendUsage: true }).getReader();
    const buffered: Uint8Array[] = [];
    const decoder = new TextDecoder();
    let sawContent = false;
    let sawError = false;
    while (!sawContent && !sawError) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      buffered.push(next.value);
      const text = decoder.decode(next.value, { stream: true });
      if (chunkHas(text, '3')) {
        sawError = true;
      }
      if (chunkHas(text, '0') || chunkHas(text, '9') || chunkHas(text, 'b') || chunkHas(text, 'c')) {
        sawContent = true;
      }
    }
    if (!sawContent || signal.aborted) {
      modelAbort.abort();
      await reader.cancel().catch(() => undefined);
      return null;
    }
    clearTimeout(timer);
    const merged = concatBytes(buffered);
    let primed = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!primed) {
          primed = true;
          controller.enqueue(merged);
          return;
        }
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      },
      cancel(reason) {
        modelAbort.abort();
        return reader.cancel(reason);
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Vercel-AI-Data-Stream': 'v1',
        'X-KubeVision-SRE-Mode': 'openai',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown model error';
    console.error(`[chat] model pipeline failed, using simulator: ${message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ==========================================================================
   POST
   ========================================================================== */

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: '请求体不是 JSON' }, { status: 400 });
  }
  if (!isRecord(body)) {
    return Response.json({ error: '请求体必须是对象' }, { status: 400 });
  }

  const view = parseCluster(readClusterContext(body));
  let messages = toCoreMessages(body.messages);
  const asked = lastUserText(messages);
  const question = asked.length > 0 ? asked : DEFAULT_QUESTION;
  if (asked.length === 0) {
    messages = [...messages, { role: 'user', content: DEFAULT_QUESTION }];
  }

  if (request.signal.aborted) {
    return new Response(null, { status: 499 });
  }

  if (usableApiKey(process.env.OPENAI_API_KEY)) {
    const live = await openModelStream(view, messages, question, request.signal);
    if (live !== null) {
      return live;
    }
    if (request.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    return simulatorResponse(view, question, 'model-error', request.signal);
  }

  return simulatorResponse(view, question, 'no-key', request.signal);
}
