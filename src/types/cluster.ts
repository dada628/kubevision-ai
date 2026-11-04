/**
 * KubeVision AI - Cluster telemetry type contract.
 *
 * This module is the single source of truth for every Kubernetes-shaped entity
 * that crosses a layer boundary (mock generator -> Zustand store -> R3F canvas
 * -> API route -> AI tool schema). Nothing here may import React, three, or any
 * runtime dependency: these are erased types plus `const` discriminant tuples.
 *
 * Strictness rules enforced by this file:
 * - Zero `any`, zero `@ts-ignore`, zero index signatures widening to `any`.
 * - Every closed set is a `readonly` tuple + derived union, so runtime
 *   validation and compile-time narrowing can never drift apart.
 * - Numeric ranges (percentages, rack indices, bounded scores) are documented
 *   on the field AND exposed as type guards, because TypeScript cannot encode
 *   `0 <= x <= 100` in the type system without nominal branding.
 */

/* ==========================================================================
   Closed discriminant sets
   ========================================================================== */

/** Every lifecycle state a pod can be observed in. */
export const POD_STATUSES = [
  'Running',
  'Pending',
  'CrashLoopBackOff',
  'OOMKilled',
  'Terminating',
] as const;

export type PodStatus = (typeof POD_STATUSES)[number];

/** Every state a worker node can be reported in. */
export const NODE_STATUSES = [
  'Ready',
  'HighLoad',
  'NetworkPartition',
] as const;

export type NodeStatus = (typeof NODE_STATUSES)[number];

/** Chaos injection modes driven by the demo control surface. */
export const CHAOS_SCENARIOS = [
  'NONE',
  'POD_OOM_SWARM',
  'NODE_CPU_SPIKE',
  'NET_PACKET_LOSS',
] as const;

export type ChaosScenario = (typeof CHAOS_SCENARIOS)[number];

/** Incident grading used by both the alert stream and the AI copilot cards. */
export const INCIDENT_SEVERITIES = ['P0', 'P1', 'P2'] as const;

export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

/* ==========================================================================
   Scalar contracts
   ========================================================================== */

/**
 * ISO-8601 UTC instant, e.g. `2026-11-04T14:59:12.000Z`.
 * Kept as a string so snapshots stay JSON-serializable across the RSC boundary
 * and inside the AI SDK tool payloads.
 */
export type IsoTimestamp = string;

/**
 * A number in the inclusive range [0, 100].
 * NOT branded: branding would force `as Percentage` casts across every fixture
 * and every AI tool result. The invariant is enforced by `isPercentage` at the
 * trust boundary (snapshot ingestion, Postgres read, model output).
 */
export type Percentage = number;

/** A number in the inclusive range [0, 1]. */
export type UnitInterval = number;

/** Physical rack slot in the 3D scene. Drives X-axis placement in the canvas. */
export type RackIndex = 0 | 1 | 2;

/** Number of trailing samples retained per metric ring buffer. */
export const TELEMETRY_HISTORY_LENGTH = 6;

/** Rack slots the topology is allowed to occupy. */
export const RACK_INDICES: readonly RackIndex[] = [0, 1, 2];

/* ==========================================================================
   Pod entity
   ========================================================================== */

/**
 * One pod as rendered in the topology.
 *
 * `cpuUsage` / `memoryUsage` are utilization percentages relative to the
 * pod's own request/limit, not absolute cores/MiB.
 *
 * `cpuHistory` / `memHistory` are ring buffers holding at most
 * `TELEMETRY_HISTORY_LENGTH` (6) trailing samples, oldest first. Consumers
 * MUST treat the array as append-only and trim from the head; the R3F layer
 * reads it through a transient ref and never re-renders on mutation.
 */
