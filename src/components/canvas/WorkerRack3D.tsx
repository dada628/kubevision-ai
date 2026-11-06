'use client';

/**
 * KubeVision AI - programmatic worker rack model.
 *
 * ONE RACK, FOUR LAYERS (local space; +Z is the FRONT, facing the master)
 * 1. Armoured frame: frosted, semi-transparent slabs (bevelled by stacking a
 *    slightly smaller inner box) plus cyan edge trim.
 * 2. Four horizontal server trays, each with its own status LED strip.
 * 3. Two vertical neon light-pipes on the front corners, whose colour slides
 *    emerald -> amber -> rose with the node's LIVE load.
 * 4. A holographic nameplate showing node name + live CPU / MEM percentages.
 *
 * WHERE THE NUMBERS COME FROM
 * Never React state. The frame loop reads `telemetryTransientRef` directly (the
 * documented zero-rerender channel): node CPU/MEM are the mean of the hosted
 * pods' values, and the rails read the same source as the LEDs. The nameplate's
 * DOM text is updated through refs at ~4 Hz, NOT by re-rendering the component -
 * a 60 Hz React render for a text label would break rule 3 outright.
 *
 * PICKING CONTRACT
 * THREE raycastable targets, in two disjoint Y bands so a single click can never
 * resolve against two of them:
 * - the base plinth (y 0 .. BASE_TOP_Y) - the widest, most obvious footing;
 * - the invisible pick box around the chassis (y BASE_TOP_Y .. RACK_HEIGHT),
 *   which catches clicks in the gaps between trays and rails;
 * - everything else is `raycast={NO_RAYCAST}`, and the nameplate `<Html>` uses
 *   `pointerEvents="none"` so it cannot swallow clicks over empty space.
 * Both pickable meshes share one handler pair, so hover/selection state is a
 * single boolean/ramp per rack rather than duplicated per element.
 *
 * CLICK vs ORBIT DRAG
 * Selection fires from `onPointerUp`, not `onClick`, gated on the press-to-release
 * distance (`CLICK_DRAG_SLOP`). R3F applies no drag threshold to `onClick`, so
 * pressing on the plinth - the widest target - to swing the camera around would
 * otherwise end in a phantom selection of the rack the operator was only
 * rotating past.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactElement,
} from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { BoxGeometry, Color, EdgesGeometry, Vector3 } from 'three';
import type {
  Group,
  LineBasicMaterial,
  MeshBasicMaterial,
  MeshStandardMaterial,
} from 'three';
import type { RackIndex, WorkerNodeEntity } from '@/types/cluster';
import { useClusterStore } from '@/store/useClusterStore';
import { getSnapshot } from '@/store/useTelemetryRef';
import {
  RACK_DEPTH,
  RACK_HEIGHT,
  RACK_TRAY_COUNT,
  RACK_WIDTH,
  rackFacingYaw,
  writeRackOrigin,
} from './topologyLayout';
import {
  isCriticalLoad,
  loadEmissiveIntensity,
  writeLoadColor,
} from './loadPalette';

/* ==========================================================================
   Tunables
   ========================================================================== */

/** Frame width of the armoured uprights. */
const FRAME_POST_WIDTH = 0.16;

/** Depth of the armoured frame. */
const FRAME_DEPTH = RACK_DEPTH;

/** Inset of the tray stack from the side uprights. */
const TRAY_INSET_X = 0.26;

/** Thickness of one server tray slab. */
const TRAY_THICKNESS = 0.3;

/**
 * Y of the tray stack's first and last centres.
 *
 * The four trays must span the FULL usable chassis height, not cluster near the
 * floor: with a fixed 1.0 base and 0.64 pitch the top tray landed at y=2.92
 * inside a 5.2-tall chassis, leaving the upper 44% as empty armour and making
 * the rack read as half-populated.
 */
const TRAY_BASE_Y = 0.95;
const TRAY_TOP_Y = RACK_HEIGHT - 0.95;

