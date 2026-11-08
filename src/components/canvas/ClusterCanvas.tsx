'use client';

/**
 * KubeVision AI - 3D cluster topology canvas.
 *
 * SCOPE OF THIS MILESTONE
 * This file owns the WebGL *stage*: renderer configuration, atmosphere (fog,
 * lights, twin grids, drifting sparkles), the camera rig, and the frame clock
 * that feeds `noteFrame`. The topology meshes mount through the procedural
 * model components: `MasterNode3D` for the control plane and `WorkerRackField`
 * (three `WorkerRack3D` instances on the polar orbit) for the compute racks.
 * Both inherit camera framing, fog and colour grading from here.
 *
 * WHY `frameloop="always"` IS THE FOREGROUND DEFAULT
 * The canvas renders continuously while the viewport is visible because the
 * atmosphere (sparkle drift, fog falloff, telemetry interpolation) is
 * time-based. `useInViewPause` switches the loop to `"never"` when the tab is
 * hidden or the cell leaves the viewport, which stops those high-frequency
 * updates. `.cursorrules` rule 3 still holds: nothing inside the R3F tree
 * touches `useState`, and no `useFrame` callback allocates. A sustained drop
 * under 40 FPS lowers `dpr` and the sparkle count from outside the frame.
 *
 * SSR BOUNDARY
 * `'use client'` plus a `next/dynamic({ ssr: false })` import at the mount site
 * (`app/page.tsx`) means `three` never enters the server module graph.
 */

import { useRef, type ReactElement } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Grid, PerformanceMonitor, Sparkles } from '@react-three/drei';
import { DoubleSide } from 'three';
import { useInViewPause, useRenderBudgetFlags } from '@/hooks/useInViewPause';
import { noteFrameBudget, requestRenderDegraded } from '@/store/renderBudget';
import { noteFrame, telemetryTransientRef } from '@/store/useTelemetryRef';
import { useClusterStore } from '@/store/useClusterStore';
import { PERF_FPS_LOWER, PERF_FPS_UPPER } from '@/types/perf';
import CameraRig, { OVERVIEW_CAMERA_POSITION } from './CameraRig';
import { ErrorRippleField } from './ErrorRippleRing';
import MasterNode3D from './MasterNode3D';
import { NetworkStream3D } from './NetworkStream3D';
import { PodInstancedField } from './PodInstancedMesh';
import { WorkerRackField } from './WorkerRack3D';

/* ==========================================================================
   Palette - mirrors tailwind's `telemetry.*` and `void.*` tokens
   ========================================================================== */

const VOID_950 = '#020617';
const CYBER_400 = '#22d3ee';
const CYBER_600 = '#0891b2';
const CYBER_300 = '#67e8f9';
const SLATE_400 = '#94a3b8';
const TELEMETRY_HEALTHY = '#34d399';

/** Fog band, in world units from the camera. */
const FOG_NEAR = 18;
const FOG_FAR = 45;

/** Base grid geometry: 1.3-unit cells, 5.2-unit section lines. */
const GRID_CELL_SIZE = 1.3;
const GRID_SECTION_SIZE = 5.2;

/**
 * Grid fade budget.
 *
 * `fadeDistance` must exceed the camera's furthest floor sample (~40 units at
 * the overview pose) or the grid is invisible before the fog even starts, and
 * `fadeStrength` must stay near 1: it is an EXPONENT, so 1.6 turns a 40% distance
 * ratio into 21% alpha and the whole floor disappears. The `GridMaterial` is a
 * raw `ShaderMaterial` with no fog chunks, so fog does NOT rescue it.
 */
const GRID_FADE_DISTANCE = 95;
const GRID_FADE_STRENGTH = 1;
const GRID_FADE_FROM = 0.9;
const GRID_PLANE_SIZE = 90;

/**
 * Shared "not pickable" override.
 *
 * Typed as the intersection R3F's `raycast` prop accepts, and declared once so
 * every decorative object (grids, sparkles) is guaranteed to be raycast-free -
 * a single pickable decoration would swallow `onPointerMissed` for the whole
 * canvas and break the click-empty-space-to-reset gesture.
 */
const NO_RAYCAST: () => null = () => null;

/* ==========================================================================
   Atmosphere
   ========================================================================== */

/**
 * Void haze + light rig.
 *
 * `attach="fog"` binds the fog to the scene, so it also dissolves the outer edge
 * of the grids into the page background instead of ending them on a hard line.
 *
 * LIGHTING BUDGET - why the intensities look high
 * three r155+ uses physically-based light units by default (`useLegacyLights`
 * is false), and R3F applies ACES filmic tone mapping (`flat={false}`), which
 * compresses midtones. A "normal looking" 0.5-intensity rig therefore renders
 * near-black once the fog (which blends toward `void.950`) takes its share at
 * the ~26-unit overview distance. The values below are tuned against headless
 * screenshots so the rack bodies land around L* 30-40, not L* 5.
 */