export interface PodEntity {
  readonly id: string;
  readonly name: string;
  readonly namespace: string;
  /** Owning `WorkerNodeEntity.id`. */
  readonly nodeId: string;
  readonly status: PodStatus;
  /** Utilization in [0, 100]. */
  readonly cpuUsage: Percentage;
  /** Utilization in [0, 100]. */
  readonly memoryUsage: Percentage;
  /** Non-negative restart count over the pod's lifetime. */
  readonly restarts: number;
  /** Cluster-internal IPv4 literal, e.g. `10.244.2.17`. */
  readonly ip: string;
  readonly createdAt: IsoTimestamp;
  /** Last 6 CPU utilization percentages, oldest first. Length <= 6. */
  readonly cpuHistory: number[];
  /** Last 6 memory utilization percentages, oldest first. Length <= 6. */
  readonly memHistory: number[];
}

/* ==========================================================================
   Node entity
   ========================================================================== */

/**
 * One schedulable worker node.
 *
 * `cpuCapacity` is measured in cores; `memCapacity` is measured in MiB;
 * `networkMbps` is the provisioned NIC throughput in megabits per second.
 */
export interface WorkerNodeEntity {
  readonly id: string;
  readonly name: string;
  /** Node-internal IPv4 literal, e.g. `10.0.3.11`. */
  readonly ip: string;
  readonly status: NodeStatus;
  /** Allocatable CPU cores. */
  readonly cpuCapacity: number;
  /** Allocatable memory in MiB. */
  readonly memCapacity: number;
  /** Provisioned network throughput in Mbps. */
  readonly networkMbps: number;
  /** Which of the three visual racks this node is bolted into. */
  readonly rackIndex: RackIndex;
  /** Ids of pods scheduled onto this node. References `PodEntity.id`. */
  readonly podIds: string[];
}

/* ==========================================================================
   Alert entity
   ========================================================================== */

/** Which kind of object an alert originates from. */
export const ALERT_SOURCE_TYPES = ['pod', 'node', 'cluster'] as const;

export type AlertSourceType = (typeof ALERT_SOURCE_TYPES)[number];

/**
 * A single entry in the cluster alert stream.
 *
 * `sourceId` references `PodEntity.id`, `WorkerNodeEntity.id`, or the literal
 * `'cluster'` when `sourceType === 'cluster'`.
 */
export interface AlertEvent {
  readonly id: string;
  readonly severity: IncidentSeverity;
  readonly sourceType: AlertSourceType;
  readonly sourceId: string;
  readonly title: string;
  readonly message: string;
  readonly timestamp: IsoTimestamp;
  /** True once an operator (or the copilot) has taken ownership of the alert. */
  readonly acknowledged: boolean;
  /** True once the underlying condition has cleared. */
  readonly resolved: boolean;
}

/* ==========================================================================
   Control plane entity
   ========================================================================== */

/**
 * The single control-plane (master) node.
 *
 * The master is deliberately NOT a `WorkerNodeEntity`: it does not host
 * application pods, has no rack slot, and therefore never receives a node in
 * the `nodes` array. The 3D scene renders it as a detached control-plane
 * beacon above the racks.
 *
 * `notes` carries the human-readable metadata blurb shown in the HUD's
 * "control plane" drawer - remediation hints, upgrade channel, etc. Plain text,
 * no markdown, so it can be rendered without a sanitizer.
 */
export interface MasterNodeEntity {
  readonly id: string;
  readonly name: string;
  /** Control-plane IPv4 literal, e.g. `10.0.3.10`. */
  readonly ip: string;
  /** Literal discriminant: there is exactly one master in this topology. */
  readonly role: 'control-plane';
  readonly status: NodeStatus;
  /** e.g. `v1.30.4`. */
  readonly kubernetesVersion: string;
  readonly region: string;
  readonly zone: string;
  /** API server URL exposed to workers and to `kubectl`. */
  readonly apiServerEndpoint: string;
  /** Number of etcd members in the quorum (odd, >= 1). */
  readonly etcdClusterSize: number;
  /** Allocatable CPU cores reserved for the control plane. */
  readonly cpuCapacity: number;
  /** Allocatable memory in MiB. */
  readonly memCapacity: number;
  /** One-paragraph metadata blurb rendered in the HUD. Plain text. */
  readonly notes: string;
}

/* ==========================================================================
   Snapshot envelope
   ========================================================================== */