/** Vertical pitch between tray centres, derived from the span above. */
const TRAY_PITCH =
  (TRAY_TOP_Y - TRAY_BASE_Y) / Math.max(1, RACK_TRAY_COUNT - 1);

/** Neon light-pipe radius, and the Z where it is mounted (just proud of the face). */
const RAIL_RADIUS = 0.045;
const RAIL_Z = FRAME_DEPTH / 2 + 0.05;

/* ==========================================================================
   Base plinth
   ========================================================================== */

/**
 * The plinth is a separate, slightly wider slab under the chassis.
 *
 * WHY IT NEEDS ITS OWN GEOMETRY
 * The old pick box started at y = 0 and was invisible, so the only way to select
 * a rack was to hit empty-looking air below the trays. Operators aim at the
 * FOOTING of a rack, so the footing gets real geometry and its own click target;
 * the top surface is `BASE_TOP_Y` so the hit bands never overlap.
 */
const BASE_WIDTH = RACK_WIDTH + 0.46;
const BASE_DEPTH = FRAME_DEPTH + 0.46;
const BASE_HEIGHT = 0.22;
const BASE_TOP_Y = BASE_HEIGHT;

/** Height of the invisible chassis pick band (everything above the plinth). */
const CHASSIS_SPAN_Y = RACK_HEIGHT - BASE_TOP_Y;

/** Selected-only floor halo: max opacity, and it only appears once selected. */
const BASE_HALO_MAX_OPACITY = 0.55;

/** Plinth material tones: dark slab idle, cyan-lit edge when focused. */
const BASE_COLOR = '#071426';
const BASE_EMISSIVE = '#0b3a4d';
const BASE_EMISSIVE_FOCUS = '#0e7490';
/** Parsed once: the frame loop must not allocate a `Color` per tick. */
const BASE_EMISSIVE_COLOR = new Color(BASE_EMISSIVE);
const BASE_EMISSIVE_FOCUS_COLOR = new Color(BASE_EMISSIVE_FOCUS);

/* ==========================================================================
   Armour wireframe
   ========================================================================== */

/**
 * Full-chassis edge cage.
 *
 * `opacity` is the contract the operator asked for: faint (0.22) at rest so it
 * never competes with the neon rails, and nearly opaque (0.92) once the rack is
 * selected, which is what makes the selection readable in the wide overview shot
 * where a hue shift alone is easy to miss against a dark chassis.
 */
const ARMOUR_EDGE_IDLE_OPACITY = 0.22;
const ARMOUR_EDGE_FOCUS_OPACITY = 0.92;
const ARMOUR_EDGE_IDLE_COLOR = new Color('#0e7490');
const ARMOUR_EDGE_FOCUS_COLOR = new Color('#67e8f9');
/** Slightly proud of the panel faces so the cage never z-fights the armour. */
const ARMOUR_EDGE_PADDING = 0.035;

/** Plate height above the rack top, in local space. */
const PLATE_OFFSET_Y = RACK_HEIGHT + 0.85;

/** Focus easing rate (hover / selection glow). */
const FOCUS_LAMBDA = 9;

/**
 * Selection ramp rate. Slower than hover on purpose: hover is a transient
 * pointer flick that should feel instant, whereas selection is a state change
 * the operator must be able to SEE happen, so the cage fades up over ~0.3s.
 */
const SELECTION_LAMBDA = 6;

/** DOM readout refresh interval, in ms. Text updates do not need 60 Hz. */
const PLATE_REFRESH_MS = 250;

/**
 * Click/drag discrimination threshold, in CSS pixels.
 *
 * WHY THIS EXISTS
 * R3F's `onClick` is purely "pointerup landed on the same object as pointerdown";
 * it applies NO distance threshold of its own. Since the plinth is the widest
 * target on a rack, the natural way to orbit the camera - press on the footing,
 * drag sideways - ended with a phantom click that selected the rack the operator
 * was only trying to look at from another angle. 6px is above hand tremor and
 * below any deliberate camera move, so a real click still registers.
 */
