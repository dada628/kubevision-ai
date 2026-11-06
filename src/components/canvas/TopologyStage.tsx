'use client';

/**
 * KubeVision AI - topology stage.
 *
 * SCOPE
 * This milestone ships the *engine base*: the camera, the atmosphere and the
 * structural anchors the operator can already navigate to and select - the three
 * worker rack chassis and the detached control-plane beacon. The instanced pod
 * field and the link beams mount into the slot marked `POD FIELD SLOT` below in
 * the next milestone; they inherit every coordinate from `topologyLayout.ts`.
 *
 * COLOUR DISCIPLINE (`.cursorrules` rule 3)
 * Status colour is read from the transient pool inside `useFrame` and written
 * straight into the material objects. There is no `useState`, no store
 * subscription, and no allocation on the frame path: every `THREE.Color` used
 * here is a module-level singleton, and every scratch object is memoized.
 */

import {
  useCallback,
  useRef,
  type ReactElement,
} from 'react';
import type { ComponentRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Edges } from '@react-three/drei';
import { Color } from 'three';
import type { Mesh } from 'three';
import type { NodeStatus, RackIndex, WorkerNodeEntity } from '@/types/cluster';
import { useClusterStore } from '@/store/useClusterStore';
import { getSnapshot } from '@/store/useTelemetryRef';
import {
  MASTER_HEIGHT,
  RACK_DEPTH,
  RACK_HEIGHT,
  RACK_WIDTH,
  rackCenterX,
} from './topologyLayout';

/* ==========================================================================
   Palette singletons
   ========================================================================== */

/** Node status -> chassis rim colour. Mirrors the HUD tone contract. */
const STATUS_EDGE_COLOR: Readonly<Record<NodeStatus, Color>> = {
  Ready: new Color('#22d3ee'),
  HighLoad: new Color('#fbbf24'),
  NetworkPartition: new Color('#f43f5e'),
};

/** Rim colour for the currently selected rack / beacon. */
const SELECTED_EDGE_COLOR = new Color('#67e8f9');

/** Chassis body fill - a lifted `void` tone so the body reads above the fog. */
const CHASSIS_BODY_COLOR = '#1d4a68';

/** Control-plane beacon body. */
const BEACON_BODY_COLOR = '#0e7490';

/** Self-illumination applied to the chassis so it survives the fog blend. */
const CHASSIS_EMISSIVE = '#1f6f8b';

/** Rim colour for the control-plane beacon. */
const BEACON_EDGE_COLOR = '#34d399';

/** Fixed rack slots, in render order. */
const RACK_SLOTS: readonly RackIndex[] = [0, 1, 2];

/** Stable array identity for the `map` below: rebuilt only if this changes. */
const RACK_KEYS: readonly string[] = ['rack-0', 'rack-1', 'rack-2'];

/* ==========================================================================
   Pointer helpers
   ========================================================================== */

const POINTER_CURSOR = 'pointer';
const DEFAULT_CURSOR = 'auto';

function setCursor(cursor: string): void {
  if (typeof document === 'undefined') {
    return;
  }
  document.body.style.cursor = cursor;
}

/* ==========================================================================
   Rack chassis
   ========================================================================== */

interface RackChassisProps {
  readonly rackIndex: RackIndex;
  /** Registers the `Edges` material so the frame loop can recolour the rim. */
  readonly registerEdgeMaterial: (
    rackIndex: RackIndex,
    material: EdgeMaterial | null,
  ) => void;
}

/** The material handed back by `<Edges>`; only `color` is touched per frame. */
type EdgeMaterial = ComponentRef<typeof Edges>['material'];