/**
 * A point-in-time view of the whole cluster, produced once per telemetry tick.
 *
 * This is the ONLY object the Zustand telemetry store commits to React state;
 * per-pod high-frequency deltas bypass it through the transient ref channel
 * described in `.cursorrules`.
 */
export interface TelemetrySnapshot {
  readonly timestamp: IsoTimestamp;
  /** Composite health score in [0, 100]; 100 is fully healthy. */
  readonly clusterHealthScore: Percentage;
  /** Total inbound queries per second across all ingress paths. */
  readonly totalQps: number;
  /** The control plane. Exactly one; never appears in `nodes`. */
  readonly master: MasterNodeEntity;
  readonly nodes: WorkerNodeEntity[];
  readonly pods: PodEntity[];
  readonly activeAlerts: AlertEvent[];
}

/* ==========================================================================
   Runtime guards - the only place numeric ranges are trusted
   ========================================================================== */

export function isPodStatus(value: unknown): value is PodStatus {
  return (
    typeof value === 'string' &&
    (POD_STATUSES as readonly string[]).includes(value)
  );
}

export function isNodeStatus(value: unknown): value is NodeStatus {
  return (
    typeof value === 'string' &&
    (NODE_STATUSES as readonly string[]).includes(value)
  );
}

export function isChaosScenario(value: unknown): value is ChaosScenario {
  return (
    typeof value === 'string' &&
    (CHAOS_SCENARIOS as readonly string[]).includes(value)
  );
}

export function isIncidentSeverity(value: unknown): value is IncidentSeverity {
  return (
    typeof value === 'string' &&
    (INCIDENT_SEVERITIES as readonly string[]).includes(value)
  );
}

export function isRackIndex(value: unknown): value is RackIndex {
  return value === 0 || value === 1 || value === 2;
}