function Atmosphere(): ReactElement {
  return (
    <>
      <fog attach="fog" args={[VOID_950, FOG_NEAR, FOG_FAR]} />

      {/* Cool ambient fill: shadowed rack faces must never read as pure black. */}
      <ambientLight intensity={1.35} color={SLATE_400} />

      {/* Key light: high, front-left, cyan-tinted. The dominant shaping light. */}
      <directionalLight position={[10, 18, 12]} intensity={3.4} color="#a5f3fc" />

      {/* Rim light: low and behind, emerald, separates racks from the fog. */}
      <directionalLight
        position={[-12, 6, -14]}
        intensity={1.5}
        color={TELEMETRY_HEALTHY}
      />

      {/* Hemisphere wrap keeps the pseudo-glow instances from looking flat. */}
      <hemisphereLight args={[CYBER_400, '#0b1428', 1.1]} />
    </>
  );
}

/**
 * Twin ground grids.
 *
 * Layer 1 is the dense cyan cell mesh; layer 2 is a coarser, brighter section
 * grid lifted 0.012 units to avoid z-fighting.
 *
 * `raycast={() => null}` on BOTH: a raycastable floor would register as a hit on
 * every click, which suppresses R3F's `onPointerMissed` - and that handler is how
 * clicking "empty space" clears the selection and flies the camera home.
 *
 * `side={DoubleSide}` on BOTH: drei defaults `side` to `BackSide`, but the grid
 * shader swaps the position to `xzy` before building the world matrix, so the
 * effective facing is unpredictable per camera elevation. A single-sided grid
 * silently vanishes above/below the horizon; double-sided is the only setting
 * that survives the orbit clamps.
 *
 * `infiniteGrid={false}` IS DELIBERATE - do not re-enable it
 * drei's `infiniteGrid` path multiplies the local position by
 * `1 + fadeDistance` (e.g. x96) inside the vertex shader while the fade term is
 * still computed in world units. The result is that almost every fragment lands
 * past `fadeDistance` and is discarded, so the floor renders as nothing at all
 * (verified by screenshot: ~0 grid pixels with `infiniteGrid`, ~12k without).
 * The 90x90 plane plus fog already reads as endless; a fixed plane is cheaper
 * and is the configuration that actually draws.
 */
function GroundGrid(): ReactElement {
  return (
    <group>
      <Grid
        position={[0, 0, 0]}
        args={[GRID_PLANE_SIZE, GRID_PLANE_SIZE]}
        cellSize={GRID_CELL_SIZE}
        cellThickness={0.6}
        cellColor={CYBER_400}
        sectionSize={GRID_SECTION_SIZE}
        sectionThickness={1}
        sectionColor={CYBER_400}
        fadeDistance={GRID_FADE_DISTANCE}
        fadeStrength={GRID_FADE_STRENGTH}
        fadeFrom={GRID_FADE_FROM}
        infiniteGrid={false}
        followCamera={false}
        side={DoubleSide}
        raycast={NO_RAYCAST}
      />
      <Grid
        position={[0, 0.012, 0]}
        args={[GRID_PLANE_SIZE, GRID_PLANE_SIZE]}
        cellSize={GRID_SECTION_SIZE}
        cellThickness={1.2}
        cellColor={CYBER_600}
        sectionSize={GRID_SECTION_SIZE * 4}
        sectionThickness={1.6}
        sectionColor={CYBER_300}
        fadeDistance={GRID_FADE_DISTANCE}
        fadeStrength={GRID_FADE_STRENGTH}
        fadeFrom={GRID_FADE_FROM}
        infiniteGrid={false}
        followCamera={false}
        side={DoubleSide}
        raycast={NO_RAYCAST}
      />
    </group>
  );
}

/** Slow cyan dust motes: a depth cue for the empty space around the racks. */
function VoidSparkles({ count }: { readonly count: number }): ReactElement {
  return (
    <Sparkles
      key={count}
      count={count}
      scale={30}
      size={1.2}
      speed={0.2}
      color={CYBER_400}
      opacity={0.55}
      noise={0.4}
      raycast={NO_RAYCAST}
    />
  );
}

/* ==========================================================================
   Frame clock
   ========================================================================== */

/**
 * The single writer of the FPS estimator.
 *
 * `.cursorrules` rule 3 bans React writes inside `useFrame`; this component goes
 * further and writes to the transient pool only. `noteFrame` must be called
 * exactly once per frame cluster-wide - mounting a second driver would double
 * the EMA sample rate and silently halve the reported FPS.
 *
 * Mounted first inside the scene so the delta lands before any later consumer
 * reads `telemetryTransientRef.currentFps` in the same frame.
 */
function FrameClock(): null {
  useFrame((state, delta) => {
    noteFrame(delta);
    noteFrameBudget(
      telemetryTransientRef.currentFps,
      telemetryTransientRef.smoothedFrameMs,
      state.gl.info.render.calls,
    );
  });
  return null;
}

/* ==========================================================================
   Scene graph
   ========================================================================== */