const CLICK_DRAG_SLOP = 6;

/* ==========================================================================
   Material singletons
   ========================================================================== */

const TRIM_BASE_COLOR = new Color('#155e75');
const TRIM_FOCUS_COLOR = new Color('#67e8f9');
const FRAME_COLOR = '#0b1c31';
const FRAME_EMISSIVE = '#0e465e';
const LED_OFF_COLOR = '#164e63';

/** Fixed rack slots, in render order. */
const RACK_INDICES: readonly RackIndex[] = [0, 1, 2];

/* ==========================================================================
   Component
   ========================================================================== */

interface WorkerRack3DProps {
  readonly rackIndex: RackIndex;
}

export function WorkerRack3D({ rackIndex }: WorkerRack3DProps): ReactElement {
  /* ----------------------------------------------------- preallocated state */
  /** World transform, computed once: the ring never moves at runtime. */
  const placement = useMemo(
    () => writeRackOrigin(rackIndex, new Vector3()),
    [rackIndex],
  );

  const yaw = useMemo(() => rackFacingYaw(rackIndex), [rackIndex]);

  /**
   * Edge cage geometry, built ONCE per rack.
   *
   * `EdgesGeometry` walks the whole triangle list, so rebuilding it in the frame
   * loop (or even in render) would be wasted work on a static box. It must also
   * be disposed explicitly: drei/R3F dispose geometry they own, but geometry
   * passed via `args`/`geometry` props created outside the tree is our
   * responsibility under rule 3's "no allocation in the loop" spirit.
   */
  const armourEdges = useMemo(() => {
    /* The source box is only read (vertices are copied into the edge list), so it
       is disposed immediately instead of being leaked until GC. */
    const source = new BoxGeometry(
      RACK_WIDTH + ARMOUR_EDGE_PADDING * 2,
      RACK_HEIGHT + ARMOUR_EDGE_PADDING * 2,
      FRAME_DEPTH + ARMOUR_EDGE_PADDING * 2,
    );
    const edges = new EdgesGeometry(source);
    source.dispose();
    return edges;
  }, []);

  /* Edges must be released by us: it was created outside the R3F tree. */
  useEffect(() => () => armourEdges.dispose(), [armourEdges]);

  /** Scratch colours for the frame loop - three rails, two materials each. */
  const scratch = useMemo(
    () => ({
      railLeft: new Color(),
      railRight: new Color(),
      trim: new Color(),
    }),
    [],
  );

  /* ---------------------------------------------------------- mesh refs */
  const groupRef = useRef<Group | null>(null);
  const railLeftRef = useRef<MeshStandardMaterial | null>(null);
  const railRightRef = useRef<MeshStandardMaterial | null>(null);
  const trimMaterialRef = useRef<MeshBasicMaterial | null>(null);
  const armourEdgeMaterialRef = useRef<LineBasicMaterial | null>(null);
  const baseMaterialRef = useRef<MeshStandardMaterial | null>(null);
  const baseHaloMaterialRef = useRef<MeshBasicMaterial | null>(null);
  const ledMaterialsRef = useRef<Array<MeshStandardMaterial | null>>(
    Array.from({ length: RACK_TRAY_COUNT }, () => null),
  );

  /* ------------------------------------------------------- nameplate refs */
  const plateNameRef = useRef<HTMLSpanElement | null>(null);
  const plateCpuRef = useRef<HTMLSpanElement | null>(null);
  const plateMemRef = useRef<HTMLSpanElement | null>(null);
  const plateRef = useRef<HTMLDivElement | null>(null);
  const lastPlateWriteRef = useRef<number>(0);

  /**
   * Hover is tracked as a COUNTER, not a boolean.
   *
   * The plinth and the chassis pick box are separate meshes, so dragging the
   * pointer from the footing up onto the rack fires `out` (plinth) and `over`
   * (chassis) in the same gesture. A boolean would flicker the glow off and on;
   * counting deltas keeps it continuously lit while EITHER target is hovered.
   * Never negative, so a stray `out` cannot underflow into "hovered forever".
   */
  const hoverCountRef = useRef<number>(0);
  const focusRef = useRef<number>(0);
  /** Continuous 0..1 selection ramp driving the armour cage + plinth. */
  const selectedRef = useRef<number>(0);

  /**
   * Pointer-down origin for click/drag discrimination.
   *
   * `null` means no gesture is in flight. Written on every press, read on the
   * matching release. A ref (not state) because a drag must never schedule a
   * React render - rule 3.
   */
  const pressOriginRef = useRef<{ x: number; y: number } | null>(null);

  /* ------------------------------------------------------------- handlers */
  /**
   * Press origin capture. Registered on BOTH pickable meshes (plinth + chassis
   * pick box) so the slop is measured from wherever the gesture actually began,
   * not from the plinth alone.
   */
  const handlePointerDown = useCallback((event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    pressOriginRef.current = { x: event.nativeEvent.clientX, y: event.nativeEvent.clientY };
  }, []);

  /**
   * Toggle selection for this rack.
   *
   * Driven from `onPointerUp` rather than `onClick` so the drag slop above can be
   * enforced: picking the target is still the raycaster's job (an up event only
   * reaches this mesh when the ray hit it), but the DISTANCE travelled between
   * press and release decides whether the operator meant to click or to orbit.
   */
  const handlePointerUp = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      event.stopPropagation();

      const origin = pressOriginRef.current;
      pressOriginRef.current = null;
      if (origin === null) {
        return;
      }
      const dx = event.nativeEvent.clientX - origin.x;
      const dy = event.nativeEvent.clientY - origin.y;
      if (Math.hypot(dx, dy) > CLICK_DRAG_SLOP) {
        /* This was an orbit drag, not a click. Swallow it so the gesture does not
           fall through to `onPointerMissed` and deselect whatever was focused. */
        return;
      }

      const node = findNodeForRack(rackIndex);
      if (node === null) {
        return;
      }
      const store = useClusterStore.getState();
      if (store.selectedEntityId === node.id) {
        store.clearSelection();
        return;
      }
      store.selectEntity(node.id, 'node');
    },
    [rackIndex],
  );

  const handleOver = useCallback(() => {
    hoverCountRef.current += 1;
    if (typeof document !== 'undefined') {
      document.body.style.cursor = 'pointer';
    }
  }, []);

  const handleOut = useCallback(() => {
    if (hoverCountRef.current > 0) {
      hoverCountRef.current -= 1;
    }
    /* Only release the cursor once no part of this rack is hovered, otherwise
       stepping off the plinth onto the chassis would clear it mid-hover. */
    if (hoverCountRef.current === 0 && typeof document !== 'undefined') {
      document.body.style.cursor = 'auto';
    }
  }, []);

  /* ------------------------------------------------------------ frame loop */
  useFrame((state, delta) => {
    const dt = Math.min(Math.max(delta, 0), 0.1);

    const node = findNodeForRack(rackIndex);

    /* ---------------- live load (0..100) ------------------------------- */
    const load = node === null ? 0 : readNodeLoad(node);
    const cpu = node === null ? 0 : readNodeCpu(node);
    const mem = node === null ? 0 : readNodeMem(node);

    const isSelected =
      node !== null &&
      useClusterStore.getState().selectedEntityId === node.id;
    /* `selectedRef` is the CONTINUOUS 0..1 selection ramp: the armour cage and
       plinth use it (selection must look stable and deliberate), while the
       hysteresis-free hover state only feeds the softer `focus` ramp. */
    selectedRef.current = dampScalar(
      selectedRef.current,
      isSelected ? 1 : 0,
      SELECTION_LAMBDA,
      dt,
    );
    const selected = selectedRef.current;
    const focusTarget = hoverCountRef.current > 0 || isSelected ? 1 : 0;
    focusRef.current = dampScalar(
      focusRef.current,
      focusTarget,
      FOCUS_LAMBDA,
      dt,
    );
    const focus = focusRef.current;

    /* ---------------- neon light-pipes --------------------------------- */
    writeLoadColor(load, scratch.railLeft);
    /* A subtle pulse on saturated nodes only: an idle rack must stay steady, or
       the whole ring throbs and the alarm loses its meaning. */
    const pulse = isCriticalLoad(load)
      ? 0.82 + Math.sin(state.clock.elapsedTime * 5.2) * 0.18
      : 1;
    const intensity = loadEmissiveIntensity(load) * pulse * (1 + focus * 0.5);

    const railLeft = railLeftRef.current;
    if (railLeft !== null) {
      railLeft.color.copy(scratch.railLeft);
      /* Hover/selection pushes toward white-hot without changing the hue. */
      if (focus > 0) {
        railLeft.color.lerp(TRIM_FOCUS_COLOR, focus * 0.35);
      }
      railLeft.emissive.copy(railLeft.color);
      railLeft.emissiveIntensity = intensity;
    }
    const railRight = railRightRef.current;
    if (railRight !== null) {
      railRight.color.copy(scratch.railLeft);
      if (focus > 0) {
        railRight.color.lerp(TRIM_FOCUS_COLOR, focus * 0.35);
      }
      railRight.emissive.copy(railRight.color);
      railRight.emissiveIntensity = intensity;
    }

    /* ---------------- edge trim --------------------------------------- */
    const trim = trimMaterialRef.current;
    if (trim !== null) {
      scratch.trim.copy(TRIM_BASE_COLOR).lerp(TRIM_FOCUS_COLOR, focus);
      trim.color.copy(scratch.trim);
    }

    /* ---------------- armour edge cage (selection contract) ------------ */
    /* Opacity is the primary signal: 0.22 at rest, 0.92 when selected. Colour
       rides along with it so the outline also shifts to the highlight cyan. */
    const armourEdge = armourEdgeMaterialRef.current;
    if (armourEdge !== null) {
      armourEdge.opacity =
        ARMOUR_EDGE_IDLE_OPACITY +
        (ARMOUR_EDGE_FOCUS_OPACITY - ARMOUR_EDGE_IDLE_OPACITY) * selected;
      armourEdge.color
        .copy(ARMOUR_EDGE_IDLE_COLOR)
        .lerp(ARMOUR_EDGE_FOCUS_COLOR, selected);
    }

    /* ---------------- base plinth ------------------------------------- */
    const base = baseMaterialRef.current;
    if (base !== null) {
      base.emissiveIntensity = 0.45 + selected * 0.85;
      base.emissive
        .copy(BASE_EMISSIVE_COLOR)
        .lerp(BASE_EMISSIVE_FOCUS_COLOR, selected);
    }
    const baseHalo = baseHaloMaterialRef.current;
    if (baseHalo !== null) {
      baseHalo.opacity = BASE_HALO_MAX_OPACITY * selected;
    }

    /* ---------------- tray LEDs --------------------------------------- */
    /* Each shelf shows its own slice of the node's load so the stack reads as
       hardware, not as four copies of one gauge. */
    for (let index = 0; index < RACK_TRAY_COUNT; index += 1) {
      const material = ledMaterialsRef.current[index];
      if (material === null || material === undefined) {
        continue;
      }
      const slice = Math.min(100, Math.max(0, load * (0.72 + index * 0.1)));
      writeLoadColor(slice, scratch.trim);
      material.color.copy(scratch.trim);
      material.emissive.copy(scratch.trim);
      material.emissiveIntensity = 1.1 + focus * 0.8;
    }

    /* ---------------- nameplate text (throttled) ----------------------- */
    if (node !== null) {
      const now = state.clock.elapsedTime * 1000;
      if (now - lastPlateWriteRef.current >= PLATE_REFRESH_MS) {
        lastPlateWriteRef.current = now;
        const nameEl = plateNameRef.current;
        if (nameEl !== null) {
          nameEl.textContent = node.name;
        }
        const cpuEl = plateCpuRef.current;
        if (cpuEl !== null) {
          cpuEl.textContent = `${cpu.toFixed(1)}%`;
        }
        const memEl = plateMemRef.current;
        if (memEl !== null) {
          memEl.textContent = `${mem.toFixed(1)}%`;
        }
        const plate = plateRef.current;
        if (plate !== null) {
          /* The plate's own border colour follows the status tone so a glance at
             the top of the rack is enough to triage it. */
          writeLoadColor(load, scratch.trim);
          plate.style.borderColor = `#${scratch.trim.getHexString()}`;
          plate.style.color = `#${scratch.trim.getHexString()}`;
        }
      }
    }

    /* ---------------- selection lift ----------------------------------- */
    /* Subtle, but it separates the selected rack from the ground grid without
       changing the layout maths (the telemetry slot helpers stay authoritative). */
    const group = groupRef.current;
    if (group !== null) {
      group.position.y = selected * 0.09;
    }
  });

  return (
    <group
      ref={groupRef}
      position={[placement.x, placement.y, placement.z]}
      rotation={[0, yaw, 0]}
    >
      {/*
        BASE PLINTH - a real, VISIBLE click target.
        Operators aim at the footing of a rack, so the footing gets geometry of
        its own. It spans y 0..BASE_TOP_Y, and the chassis pick box starts at
        BASE_TOP_Y, so the two hit volumes are disjoint: no single ray can
        resolve against both and fire the toggle twice.
      */}
      <mesh
        position={[0, BASE_HEIGHT / 2, 0]}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerOver={handleOver}
        onPointerOut={handleOut}
      >
        <boxGeometry args={[BASE_WIDTH, BASE_HEIGHT, BASE_DEPTH]} />
        <meshStandardMaterial
          ref={baseMaterialRef}
          color={BASE_COLOR}
          emissive={BASE_EMISSIVE}
          emissiveIntensity={0.45}
          roughness={0.5}
          metalness={0.45}
          toneMapped={false}
        />
      </mesh>

      {/* Plinth halo: a flat cyan ring that only reads once the rack is selected,
          grounding the highlight on the floor plane instead of floating it. */}
      <mesh
        position={[0, BASE_HEIGHT + 0.012, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        raycast={NO_RAYCAST}
      >
        <ringGeometry args={[BASE_WIDTH * 0.44, BASE_WIDTH * 0.5, 48]} />
        <meshBasicMaterial
          ref={baseHaloMaterialRef}
          color={ARMOUR_EDGE_FOCUS_COLOR}
          transparent
          opacity={0}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/*
        PICK BOX - invisible, deliberately larger than the chassis.
        Spans only the chassis band (BASE_TOP_Y .. RACK_HEIGHT) so it never
        competes with the plinth. It sits behind the detail meshes so a hit on
        the frame still wins, but it catches clicks in the gaps between trays and
        rails: without it the hollow centre of the rack is a dead zone that falls
        through to `onPointerMissed` and deselects the thing just clicked.
      */}
      <mesh
        position={[0, BASE_TOP_Y + CHASSIS_SPAN_Y / 2, 0]}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerOver={handleOver}
        onPointerOut={handleOut}
        visible={false}
      >
        <boxGeometry args={[RACK_WIDTH, CHASSIS_SPAN_Y, RACK_DEPTH]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* ------------------------------------- armour edge cage (wireframe) */}
      {/* Full-chassis outline: faint at rest, bright cyan when selected. This is
          the "armour wireframe" the selection contract refers to; it is a single
          LineSegments draw call, not one line per edge. */}
      <lineSegments
        geometry={armourEdges}
        position={[0, RACK_HEIGHT / 2, 0]}
        raycast={NO_RAYCAST}
      >
        <lineBasicMaterial
          ref={armourEdgeMaterialRef}
          color={ARMOUR_EDGE_IDLE_COLOR}
          transparent
          opacity={ARMOUR_EDGE_IDLE_OPACITY}
          depthWrite={false}
          toneMapped={false}
        />
      </lineSegments>

      {/* ---------------------------------------- armoured uprights (frame) */}
      {[-1, 1].map((side) => (
        <mesh
          key={`post-${side}`}
          position={[
            side * (RACK_WIDTH / 2 - FRAME_POST_WIDTH / 2),
            RACK_HEIGHT / 2,
            0,
          ]}
          raycast={NO_RAYCAST}
        >
          <boxGeometry args={[FRAME_POST_WIDTH, RACK_HEIGHT, FRAME_DEPTH]} />
          <meshStandardMaterial
            color={FRAME_COLOR}
            emissive={FRAME_EMISSIVE}
            emissiveIntensity={0.5}
            roughness={0.62}
            metalness={0.18}
            transparent
            opacity={0.82}
          />
        </mesh>
      ))}

      {/* Frosted top and bottom armour caps: closes the shape so it reads as a
          sealed enclosure instead of two floating columns. */}
      {[0, RACK_HEIGHT].map((y, capIndex) => (
        <mesh
          key={`cap-${capIndex}`}
          position={[0, y, 0]}
          raycast={NO_RAYCAST}
        >
          <boxGeometry args={[RACK_WIDTH, 0.16, FRAME_DEPTH]} />
          <meshStandardMaterial
            color={FRAME_COLOR}
            emissive={FRAME_EMISSIVE}
            emissiveIntensity={0.6}
            roughness={0.55}
            metalness={0.22}
            transparent
            opacity={0.9}
          />
        </mesh>
      ))}

      {/* -------------------------------------------------- 4 server trays */}
      {Array.from({ length: RACK_TRAY_COUNT }, (_unused, index) => {
        const y = TRAY_BASE_Y + index * TRAY_PITCH;
        return (
          <group key={`tray-${index}`} position={[0, y, 0]}>
            {/* Shelf slab */}
            <mesh raycast={NO_RAYCAST}>
              <boxGeometry
                args={[RACK_WIDTH - TRAY_INSET_X * 2, TRAY_THICKNESS, FRAME_DEPTH * 0.8]}
              />
              <meshStandardMaterial
                color="#0d2136"
                emissive="#124b63"
                emissiveIntensity={0.35}
                roughness={0.8}
                metalness={0.1}
                transparent
                opacity={0.86}
              />
            </mesh>
            {/* Status LED strip on the shelf's front lip */}
            <mesh position={[0, 0, (FRAME_DEPTH * 0.8) / 2 + 0.012]} raycast={NO_RAYCAST}>
              <boxGeometry
                args={[RACK_WIDTH - TRAY_INSET_X * 2 - 0.1, 0.05, 0.012]}
              />
              <meshStandardMaterial
                ref={(instance) => {
                  ledMaterialsRef.current[index] = instance;
                }}
                color={LED_OFF_COLOR}
                emissive={LED_OFF_COLOR}
                emissiveIntensity={1.1}
                toneMapped={false}
              />
            </mesh>
          </group>
        );
      })}

      {/* ------------------------------------ vertical neon light-pipes ---- */}
      {[-1, 1].map((side) => (
        <mesh
          key={`rail-${side}`}
          position={[side * (RACK_WIDTH / 2 - 0.02), RACK_HEIGHT / 2, RAIL_Z]}
          raycast={NO_RAYCAST}
        >
          <cylinderGeometry args={[RAIL_RADIUS, RAIL_RADIUS, RACK_HEIGHT * 0.9, 10]} />
          <meshStandardMaterial
            ref={side === -1 ? railLeftRef : railRightRef}
            color="#34d399"
            emissive="#34d399"
            emissiveIntensity={1.2}
            roughness={0.2}
            metalness={0.1}
            toneMapped={false}
          />
        </mesh>
      ))}

      {/* ------------------------------------------------ cyan edge trim -- */}
      <mesh position={[0, RACK_HEIGHT / 2, FRAME_DEPTH / 2]} raycast={NO_RAYCAST}>
        <boxGeometry args={[RACK_WIDTH + 0.02, RACK_HEIGHT + 0.02, 0.012]} />
        <meshBasicMaterial
          ref={trimMaterialRef}
          color={TRIM_BASE_COLOR}
          wireframe
          transparent
          opacity={0.55}
          toneMapped={false}
        />
      </mesh>

      {/* -------------------------------------------- holographic nameplate */}
      <Html
        position={[0, PLATE_OFFSET_Y, 0]}
        center
        distanceFactor={22}
        pointerEvents="none"
        zIndexRange={[30, 0]}
      >
        <div
          ref={plateRef}
          className="select-none whitespace-nowrap rounded border bg-slate-950/90 px-2.5 py-1 text-center backdrop-blur-md"
          style={{ borderColor: '#22d3ee', color: '#22d3ee', opacity: 0.97 }}
        >
          <span
            ref={plateNameRef}
            className="block font-mono text-[11px] uppercase tracking-[0.16em]"
          >
            worker
          </span>
          <span className="mt-0.5 flex items-center justify-center gap-1.5 font-mono text-[9px] tracking-wider text-slate-400">
            <span>
              cpu <span ref={plateCpuRef}>--</span>
            </span>
            <span className="text-slate-700" aria-hidden>
              |
            </span>
            <span>
              mem <span ref={plateMemRef}>--</span>
            </span>
          </span>
        </div>
      </Html>
    </group>
  );
}