function RackChassis({
  rackIndex,
  registerEdgeMaterial,
}: RackChassisProps): ReactElement {
  const handleEdgeRef = useCallback(
    (instance: ComponentRef<typeof Edges> | null) => {
      registerEdgeMaterial(rackIndex, instance === null ? null : instance.material);
    },
    [rackIndex, registerEdgeMaterial],
  );

  const handleSelect = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation();
      const node = getSnapshot().nodes.find(
        (candidate) => candidate.rackIndex === rackIndex,
      );
      if (node === undefined) {
        return;
      }
      const store = useClusterStore.getState();
      /* Re-clicking the focused rack clears the focus: the rig then flies back
         to the overview, which is the same gesture as clicking empty space. */
      if (store.selectedEntityId === node.id) {
        store.clearSelection();
        return;
      }
      store.selectEntity(node.id, 'node');
    },
    [rackIndex],
  );

  const handleOver = useCallback(() => setCursor(POINTER_CURSOR), []);
  const handleOut = useCallback(() => setCursor(DEFAULT_CURSOR), []);

  return (
    <mesh
      position={[rackCenterX(rackIndex), RACK_HEIGHT / 2, 0]}
      /* `onClick`, not `onPointerDown`: R3F only emits a click when the pointer
         travelled <= 2px, so starting an orbit drag on a rack never selects it. */
      onClick={handleSelect}
      onPointerOver={handleOver}
      onPointerOut={handleOut}
    >
      <boxGeometry args={[RACK_WIDTH, RACK_HEIGHT, RACK_DEPTH]} />
      {/*
        Lighting contract for the chassis body:
        - `metalness` ~0.1, not 0.4: there is no environment map in the scene,
          and a metallic PBR surface without one receives almost no diffuse
          light, which renders the racks as black slabs.
        - `emissiveIntensity` carries a small self-illumination so the body still
          reads at the overview distance, where the fog (near = 18) blends ~30%
          of the scene colour into every surface.
        - `emissive` is a dim cyan rather than the status colour: the STATUS is
          communicated by the rim (`Edges`) so the body never competes with it.
      */}
      <meshStandardMaterial
        color={CHASSIS_BODY_COLOR}
        emissive={CHASSIS_EMISSIVE}
        emissiveIntensity={0.6}
        roughness={0.7}
        metalness={0.12}
      />
      <Edges ref={handleEdgeRef} threshold={15} color={STATUS_EDGE_COLOR.Ready} />
    </mesh>
  );
}

/* ==========================================================================
   Control-plane beacon
   ========================================================================== */

interface BeaconProps {
  readonly registerMaterial: (material: EdgeMaterial | null) => void;
}

function ControlPlaneBeacon({ registerMaterial }: BeaconProps): ReactElement {
  const coreRef = useRef<Mesh | null>(null);
  const haloRef = useRef<Mesh | null>(null);

  const handleRef = useCallback(
    (instance: ComponentRef<typeof Edges> | null) => {
      registerMaterial(instance === null ? null : instance.material);
    },
    [registerMaterial],
  );

  const handleSelect = useCallback((event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    const store = useClusterStore.getState();
    const master = getSnapshot().master;
    if (store.selectedEntityId === master.id) {
      store.clearSelection();
      return;
    }
    store.selectEntity(master.id, 'master');
  }, []);

  const handleOver = useCallback(() => setCursor(POINTER_CURSOR), []);
  const handleOut = useCallback(() => setCursor(DEFAULT_CURSOR), []);

  useFrame((state, delta) => {
    const core = coreRef.current;
    if (core !== null) {
      core.rotation.y += delta * 0.35;
    }
    const halo = haloRef.current;
    if (halo !== null) {
      halo.rotation.z -= delta * 0.22;
      /* Slow breathing so the beacon reads as "control plane alive" without a
         React render. Range is deliberately subtle: [0.92, 1.08]. */
      const pulse = 1 + Math.sin(state.clock.elapsedTime * 1.1) * 0.08;
      halo.scale.setScalar(pulse);
    }
  });

  return (
    <group position={[0, MASTER_HEIGHT, 0]}>
      <mesh
        ref={coreRef}
        onClick={handleSelect}
        onPointerOver={handleOver}
        onPointerOut={handleOut}
      >
        <octahedronGeometry args={[0.62, 0]} />
        <meshStandardMaterial
          color={BEACON_BODY_COLOR}
          emissive={BEACON_EDGE_COLOR}
          emissiveIntensity={1.5}
          roughness={0.2}
          metalness={0.7}
        />
        <Edges ref={handleRef} threshold={15} color={BEACON_EDGE_COLOR} />
      </mesh>

      <mesh ref={haloRef} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.15, 0.016, 8, 96]} />
        <meshBasicMaterial
          color={BEACON_EDGE_COLOR}
          transparent
          opacity={0.7}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/* ==========================================================================
   Stage
   ========================================================================== */

/** Snapshot of the per-rack scheduling facts the frame loop needs. */
interface RackNodeFacts {
  readonly id: string;
  readonly status: NodeStatus;
}