/**
 * Kept separate from `ClusterCanvas` so the `<Canvas>` element's own props stay
 * module-level constants: R3F recreates the renderer when `gl` or `camera`
 * change identity, which would drop the WebGL context on a parent re-render.
 *
 * TOPOLOGY MOUNT
 * The master stands on the origin and the three worker racks orbit it on a ring
 * of radius 9.5 (`topologyLayout`), each facing the centre. Both models are fully
 * procedural - no `.glb` assets - and read their live numbers from the transient
 * telemetry pool inside `useFrame`.
 */
function performanceBounds(refreshRate: number): [number, number] {
  void refreshRate;
  return [PERF_FPS_LOWER, PERF_FPS_UPPER];
}

function declineQuality(): void {
  requestRenderDegraded(true);
}

function restoreQuality(): void {
  requestRenderDegraded(false);
}

function ClusterScene({ sparkleCount }: { readonly sparkleCount: number }): ReactElement {
  return (
    <PerformanceMonitor
      bounds={performanceBounds}
      iterations={8}
      ms={250}
      threshold={0.75}
      onDecline={declineQuality}
      onIncline={restoreQuality}
    >
      <FrameClock />
      <Atmosphere />
      <GroundGrid />
      <VoidSparkles count={sparkleCount} />
      <CameraRig />
      <MasterNode3D />
      <WorkerRackField />
      <PodInstancedField />
      {/* Fault rings are floor decals at y = 0.02, so they never occlude the
          chassis standing on them. */}
      <ErrorRippleField />
      {/* Traffic arches last: they are the only element spanning the whole
          cluster, and mounting them after the hardware keeps the intent obvious. */}
      <NetworkStream3D />
    </PerformanceMonitor>
  );
}

/* ==========================================================================
   Canvas
   ========================================================================== */

/**
 * Renderer config. Hoisted: an inline object literal would be a new identity on
 * every render, and R3F keys the WebGL renderer off it.
 *
 * `alpha` keeps the clear colour transparent so the shell's `.bg-void-bloom`
 * gradient and `.kv-grid-overlay` show through the WebGL layer.
 */
const GL_CONFIG = {
  antialias: true,
  powerPreference: 'high-performance',
  alpha: true,
  premultipliedAlpha: true,
} as const;

/** Retina-capped pixel ratio: 2 is the ceiling, 1 the floor for weak GPUs. */
const CANVAS_DPR: [number, number] = [1, 2];

/**
 * Default framing. Must match `writeOverviewPose` in `topologyLayout.ts`, so the
 * first painted frame and the "reset view" landing pose are the same shot.
 *
 * Declared as a mutable tuple (not `readonly`): R3F's `camera` prop accepts
 * `[x, y, z]` and a readonly tuple is not assignable to it.
 */
const CANVAS_CAMERA = {
  position: [
    OVERVIEW_CAMERA_POSITION[0],
    OVERVIEW_CAMERA_POSITION[1],
    OVERVIEW_CAMERA_POSITION[2],
  ] as [number, number, number],
  fov: 45,
  near: 0.1,
  far: 120,
};

/**
 * 深空赛博运维 3D 视口。
 *
 * The element is transparent and absolutely positioned: its parent cell supplies
 * the bloom, grid overlay and rounded frame, so the canvas is a pure scene layer.
 */
export function ClusterCanvas(): ReactElement {
  const viewportRef = useRef<HTMLDivElement>(null);
  const paused = useInViewPause(viewportRef);
  const budget = useRenderBudgetFlags();

  return (
    <div ref={viewportRef} className="absolute inset-0">
      <Canvas
        frameloop={paused ? 'never' : 'always'}
        dpr={budget.degraded ? 1 : CANVAS_DPR}
        gl={GL_CONFIG}
        camera={CANVAS_CAMERA}
        shadows={false}
        flat={false}
        style={{
          position: 'absolute',
          inset: 0,
          touchAction: 'none',
        }}
        /* Clicking empty space drops the focus, which flies the camera back to the
           overview. Registered here rather than per-mesh so a miss on the fog or a
           grid cell counts too. */
        onPointerMissed={() => {
          useClusterStore.getState().clearSelection();
        }}
        onCreated={({ gl }) => {
          /* Transparent clear: the CSS bloom behind the canvas stays visible. */
          gl.setClearAlpha(0);
          /*
           * R3F enables ACES filmic tone mapping by default (`flat={false}`) and
           * three r155+ uses physical light units. With the fog band the spec
           * requires (`18 -> 45`) blending ~25% of `void.950` into every surface at
           * the ~25-unit overview distance, the default exposure renders the racks
           * as near-black slabs. 1.3 restores the midtones without clipping the
           * cyan edges; tune here, not by inflating every light intensity.
           */
          gl.toneMappingExposure = 1.3;
        }}
      >
        <ClusterScene sparkleCount={budget.sparkleCount} />
      </Canvas>
    </div>
  );
}

export default ClusterCanvas;