/* ==========================================================================
   Scene wrapper
   ========================================================================== */

/** Mounts the three racks. Exported so `ClusterCanvas` stays declarative. */
export function WorkerRackField(): ReactElement {
  return (
    <group>
      {RACK_INDICES.map((rackIndex) => (
        <WorkerRack3D key={`rack-${rackIndex}`} rackIndex={rackIndex} />
      ))}
    </group>
  );
}

/* ==========================================================================
   Helpers
   ========================================================================== */

/** Shared "not pickable" raycaster override. */
const NO_RAYCAST: () => null = () => null;

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

/** The worker node bolted into `rackIndex`, or null if this slot is empty. */
function findNodeForRack(rackIndex: RackIndex): WorkerNodeEntity | null {
  const snapshot = getSnapshot();
  for (const node of snapshot.nodes) {
    if (node.rackIndex === rackIndex) {
      return node;
    }
  }
  return null;
}

/** Mean CPU utilization of the pods hosted by `node`. */
function readNodeCpu(node: WorkerNodeEntity): number {
  const snapshot = getSnapshot();
  let sum = 0;
  let count = 0;
  for (const pod of snapshot.pods) {
    if (pod.nodeId !== node.id) {
      continue;
    }
    sum += pod.cpuUsage;
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

/** Mean memory utilization of the pods hosted by `node`. */
function readNodeMem(node: WorkerNodeEntity): number {
  const snapshot = getSnapshot();
  let sum = 0;
  let count = 0;
  for (const pod of snapshot.pods) {
    if (pod.nodeId !== node.id) {
      continue;
    }
    sum += pod.memoryUsage;
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * Composite load driving the neon rails: the worse of CPU and memory, nudged by
 * the node's own status so a partitioned node reads as saturated even when its
 * pod metrics have been zeroed out by the scheduler.
 */
function readNodeLoad(node: WorkerNodeEntity): number {
  const cpu = readNodeCpu(node);
  const mem = readNodeMem(node);
  let load = Math.max(cpu, mem);
  if (node.status === 'HighLoad' && load < 78) {
    load = 78;
  }
  if (node.status === 'NetworkPartition') {
    load = 100;
  }
  return load;
}

export default WorkerRack3D;