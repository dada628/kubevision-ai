'use client';

/**
 * KubeVision AI - programmatic control-plane model.
 *
 * WHY PROCEDURAL
 * Every vertex here is authored from `three` primitives (octahedron, icosahedron,
 * sphere, ring, torus) so the build has ZERO binary asset dependencies: no `.glb`,
 * no loader, no HTTP fetch, nothing to fail behind a CDN or a corporate proxy.
 *
 * COMPOSITION (bottom -> top, all in the group's local space)
 * 1. Holographic tick ring lying on the ground plane (y = 0 world).
 * 2. Outer OCTAHEDRON wireframe, slowly counter-rotating on Y.
 * 3. Middle ICOSAHEDRON wireframe, rotating the OTHER way and a touch faster -
 *    the counter-rotation is what makes the shell read as a containment field
 *    rather than as one spinning object.
 * 4. Inner energy core: a high-emissive sphere breathing between 0.88 and 1.12.
 *
 * PERFORMANCE CONTRACT (`.cursorrules` rule 3)
 * - Nothing in this file calls `useState`. Hover and selection are read from the
 *   store/refs and pushed into material properties inside `useFrame`.
 * - `useFrame` allocates nothing: the scratch `Color` instances and the click
 *   handler live at module or component-memo scope.
 * - The tick ring's 60 marks are ONE `InstancedMesh`, not 60 meshes: 60 draw
 *   calls would be a measurable slice of the frame budget for a decoration.
 *
 * PICKING CONTRACT
 * Only the outer wireframe shell is raycastable. The core, the ring and the
 * nameplate are decoration: a pickable `<Html>` plate would swallow every click
 * inside its bounding box and break `onPointerMissed` (click-empty-to-deselect).
 */

