'use client';

/**
 * Reads the live 3D scene once, at the moment a chat request is sent.
 *
 * The telemetry pool is mutated every tick. This copies the fields the route
 * needs so the body stays a detached snapshot of that instant: the selected
 * entity, the active chaos scenario, the abnormal pods, and the full cluster.
 */

import { getSnapshot } from '@/store/useTelemetryRef';
import { useClusterStore } from '@/store/useClusterStore';
import type { ChatClusterContext } from '@/types/ai';
import type {
  AlertEvent,
  MasterNodeEntity,
  PodEntity,
  TelemetrySnapshot,
  WorkerNodeEntity,
} from '@/types/cluster';

const LOAD_ALARM = 80;

function copyPod(pod: PodEntity): PodEntity {
  return {
    id: pod.id,
    name: pod.name,
    namespace: pod.namespace,
    nodeId: pod.nodeId,
    status: pod.status,
    cpuUsage: pod.cpuUsage,
    memoryUsage: pod.memoryUsage,
    restarts: pod.restarts,
    ip: pod.ip,
    createdAt: pod.createdAt,
    cpuHistory: pod.cpuHistory.slice(),
    memHistory: pod.memHistory.slice(),
  };
}

function copyNode(node: WorkerNodeEntity): WorkerNodeEntity {
  return {
    id: node.id,
    name: node.name,
    ip: node.ip,
    status: node.status,
    cpuCapacity: node.cpuCapacity,
    memCapacity: node.memCapacity,
    networkMbps: node.networkMbps,
    rackIndex: node.rackIndex,
    podIds: node.podIds.slice(),
  };
}

function copyMaster(master: MasterNodeEntity): MasterNodeEntity {
  return {
    id: master.id,
    name: master.name,
    ip: master.ip,
    role: master.role,
    status: master.status,
    kubernetesVersion: master.kubernetesVersion,
    region: master.region,
    zone: master.zone,
    apiServerEndpoint: master.apiServerEndpoint,
    etcdClusterSize: master.etcdClusterSize,
    cpuCapacity: master.cpuCapacity,
    memCapacity: master.memCapacity,
    notes: master.notes,
  };
}

function copyAlert(alert: AlertEvent): AlertEvent {
  return {
    id: alert.id,
    severity: alert.severity,
    sourceType: alert.sourceType,
    sourceId: alert.sourceId,
    title: alert.title,
    message: alert.message,
    timestamp: alert.timestamp,
    acknowledged: alert.acknowledged,
    resolved: alert.resolved,
  };
}

function copySnapshot(snapshot: TelemetrySnapshot): TelemetrySnapshot {
  return {
    timestamp: snapshot.timestamp,
    clusterHealthScore: snapshot.clusterHealthScore,
    totalQps: snapshot.totalQps,
    master: copyMaster(snapshot.master),
    nodes: snapshot.nodes.map(copyNode),
    pods: snapshot.pods.map(copyPod),
    activeAlerts: snapshot.activeAlerts.map(copyAlert),
  };
}

function isAbnormal(pod: PodEntity): boolean {
  return pod.status !== 'Running' || pod.cpuUsage > LOAD_ALARM || pod.memoryUsage > LOAD_ALARM;
}

/** Scene payload for `POST /api/chat`. Call it inside the request, not during render. */
export function readChatClusterContext(): ChatClusterContext {
  const { selectedEntityId, selectedEntityType, activeChaos } = useClusterStore.getState();
  const snapshot = copySnapshot(getSnapshot());
  const abnormalPods = snapshot.pods.filter(isAbnormal);
  return {
    selectedEntityId,
    selectedEntityType,
    activeChaos,
    abnormalPods,
    snapshot,
  };
}