/** True when `value` is a finite number inside [0, 100]. */
export function isPercentage(value: unknown): value is Percentage {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

/** True when `value` is a finite number inside [0, 1]. */
export function isUnitInterval(value: unknown): value is UnitInterval {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

/**
 * Clamp an arbitrary number into [0, 100]. Use this when writing a value that
 * originates outside the type system (model output, CSV import, WebSocket
 * frame) instead of casting.
 */
export function clampPercentage(value: number): Percentage {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

/**
 * Clamp an arbitrary number into [0, 1]. Returns 0 for non-finite input.
 */
export function clampUnitInterval(value: number): UnitInterval {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/* ==========================================================================
   Static seed - INITIAL_CLUSTER_SNAPSHOT
   ========================================================================== */

/**
 * Deterministic bootstrap snapshot used by three consumers:
 *
 * 1. `app/page.tsx` server render - the HUD paints real numbers on the very
 *    first frame instead of skeletons.
 * 2. The R3F canvas initialiser - `InstancedMesh` matrices are seeded from a
 *    stable object so the first `useFrame` tick has a valid previous state.
 * 3. Tests and Storybook - no clock, no randomness, no network.
 *
 * DETERMINISM CONTRACT: every timestamp below is a frozen literal. This module
 * must NEVER call `Date.now()`, `Math.random()`, or `crypto.randomUUID()`;
 * doing so would produce a fresh timestamp on the server and a different one on
 * the client, causing hydration mismatch in any component that renders a
 * relative time. Live ticks come later from the mock generator.
 *
 * TOPOLOGY: 1 control plane + 3 worker racks (alpha/beta/gamma) + 24 pods.
 *   alpha  -> rack 0 -> 9 pods (10.244.0.x)
 *   beta   -> rack 1 -> 8 pods (10.244.1.x)
 *   gamma  -> rack 2 -> 7 pods (10.244.2.x)
 * The four non-`Running` pods are intentional, so the very first paint already
 * exercises every telemetry tone: CrashLoopBackOff, OOMKilled, Pending,
 * Terminating, plus one HighLoad node.
 */

/**
 * The control plane. Rendered as a beacon above the three racks, never as a
 * rack slot, and never included in `nodes`.
 */
export const INITIAL_MASTER_NODE: MasterNodeEntity = {
  id: 'node-master-01',
  name: 'kubevision-master-01',
  ip: '10.0.3.10',
  role: 'control-plane',
  status: 'Ready',
  kubernetesVersion: 'v1.30.4',
  region: 'ap-east-1',
  zone: 'ap-east-1a',
  apiServerEndpoint: 'https://10.0.3.10:6443',
  etcdClusterSize: 3,
  cpuCapacity: 8,
  memCapacity: 16384,
  notes:
    'Single control-plane node running kube-apiserver, kube-scheduler, kube-controller-manager and etcd (3 members, quorum 2). Workers join through https://10.0.3.10:6443. kubelet rotating certificates enabled; node-monitor-grace-period 40s, pod-eviction-timeout 300s. This node does not schedule application pods (taint node-role.kubernetes.io/control-plane:NoSchedule).',
};

const ALPHA_POD_IDS: readonly string[] = [
  'payment-gateway-7f8b9-x2k',
  'checkout-service-6c4d8-m9p',
  'order-api-5b7f9-k3d',
  'redis-shard-0',
  'auth-service-8d2c4-p7q',
  'nginx-ingress-4f6a2-r8t',
  'metrics-agent-9e1b5-w2j',
  'cart-service-3a9d7-c5v',
  'catalog-sync-2b8e4-n6f',
];

const BETA_POD_IDS: readonly string[] = [
  'inventory-service-7c3f9-v4h',
  'payment-gateway-7f8b9-j8n',
  'redis-shard-1',
  'kafka-broker-0',
  'kafka-broker-1',
  'search-indexer-5d8a2-q7m',
  'notification-worker-4e7c1-t9b',
  'log-shipper-6f2b8-h3r',
];

const GAMMA_POD_IDS: readonly string[] = [
  'user-profile-9a4d2-s5w',
  'promo-engine-8b5c3-y7e',
  'grafana-3c8f6-k2u',
  'prometheus-server-0',
  'coredns-7d9b4-z8x',
  'vault-agent-2a7e5-p4n',
  'worker-queue-5f1d8-m6s',
];

const INITIAL_WORKER_NODES: WorkerNodeEntity[] = [
  {
    id: 'node-alpha',
    name: 'worker-alpha',
    ip: '10.0.3.11',
    status: 'Ready',
    cpuCapacity: 16,
    memCapacity: 65536,
    networkMbps: 10000,
    rackIndex: 0,
    podIds: [...ALPHA_POD_IDS],
  },
  {
    id: 'node-beta',
    name: 'worker-beta',
    ip: '10.0.3.12',
    status: 'HighLoad',
    cpuCapacity: 16,
    memCapacity: 65536,
    networkMbps: 10000,
    rackIndex: 1,
    podIds: [...BETA_POD_IDS],
  },
  {
    id: 'node-gamma',
    name: 'worker-gamma',
    ip: '10.0.3.13',
    status: 'Ready',
    cpuCapacity: 32,
    memCapacity: 131072,
    networkMbps: 25000,
    rackIndex: 2,
    podIds: [...GAMMA_POD_IDS],
  },
];

const INITIAL_PODS: PodEntity[] = [
  /* ---------------------------------------------------------------- rack 0 */
  {
    id: 'payment-gateway-7f8b9-x2k',
    name: 'payment-gateway-7f8b9-x2k',
    namespace: 'payments',
    nodeId: 'node-alpha',
    status: 'Running',
    cpuUsage: 46.2,
    memoryUsage: 58.4,
    restarts: 0,
    ip: '10.244.0.11',
    createdAt: '2026-11-03T02:14:08.000Z',
    cpuHistory: [38.4, 41.2, 39.8, 43.6, 44.9, 46.2],
    memHistory: [52.1, 54.6, 55.9, 57.2, 57.8, 58.4],
  },
  {
    id: 'checkout-service-6c4d8-m9p',
    name: 'checkout-service-6c4d8-m9p',
    namespace: 'production',
    nodeId: 'node-alpha',
    status: 'Running',
    cpuUsage: 52.7,
    memoryUsage: 61.3,
    restarts: 0,
    ip: '10.244.0.12',
    createdAt: '2026-11-03T02:14:09.000Z',
    cpuHistory: [44.8, 47.3, 49.1, 50.6, 51.8, 52.7],
    memHistory: [55.4, 57.1, 58.6, 59.8, 60.5, 61.3],
  },
  {
    id: 'order-api-5b7f9-k3d',
    name: 'order-api-5b7f9-k3d',
    namespace: 'production',
    nodeId: 'node-alpha',
    status: 'Running',
    cpuUsage: 38.9,
    memoryUsage: 47.2,
    restarts: 1,
    ip: '10.244.0.13',
    createdAt: '2026-11-03T02:14:11.000Z',
    cpuHistory: [31.2, 33.8, 35.1, 36.4, 37.8, 38.9],
    memHistory: [41.6, 43.2, 44.5, 45.7, 46.4, 47.2],
  },
  {
    id: 'redis-shard-0',
    name: 'redis-shard-0',
    namespace: 'cache',
    nodeId: 'node-alpha',
    status: 'Running',
    cpuUsage: 71.4,
    memoryUsage: 68.2,
    restarts: 0,
    ip: '10.244.0.14',
    createdAt: '2026-11-01T09:30:00.000Z',
    cpuHistory: [62.1, 65.4, 67.8, 69.2, 70.3, 71.4],
    memHistory: [61.8, 63.9, 65.4, 66.6, 67.5, 68.2],
  },
  {
    id: 'auth-service-8d2c4-p7q',
    name: 'auth-service-8d2c4-p7q',
    namespace: 'production',
    nodeId: 'node-alpha',
    status: 'Running',
    cpuUsage: 33.5,
    memoryUsage: 39.1,
    restarts: 0,
    ip: '10.244.0.15',
    createdAt: '2026-11-03T02:14:16.000Z',
    cpuHistory: [27.4, 29.1, 30.6, 31.7, 32.6, 33.5],
    memHistory: [34.2, 35.8, 36.9, 37.8, 38.5, 39.1],
  },
  {
    id: 'nginx-ingress-4f6a2-r8t',
    name: 'nginx-ingress-4f6a2-r8t',
    namespace: 'ingress',
    nodeId: 'node-alpha',
    status: 'Running',
    cpuUsage: 22.8,
    memoryUsage: 26.4,
    restarts: 0,
    ip: '10.244.0.16',
    createdAt: '2026-11-01T09:28:41.000Z',
    cpuHistory: [18.1, 19.4, 20.6, 21.4, 22.1, 22.8],
    memHistory: [23.1, 24.0, 24.8, 25.5, 26.0, 26.4],
  },
  {
    id: 'metrics-agent-9e1b5-w2j',
    name: 'metrics-agent-9e1b5-w2j',
    namespace: 'observability',
    nodeId: 'node-alpha',
    status: 'Running',
    cpuUsage: 18.6,
    memoryUsage: 31.7,
    restarts: 0,
    ip: '10.244.0.17',
    createdAt: '2026-11-01T09:29:02.000Z',
    cpuHistory: [14.8, 15.9, 16.8, 17.5, 18.1, 18.6],
    memHistory: [28.4, 29.3, 30.1, 30.8, 31.3, 31.7],
  },
  {
    id: 'cart-service-3a9d7-c5v',
    name: 'cart-service-3a9d7-c5v',
    namespace: 'production',
    nodeId: 'node-alpha',
    status: 'CrashLoopBackOff',
    cpuUsage: 88.4,
    memoryUsage: 96.8,
    restarts: 12,
    ip: '10.244.0.18',
    createdAt: '2026-11-04T13:48:22.000Z',
    cpuHistory: [61.2, 70.4, 78.9, 84.3, 86.8, 88.4],
    memHistory: [72.4, 81.6, 87.9, 92.4, 95.1, 96.8],
  },
  {
    id: 'catalog-sync-2b8e4-n6f',
    name: 'catalog-sync-2b8e4-n6f',
    namespace: 'production',
    nodeId: 'node-alpha',
    status: 'Pending',
    cpuUsage: 0,
    memoryUsage: 0,
    restarts: 0,
    ip: '10.244.0.19',
    createdAt: '2026-11-04T14:52:37.000Z',
    cpuHistory: [0, 0, 0, 0, 0, 0],
    memHistory: [0, 0, 0, 0, 0, 0],
  },

  /* ---------------------------------------------------------------- rack 1 */
  {
    id: 'inventory-service-7c3f9-v4h',
    name: 'inventory-service-7c3f9-v4h',
    namespace: 'production',
    nodeId: 'node-beta',
    status: 'Running',
    cpuUsage: 61.2,
    memoryUsage: 72.4,
    restarts: 2,
    ip: '10.244.1.11',
    createdAt: '2026-11-03T02:15:01.000Z',
    cpuHistory: [52.4, 55.1, 57.3, 58.9, 60.1, 61.2],
    memHistory: [64.8, 67.2, 69.1, 70.5, 71.6, 72.4],
  },
  {
    id: 'payment-gateway-7f8b9-j8n',
    name: 'payment-gateway-7f8b9-j8n',
    namespace: 'payments',
    nodeId: 'node-beta',
    status: 'Running',
    cpuUsage: 44.1,
    memoryUsage: 55.9,
    restarts: 0,
    ip: '10.244.1.12',
    createdAt: '2026-11-03T02:15:03.000Z',
    cpuHistory: [36.8, 38.9, 40.7, 42.1, 43.2, 44.1],
    memHistory: [49.6, 51.4, 52.9, 54.1, 55.1, 55.9],
  },
  {
    id: 'redis-shard-1',
    name: 'redis-shard-1',
    namespace: 'cache',
    nodeId: 'node-beta',
    status: 'Running',
    cpuUsage: 74.3,
    memoryUsage: 70.1,
    restarts: 0,
    ip: '10.244.1.13',
    createdAt: '2026-11-01T09:30:02.000Z',
    cpuHistory: [64.8, 67.9, 70.1, 71.8, 73.2, 74.3],
    memHistory: [62.4, 64.9, 66.8, 68.1, 69.2, 70.1],
  },
  {
    id: 'kafka-broker-0',
    name: 'kafka-broker-0',
    namespace: 'streaming',
    nodeId: 'node-beta',
    status: 'Running',
    cpuUsage: 66.8,
    memoryUsage: 78.5,
    restarts: 0,
    ip: '10.244.1.14',
    createdAt: '2026-11-01T09:31:12.000Z',
    cpuHistory: [58.1, 60.7, 62.6, 64.2, 65.6, 66.8],
    memHistory: [70.2, 72.6, 74.4, 76.1, 77.4, 78.5],
  },
  {
    id: 'kafka-broker-1',
    name: 'kafka-broker-1',
    namespace: 'streaming',
    nodeId: 'node-beta',
    status: 'Running',
    cpuUsage: 63.9,
    memoryUsage: 75.2,
    restarts: 1,
    ip: '10.244.1.15',
    createdAt: '2026-11-01T09:31:14.000Z',
    cpuHistory: [54.6, 57.2, 59.4, 61.1, 62.6, 63.9],
    memHistory: [67.4, 69.8, 71.6, 73.1, 74.2, 75.2],
  },
  {
    id: 'search-indexer-5d8a2-q7m',
    name: 'search-indexer-5d8a2-q7m',
    namespace: 'search',
    nodeId: 'node-beta',
    status: 'Running',
    cpuUsage: 79.4,
    memoryUsage: 71.6,
    restarts: 0,
    ip: '10.244.1.16',
    createdAt: '2026-11-02T18:07:55.000Z',
    cpuHistory: [68.2, 71.6, 74.3, 76.4, 78.1, 79.4],
    memHistory: [63.9, 66.4, 68.2, 69.6, 70.7, 71.6],
  },
  {
    id: 'notification-worker-4e7c1-t9b',
    name: 'notification-worker-4e7c1-t9b',
    namespace: 'production',
    nodeId: 'node-beta',
    status: 'Running',
    cpuUsage: 29.7,
    memoryUsage: 34.8,
    restarts: 3,
    ip: '10.244.1.17',
    createdAt: '2026-11-03T02:16:40.000Z',
    cpuHistory: [23.8, 25.6, 27.1, 28.2, 29.1, 29.7],
    memHistory: [29.6, 31.2, 32.4, 33.4, 34.2, 34.8],
  },
  {
    id: 'log-shipper-6f2b8-h3r',
    name: 'log-shipper-6f2b8-h3r',
    namespace: 'observability',
    nodeId: 'node-beta',
    status: 'OOMKilled',
    cpuUsage: 92.7,
    memoryUsage: 99.1,
    restarts: 7,
    ip: '10.244.1.18',
    createdAt: '2026-11-04T09:12:31.000Z',
    cpuHistory: [58.4, 68.9, 77.6, 84.2, 89.1, 92.7],
    memHistory: [76.2, 84.1, 89.8, 94.2, 97.1, 99.1],
  },

  /* ---------------------------------------------------------------- rack 2 */
  {
    id: 'user-profile-9a4d2-s5w',
    name: 'user-profile-9a4d2-s5w',
    namespace: 'production',
    nodeId: 'node-gamma',
    status: 'Running',
    cpuUsage: 36.4,
    memoryUsage: 42.9,
    restarts: 0,
    ip: '10.244.2.11',
    createdAt: '2026-11-03T02:17:22.000Z',
    cpuHistory: [30.1, 31.9, 33.4, 34.6, 35.6, 36.4],
    memHistory: [37.4, 38.9, 40.1, 41.2, 42.1, 42.9],
  },
  {
    id: 'promo-engine-8b5c3-y7e',
    name: 'promo-engine-8b5c3-y7e',
    namespace: 'production',
    nodeId: 'node-gamma',
    status: 'Terminating',
    cpuUsage: 15.2,
    memoryUsage: 21.6,
    restarts: 0,
    ip: '10.244.2.12',
    createdAt: '2026-11-04T11:40:05.000Z',
    cpuHistory: [42.6, 38.9, 33.4, 26.1, 19.8, 15.2],
    memHistory: [48.2, 43.1, 37.4, 30.8, 25.4, 21.6],
  },
  {
    id: 'grafana-3c8f6-k2u',
    name: 'grafana-3c8f6-k2u',
    namespace: 'observability',
    nodeId: 'node-gamma',
    status: 'Running',
    cpuUsage: 27.9,
    memoryUsage: 44.3,
    restarts: 0,
    ip: '10.244.2.13',
    createdAt: '2026-11-01T09:33:48.000Z',
    cpuHistory: [22.4, 24.1, 25.6, 26.6, 27.4, 27.9],
    memHistory: [38.9, 40.4, 41.6, 42.7, 43.6, 44.3],
  },
  {
    id: 'prometheus-server-0',
    name: 'prometheus-server-0',
    namespace: 'observability',
    nodeId: 'node-gamma',
    status: 'Running',
    cpuUsage: 58.6,
    memoryUsage: 81.2,
    restarts: 0,
    ip: '10.244.2.14',
    createdAt: '2026-11-01T09:34:10.000Z',
    cpuHistory: [49.8, 52.6, 54.8, 56.4, 57.6, 58.6],
    memHistory: [72.6, 75.1, 77.4, 79.1, 80.3, 81.2],
  },
  {
    id: 'coredns-7d9b4-z8x',
    name: 'coredns-7d9b4-z8x',
    namespace: 'kube-system',
    nodeId: 'node-gamma',
    status: 'Running',
    cpuUsage: 11.3,
    memoryUsage: 14.8,
    restarts: 0,
    ip: '10.244.2.15',
    createdAt: '2026-11-01T09:20:00.000Z',
    cpuHistory: [8.4, 9.1, 9.8, 10.4, 10.9, 11.3],
    memHistory: [12.4, 13.0, 13.6, 14.1, 14.5, 14.8],
  },
  {
    id: 'vault-agent-2a7e5-p4n',
    name: 'vault-agent-2a7e5-p4n',
    namespace: 'security',
    nodeId: 'node-gamma',
    status: 'Running',
    cpuUsage: 9.8,
    memoryUsage: 18.2,
    restarts: 1,
    ip: '10.244.2.16',
    createdAt: '2026-11-02T06:22:19.000Z',
    cpuHistory: [7.2, 7.9, 8.5, 9.0, 9.5, 9.8],
    memHistory: [15.4, 16.1, 16.8, 17.4, 17.9, 18.2],
  },
  {
    id: 'worker-queue-5f1d8-m6s',
    name: 'worker-queue-5f1d8-m6s',
    namespace: 'background',
    nodeId: 'node-gamma',
    status: 'Running',
    cpuUsage: 41.7,
    memoryUsage: 52.3,
    restarts: 0,
    ip: '10.244.2.17',
    createdAt: '2026-11-03T02:18:55.000Z',
    cpuHistory: [34.2, 36.4, 38.1, 39.6, 40.8, 41.7],
    memHistory: [46.1, 47.8, 49.2, 50.4, 51.5, 52.3],
  },
];

const INITIAL_ACTIVE_ALERTS: AlertEvent[] = [
  {
    id: 'alert-cart-crashloop-20261104',
    severity: 'P0',
    sourceType: 'pod',
    sourceId: 'cart-service-3a9d7-c5v',
    title: 'cart-service in CrashLoopBackOff',
    message:
      'Container restarted 12 times in 10 minutes after exceeding its 512Mi memory limit.',
    timestamp: '2026-11-04T14:56:41.000Z',
    acknowledged: false,
    resolved: false,
  },
  {
    id: 'alert-logshipper-oom-20261104',
    severity: 'P1',
    sourceType: 'pod',
    sourceId: 'log-shipper-6f2b8-h3r',
    title: 'log-shipper OOMKilled',
    message:
      'Memory reached 99.1% of the container limit before the kernel OOM killer terminated it.',
    timestamp: '2026-11-04T14:57:18.000Z',
    acknowledged: false,
    resolved: false,
  },
  {
    id: 'alert-beta-highload-20261104',
    severity: 'P1',
    sourceType: 'node',
    sourceId: 'node-beta',
    title: 'worker-beta under sustained high load',
    message:
      'Node CPU pressure above 80% for 12 consecutive minutes while hosting 8 pods.',
    timestamp: '2026-11-04T14:45:02.000Z',
    acknowledged: true,
    resolved: false,
  },
  {
    id: 'alert-catalog-pending-20261104',
    severity: 'P2',
    sourceType: 'pod',
    sourceId: 'catalog-sync-2b8e4-n6f',
    title: 'catalog-sync stuck in Pending',
    message:
      'Pod unschedulable for 7 minutes: no node has 2 allocatable CPU cores left.',
    timestamp: '2026-11-04T14:53:10.000Z',
    acknowledged: false,
    resolved: false,
  },
];

/**
 * The bootstrap cluster state.
 *
 * Frozen at module scope so a client component cannot accidentally mutate the
 * SSR seed before the first live tick arrives. `Object.freeze` is shallow, but
 * every nested object here is only ever read; live mutations replace whole
 * entries instead of editing them in place, which is also what the transient-ref
 * rule requires.
 */
export const INITIAL_CLUSTER_SNAPSHOT: TelemetrySnapshot = Object.freeze({
  timestamp: '2026-11-04T15:00:00.000Z',
  clusterHealthScore: 74,
  totalQps: 24180,
  master: INITIAL_MASTER_NODE,
  nodes: INITIAL_WORKER_NODES,
  pods: INITIAL_PODS,
  activeAlerts: INITIAL_ACTIVE_ALERTS,
});

/** Worker node count in the seed (3). Handy for `InstancedMesh` sizing. */
export const INITIAL_NODE_COUNT = INITIAL_WORKER_NODES.length;

/** Pod count in the seed (24). Handy for `InstancedMesh` sizing and HUD totals. */
export const INITIAL_POD_COUNT = INITIAL_PODS.length;

/** Rack slot count derived from the seed (3: alpha, beta, gamma). */
export const INITIAL_RACK_COUNT = RACK_INDICES.length;