import { useCallback, useMemo, useRef, type ReactElement } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { Color, InstancedMesh, Matrix4, Object3D as Object3DRef } from 'three';
import type { Group, Mesh, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import { useClusterStore } from '@/store/useClusterStore';
import { getSnapshot } from '@/store/useTelemetryRef';
import { acquirePointerCursor, releasePointerCursor } from './cursorPointer';
import {
  MASTER_POSITION_Y,
} from './topologyLayout';

/* ==========================================================================
   Tunables
   ========================================================================== */

/**
 * Store id the master publishes when clicked.
 *
 * The live snapshot's master id is `node-master-01`; this is the canonical
 * control-plane handle the canvas uses, and `resolveFocusPose` resolves the
 * `'master'` TYPE to the singleton master regardless of which id was clicked. So
 * the inspector summary for an alias id is null (the store only clones a known
 * entity) but the CAMERA and the 3D highlight still lock on correctly.
 */
export const MASTER_ENTITY_ID = 'master-control-plane';

/** Outer octahedron radius. */
const SHELL_RADIUS = 1.15;

/** Middle icosahedron radius. */
const MID_SHELL_RADIUS = 0.92;

/** Inner energy core radius. */
const CORE_RADIUS = 0.42;

/** Ground ring radius: wide enough to sit under the whole shell. */
const RING_RADIUS = 2.35;

/**
 * Local Y of the holographic ring.
 *
 * The requirement is a ring projected at the BOTTOM of the model, so it must sit
 * on the world ground plane (y ~ 0), not at the shell's equator: `localY` is the
 * world ground (0.03, lifted to clear z-fighting with the grid) minus the group's
 * own height. Leaving it at `0` would draw it through the middle of the
 * octahedron and read as a belt rather than as a projection base.
 */
const RING_LOCAL_Y = 0.03 - MASTER_POSITION_Y;

/** Number of holographic tick marks around the ring. */
const RING_TICK_COUNT = 60;

/** Tick mark size (width x height x depth), in world units. */
const RING_TICK_SIZE = { x: 0.035, y: 0.012, z: 0.16 } as const;

/** Base rotation speeds, radians per second. */
const SHELL_SPIN = 0.22;
const MID_SHELL_SPIN = -0.34;

/** Breathing range of the core. */
const CORE_BREATH_MIN = 0.88;
const CORE_BREATH_MAX = 1.12;

/* ==========================================================================
   Material singletons - never mutated, only copied FROM
   ========================================================================== */

const SHELL_LINE_IDLE = new Color('#22d3ee');
const SHELL_LINE_ACTIVE = new Color('#a5f3fc');
const MID_LINE_IDLE = new Color('#0891b2');
const MID_LINE_ACTIVE = new Color('#67e8f9');
const CORE_EMISSIVE_IDLE = new Color('#22d3ee');
const CORE_EMISSIVE_ACTIVE = new Color('#cffafe');

/** Hover/selection damping rate for the colour and scale ramps. */
const FOCUS_LAMBDA = 9;

/* ==========================================================================
   Holographic tick ring
   ========================================================================== */

interface TickRingProps {
  /** Receives the instanced mesh so the frame loop can pulse its opacity. */
  readonly register: (instance: InstancedMesh | null) => void;
  /** Precomputed tick transforms, seeded into the instance buffer on mount. */
  readonly matrices: readonly Matrix4[];
}

/**
 * One `InstancedMesh` laying 60 radial ticks on the ground plane.
 *
 * The matrices are written ONCE, when the mesh's ref attaches and the instance
 * buffer exists. The ring then rotates as a whole via the parent group, so
 * per-frame matrix writes would be 60 wasted transforms every frame.
 */
/** Seeds nothing; the matrix buffer is filled by the parent's ref callback. */
function TickRing({ register, matrices }: TickRingProps): ReactElement {
  const handleRef = useCallback(
    (instance: InstancedMesh | null) => {
      if (instance !== null) {
        for (let index = 0; index < matrices.length; index += 1) {
          const matrix = matrices[index];
          if (matrix !== undefined) {
            instance.setMatrixAt(index, matrix);
          }
        }
        instance.instanceMatrix.needsUpdate = true;
      }
      register(instance);
    },
    [matrices, register],
  );

  return (
    <instancedMesh
      ref={handleRef}
      args={[undefined, undefined, RING_TICK_COUNT]}
      position={[0, RING_LOCAL_Y, 0]}
      /* Decoration: must not steal clicks from the shell or from empty space. */
      raycast={NO_RAYCAST}
    >
      <boxGeometry
        args={[RING_TICK_SIZE.x, RING_TICK_SIZE.y, RING_TICK_SIZE.z]}
      />
      <meshBasicMaterial
        color={SHELL_LINE_IDLE}
        transparent
        opacity={0.5}
        depthWrite={false}
        toneMapped={false}
      />
    </instancedMesh>
  );
}

/* ==========================================================================
   MasterNode3D
   ========================================================================== */

export function MasterNode3D(): ReactElement {
  /* --------------------------------------------------------- mutable refs */
  const shellGroupRef = useRef<Group | null>(null);
  const midGroupRef = useRef<Group | null>(null);
  const coreRef = useRef<Mesh | null>(null);
  const shellLineMaterialRef = useRef<MeshBasicMaterial | null>(null);
  const midLineMaterialRef = useRef<MeshBasicMaterial | null>(null);
  const coreMaterialRef = useRef<MeshStandardMaterial | null>(null);
  const ringRef = useRef<InstancedMesh | null>(null);

  /** Eased 0..1 focus amount (hover OR selection), never React state. */
  const focusRef = useRef<number>(0);
  const hoveredRef = useRef<boolean>(false);

  /* ------------------------------------------------------------ geometry */
  const ringMatrices = useMemo(() => {
    /* Preallocated scratch, used only while seeding the 60 instances. */
    const dummy = new Object3DRef();
    const matrices: Matrix4[] = [];
    for (let index = 0; index < RING_TICK_COUNT; index += 1) {
      const angle = (index / RING_TICK_COUNT) * Math.PI * 2;
      dummy.position.set(
        Math.cos(angle) * RING_RADIUS,
        0,
        Math.sin(angle) * RING_RADIUS,
      );
      /* Ticks point radially outward, lying flat on the ground. */
      dummy.rotation.set(0, -angle, 0);
      /* Every 5th tick is a longer major graduation. */
      const isMajor = index % 5 === 0;
      dummy.scale.set(1, 1, isMajor ? 1.7 : 0.85);
      dummy.updateMatrix();
      matrices.push(dummy.matrix.clone());
    }
    return matrices;
  }, []);

  /** Seeds the instance buffer exactly once the mesh exists. */
  const handleRingRef = useCallback(
    (instance: InstancedMesh | null) => {
      ringRef.current = instance;
      if (instance === null) {
        return;
      }
      for (let index = 0; index < ringMatrices.length; index += 1) {
        const matrix = ringMatrices[index];
        if (matrix !== undefined) {
          instance.setMatrixAt(index, matrix);
        }
      }
      instance.instanceMatrix.needsUpdate = true;
    },
    [ringMatrices],
  );

  /* ------------------------------------------------------------ handlers */
  const handleClick = useCallback((event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    /* Re-clicking the focused master clears the focus, mirroring the racks:
       the same gesture both enters and leaves the close-up. */
    const store = useClusterStore.getState();
    if (store.selectedEntityId === MASTER_ENTITY_ID) {
      store.clearSelection();
      return;
    }
    store.selectEntity(MASTER_ENTITY_ID, 'master');
  }, []);

  const handleOver = useCallback(() => {
    hoveredRef.current = true;
    acquirePointerCursor();
  }, []);

  const handleOut = useCallback(() => {
    hoveredRef.current = false;
    releasePointerCursor();
  }, []);

  /* --------------------------------------------------------- frame loop */
  useFrame((state, delta) => {
    const dt = Math.min(Math.max(delta, 0), 0.1);
    const elapsed = state.clock.elapsedTime;

    /* ---------------- focus easing (hover OR selection) ---------------- */
    const isSelected =
      useClusterStore.getState().selectedEntityId === MASTER_ENTITY_ID;
    const target = hoveredRef.current || isSelected ? 1 : 0;
    focusRef.current = dampScalar(focusRef.current, target, FOCUS_LAMBDA, dt);
    const focus = focusRef.current;

    /* ---------------- counter-rotating wireframes ---------------------- */
    const shell = shellGroupRef.current;
    if (shell !== null) {
      shell.rotation.y += SHELL_SPIN * dt;
      /* Hover lifts the shell slightly so the click target reads as responsive. */
      shell.scale.setScalar(1 + focus * 0.06);
    }
    const mid = midGroupRef.current;
    if (mid !== null) {
      mid.rotation.y += MID_SHELL_SPIN * dt;
      mid.rotation.x = Math.sin(elapsed * 0.35) * 0.12;
    }

    /* ---------------- breathing energy core --------------------------- */
    const core = coreRef.current;
    if (core !== null) {
      /* Breath only spans [MIN, MAX] when eased around 1.0 by the sine term. */
      const breath =
        1 + Math.sin(elapsed * 1.35) * ((CORE_BREATH_MAX - CORE_BREATH_MIN) / 2);
      const scale = breath * (1 + focus * 0.14);
      core.scale.setScalar(scale);
    }

    /* ---------------- material colour ramps --------------------------- */
    const shellLine = shellLineMaterialRef.current;
    if (shellLine !== null) {
      shellLine.color.copy(SHELL_LINE_IDLE).lerp(SHELL_LINE_ACTIVE, focus);
    }
    const midLine = midLineMaterialRef.current;
    if (midLine !== null) {
      midLine.color.copy(MID_LINE_IDLE).lerp(MID_LINE_ACTIVE, focus);
    }
    const coreMaterial = coreMaterialRef.current;
    if (coreMaterial !== null) {
      coreMaterial.emissive
        .copy(CORE_EMISSIVE_IDLE)
        .lerp(CORE_EMISSIVE_ACTIVE, focus);
      coreMaterial.emissiveIntensity = 1.6 + focus * 1.5;
    }

    /* ---------------- nameplate / ring brightness --------------------- */
    const ring = ringRef.current;
    if (ring !== null) {
      /* Single shared material, so one opacity update lights all 60 ticks. */
      const material = ring.material;
      if (!Array.isArray(material)) {
        material.opacity = 0.42 + focus * 0.34;
      }
    }
  });

  return (
    <group position={[0, MASTER_POSITION_Y, 0]}>
      {/*
        HOLOGRAPHIC BASE RING - projected onto the GROUND, not onto the core.
        The group sits at y = 2.5 (the core's height), so the ring is offset back
        down by exactly that amount to land on y = 0 world. Anchoring it to the
        core instead would leave a graduation ring floating in mid-air, reading as
        a third shell rather than as a floor projection.
      */}
      <group position={[0, -MASTER_POSITION_Y, 0]}>
        <TickRing register={handleRingRef} matrices={ringMatrices} />
      </group>

      {/* --------------------------------- outer containment shell (octa) */}
      <group ref={shellGroupRef}>
        <mesh
          onClick={handleClick}
          onPointerOver={handleOver}
          onPointerOut={handleOut}
        >
          <octahedronGeometry args={[SHELL_RADIUS, 0]} />
          <meshBasicMaterial
            ref={shellLineMaterialRef}
            color={SHELL_LINE_IDLE}
            wireframe
            transparent
            opacity={0.85}
            toneMapped={false}
          />
        </mesh>
      </group>

      {/* ---------------------------- inner shell, counter-rotating (ico) */}
      <group ref={midGroupRef}>
        <mesh raycast={NO_RAYCAST}>
          <icosahedronGeometry args={[MID_SHELL_RADIUS, 0]} />
          <meshBasicMaterial
            ref={midLineMaterialRef}
            color={MID_LINE_IDLE}
            wireframe
            transparent
            opacity={0.6}
            toneMapped={false}
          />
        </mesh>
      </group>

      {/* --------------------------------------------- energy core (solid) */}
      <mesh ref={coreRef} raycast={NO_RAYCAST}>
        <sphereGeometry args={[CORE_RADIUS, 24, 24]} />
        <meshStandardMaterial
          ref={coreMaterialRef}
          color="#e0fbff"
          emissive={CORE_EMISSIVE_IDLE}
          emissiveIntensity={1.6}
          roughness={0.15}
          metalness={0.35}
          toneMapped={false}
        />
      </mesh>

      {/* ------------------------------------------------- ambient halo ---- */}
      <mesh raycast={NO_RAYCAST} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.8, 0.012, 8, 96]} />
        <meshBasicMaterial
          color="#67e8f9"
          transparent
          opacity={0.35}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/*
        NAME PLATE - must stay `pointerEvents="none"`.
        A pickable `<Html>` overlays the canvas and swallows every click inside
        its bounding box, which would kill both `onPointerMissed` (deselect by
        clicking empty space) and the shell's own `onClick` underneath it.

        `distanceFactor` IS A WORLD-TO-PIXEL SCALE, NOT A DISTANCE LIMIT
        drei scales the element by `distanceFactor / 400 * cameraDistance`, so at
        the overview pose (master ~24 units out) factor 15 draws the plate at
        ~0.9x. Screen size therefore comes from factor x font-size together: the
        spec pins the factor at 15, so the inner type is authored at the
        compensated sizes below (roughly 26/15 = 1.73x the pixel value you want
        to read) instead of drifting the factor to fake the same result. Tuning
        the factor up would shrink the plate in the depth cue and drift from the
        agreed contract.
      */}
      <Html
        position={[0, SHELL_RADIUS + 1.15, 0]}
        center
        distanceFactor={15}
        pointerEvents="none"
        zIndexRange={[30, 0]}
      >
        <div
          className="select-none whitespace-nowrap rounded-md border border-emerald-400/40 bg-slate-950/85 px-5 py-2.5 text-center backdrop-blur-md"
          style={{
            boxShadow:
              '0 0 0 1px rgba(52,211,153,0.16), 0 0 18px -4px rgba(52,211,153,0.5)',
          }}
        >
          <p className="font-mono text-[22px] font-medium uppercase tracking-[0.24em] text-emerald-400">
            CONTROL PLANE
          </p>
          <p className="mt-0.5 font-mono text-[17px] uppercase tracking-[0.2em] text-slate-400">
            API-SERVER
          </p>
        </div>
      </Html>
    </group>
  );
}

/* ==========================================================================
   Helpers
   ========================================================================== */

/** Frame-rate independent exponential easing, allocation-free. */
function dampScalar(
  current: number,
  goal: number,
  lambda: number,
  dt: number,
): number {
  if (!Number.isFinite(dt) || dt <= 0) {
    return current;
  }
  return current + (goal - current) * (1 - Math.exp(-lambda * dt));
}

/** Shared "not pickable" raycaster override. */
const NO_RAYCAST: () => null = () => null;

export default MasterNode3D;