/**
 * Scene anchor. Rendered by `ClusterCanvas` inside the fog volume.
 *
 * `rackEdgeMaterials` is a plain array held in a ref (not state): the frame loop
 * mutates it in place, and writing a ref never schedules a React render.
 *
 * WHY THE RACK CACHE IS REFRESHED EVERY FRAME
 * An earlier revision invalidated the cache only when `snapshot.nodes` changed
 * identity, on the assumption that every tick replaces the array. That holds for
 * `writeSnapshot` but NOT for `applyChaos`, which mutates node status in place
 * (`node.status = 'HighLoad'`) and keeps the same array. The rim colour then
 * froze on the pre-chaos state. Rescanning three nodes per frame costs a handful
 * of comparisons and is allocation-free, so correctness wins over the micro
 * optimisation.
 */
export function TopologyStage(): ReactElement {
  const rackEdgeMaterials = useRef<Array<EdgeMaterial | null>>([null, null, null]);
  const beaconEdgeMaterial = useRef<EdgeMaterial | null>(null);

  /*
   * Per-rack node reference cache. Holds the LIVE entity (stable object identity
   * across ticks), never a copy, so `status` is always the current value and no
   * object is allocated on the frame path.
   */
  const rackNodes = useRef<Array<WorkerNodeEntity | null>>([null, null, null]);

  const registerRackMaterial = useCallback(
    (rackIndex: RackIndex, material: EdgeMaterial | null) => {
      rackEdgeMaterials.current[rackIndex] = material;
    },
    [],
  );

  const registerBeaconMaterial = useCallback((material: EdgeMaterial | null) => {
    beaconEdgeMaterial.current = material;
  }, []);

  useFrame(() => {
    const snapshot = getSnapshot();
    const selectedId = useClusterStore.getState().selectedEntityId;

    const cache = rackNodes.current;
    cache[0] = null;
    cache[1] = null;
    cache[2] = null;
    for (let index = 0; index < snapshot.nodes.length; index += 1) {
      const node = snapshot.nodes[index];
      if (node === undefined) {
        continue;
      }
      cache[node.rackIndex] = node;
    }

    for (let rackIndex = 0; rackIndex < RACK_SLOTS.length; rackIndex += 1) {
      const material = rackEdgeMaterials.current[rackIndex];
      if (material === null || material === undefined) {
        continue;
      }
      const node = cache[rackIndex];
      if (node === null || node === undefined) {
        /* No node registered for this rack: fall back to the neutral rim. */
        material.color.set(STATUS_EDGE_COLOR.Ready);
        continue;
      }
      /* `Color.set(Color)` copies component-wise into the material's own Color,
         so the palette singletons are never adopted (and never mutated). */
      material.color.set(
        node.id === selectedId
          ? SELECTED_EDGE_COLOR
          : STATUS_EDGE_COLOR[node.status],
      );
    }

    const beaconMaterial = beaconEdgeMaterial.current;
    if (beaconMaterial !== null) {
      beaconMaterial.color.set(
        snapshot.master.id === selectedId
          ? SELECTED_EDGE_COLOR
          : BEACON_EDGE_COLOR,
      );
    }
  });

  return (
    <group>
      {/* Foundation plate: grounds the racks visually inside the fog. */}
      <mesh position={[0, -0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[RACK_WIDTH * 3 + 4.2, RACK_DEPTH + 3.2]} />
        <meshStandardMaterial
          color="#040a1a"
          roughness={0.9}
          metalness={0.1}
          transparent
          opacity={0.85}
        />
      </mesh>

      {RACK_SLOTS.map((rackIndex, slot) => (
        <RackChassis
          key={RACK_KEYS[slot] ?? rackIndex}
          rackIndex={rackIndex}
          registerEdgeMaterial={registerRackMaterial}
        />
      ))}

      <ControlPlaneBeacon registerMaterial={registerBeaconMaterial} />

      {/*
        POD FIELD SLOT - the instanced pod field (one InstancedMesh for all 24
        pods plus its additive aura shell) mounts here next, positioned through
        `writePodSlotPosition(rackIndex, slotIndex, out)`. The camera rig already
        focuses those exact coordinates, so the pods land in frame on arrival.
      */}
    </group>
  );
}

export default TopologyStage;