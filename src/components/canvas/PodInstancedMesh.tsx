'use client';

/**
 * KubeVision AI - instanced pod renderer.
 *
 * ONE DRAW CALL PER RACK, NOT ONE PER POD
 * The cluster holds 24 pods on 16-slot grids across three racks. Rendering each
 * as its own mesh would cost 24 draw calls plus 24 React elements; this component
 * collapses a rack's containers into a single `InstancedMesh` whose per-instance
 * matrix and colour are written straight into the GPU buffers inside `useFrame`.
 * One mesh per rack (rather than one global mesh) is deliberate: parenting it to
 * the rack group lets the rack's yaw be baked into the parent transform once,
 * instead of being re-derived for 16 instances every frame.
 *
 * ALLOCATION DISCIPLINE (`.cursorrules` rule 3)
 * Everything touched on the frame path is preallocated: `tempObject`
 * (`Object3D`), `tempColor` (`Color`) and the scratch `Vector3` used to place a
 * slot all come from `useMemo` / module scope and live for the process lifetime.
 * The frame loop calls `setMatrixAt` / `setColorAt` and flips one `needsUpdate`
 * flag; it never constructs a matrix, a colour, a `Set` or a React element.
 *
 * WHY THE EMISSIVE NEEDS A SHADER PATCH
 * `meshStandardMaterial` multiplies instance colour into `diffuseColor` only. The
 * emerald/amber/rose status language is carried by EMISSIVE glow on a dark
 * chassis, so a stock material would render status as lighting-dependent albedo
 * and a broken pod would lose its alarm colour at low light. The patch below
 * routes the same per-instance colour into the emissive term, so one
 * `instanceColor` write drives BOTH albedo and glow - and the glow hue stays
 * exact per container instead of being flattened by a shared uniform.
 *
 * PICKING - THE PODS WIN OVER THE CHASSIS BEHIND THEM
 * The cells are now the most specific target in the scene, so they ARE pickable.
 * Two consequences are handled explicitly:
 *
 * 1. HIT-AREA VS VISUAL SIZE. A filtered-out pod eases to 15% scale; its
 *    raycastable geometry would shrink with it, so the cells an operator can
 *    actually aim at would change size when they touch the status chips. The
 *    instance matrix keeps the visual scale small but the raycast runs against a
 *    POINT probe placed on the slot centre (see `handlePointerMove`), so the
 *    target stays constant no matter how the pod is animated.
 * 2. CURSOR / CLICK OWNERSHIP. The pod sits in front of the rack's pick box, so
 *    the rack sees enter/leave pairs racing with the pod's. The cursor is shared
 *    through `cursorPointer`'s depth counter, and `stopPropagation` in the pod
 *    handlers keeps a pod click from ALSO selecting the rack underneath.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { Color, InstancedMesh, MeshStandardMaterial } from 'three';
import {
  Color as ThreeColor,
  InstancedBufferAttribute,
  Object3D as ThreeObject3D,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { PodStatus, RackIndex, WorkerNodeEntity } from '@/types/cluster';
import { matchesStatusFilter } from '@/types/store';
import type { PodStatusFilter } from '@/types/store';
import { useClusterStore } from '@/store/useClusterStore';
import { getSnapshot } from '@/store/useTelemetryRef';
import { acquirePointerCursor, releasePointerCursor } from './cursorPointer';
import {
  HTML_OVERLAY_CONTENT_STYLE,
  HTML_OVERLAY_WRAPPER_CLASS,
} from './htmlOverlay';
import {
  POD_CUBE_SIZE,
  POD_SLOT_COUNT,
  rackFacingYaw,
  writePodSlotLocal,
  writeRackOrigin,
} from './topologyLayout';

/* ==========================================================================
   Status palette - module-level singletons, never mutated
   ========================================================================== */

/** Running containers: emerald. Comfortable, "traffic is being served". */
const STATUS_RUNNING_COLOR = new ThreeColor('#10b981');

/** Pending containers: amber. Scheduled but not yet serving. */
const STATUS_PENDING_COLOR = new ThreeColor('#f59e0b');

/** Failed containers: rose. CrashLoopBackOff / OOMKilled / Terminating. */
const STATUS_FAILED_COLOR = new ThreeColor('#f43f5e');

/** A slot with no pod scheduled into it. Nearly black - it must read as empty. */
const STATUS_EMPTY_COLOR = new ThreeColor('#0b1f2e');

/* ==========================================================================
   Motion tunables
   ========================================================================== */

/** Running: vertical drift amplitude, in world units. */
const RUNNING_FLOAT_AMPLITUDE = 0.055;

/** Running: vertical drift rate, in rad/s. Slow is the point - it reads as calm. */
const RUNNING_FLOAT_RATE = 1.5;

/** Running: glow gain floor and load-driven span. Kept near 1 so the emerald
 *  never clips its red/blue channels into a yellow-white. */
const RUNNING_GLOW_MIN = 0.55;
const RUNNING_GLOW_SPAN = 0.45;

/** Pending: glow floor / ceiling. Dim -> awake -> dim, never a hard flash. */
const PENDING_PULSE_MIN = 0.4;
const PENDING_PULSE_MAX = 1.0;

/** Failed: glow floor and beat-driven span. */
const FAILED_GLOW_MIN = 0.7;
const FAILED_GLOW_MAX = 1.45;

/**
 * Ceiling for the per-instance glow multiplier.
 *
 * WHY A CEILING MATTERS FOR HUE, NOT JUST BRIGHTNESS
 * The emissive term is `colour * glow`. Emerald `#10b981` is `(0.06, 0.73, 0.51)`
 * in linear-ish sRGB, so a glow above ~1.35 pushes green past 1.0 while red stays
 * near 0.08 - the tone-mapped result reads as YELLOW-WHITE, not green. Capping the
 * multiplier keeps every status inside its intended hue band.
 */
const MAX_GLOW_GAIN = 1.35;

/** Pending: pulse rate, in rad/s. Slower than a failing pod on purpose. */
const PENDING_PULSE_RATE = 2.2;

/** Failed: horizontal shake amplitude, matching the agreed 0.04-unit budget. */
const FAILED_SHAKE_AMPLITUDE = 0.04;

/** Failed: shake rate, in rad/s (~5.6 Hz). Frantic, but not a motion blur. */
const FAILED_SHAKE_RATE = 35;

/** Failed: scale pulse rate, in rad/s. */
const FAILED_SCALE_RATE = 9;

/** Failed: scale swing around 1.0 (0.86 -> 1.14). */
const FAILED_SCALE_SWING = 0.14;

/** Filtered-out instances shrink to this factor instead of disappearing. */
const FILTERED_OUT_SCALE = 0.15;

/**
 * Interval, in ms, between writes to the hover tooltip's DOM text.
 *
 * The tooltip shows live CPU%, so it has to refresh while the cursor rests on a
 * pod - but re-rendering React at frame rate would break rule 3. Same approach as
 * the rack nameplates: mutate `textContent` through refs on a 4 Hz cadence.
 */
const TOOLTIP_REFRESH_MS = 250;

/**
 * Hover emphasis applied to the hovered instance only.
 *
 * A scale bump is used rather than a hover outline: 16 instances share one mesh,
 * so an extra outline mesh would need its own matrix write every frame. Scaling
 * the single hovered instance reads instantly and costs one multiply.
 */
const HOVER_SCALE_BOOST = 1.18;

/** Rate at which the hovered instance eases into `HOVER_SCALE_BOOST`. */
const HOVER_LAMBDA = 14;

/**
 * Smallest scale an EMPTY slot is allowed to collapse to.
 *
 * WHY NOT ZERO
 * `InstancedMesh.computeBoundingSphere()` unions every instance's transformed
 * geometry. If the empty slots were scaled to exactly 0 they would each contribute
 * a zero-radius sphere, and because most of a lightly-populated rack is empty the
 * union would stay tiny - then three's raycast rejects the WHOLE mesh on its first
 * bounding-sphere test, so NO pod in that rack is pickable and every click falls
 * through to the rack behind it. A hair above zero keeps the union honest while
 * staying sub-pixel at the overview distance.
 */
const EMPTY_SLOT_SCALE = 0.0001;

/**
 * Easing rate for the status colour, the filter emphasis and the scale ramp.
 * 7 is snappy enough that a chaos injection registers immediately, while still
 * hiding the one-frame state flip behind a short fade.
 */
const EASE_LAMBDA = 7;

/* ==========================================================================
   Shader patch
   ========================================================================== */

/**
 * Routes the per-instance colour into the emissive term, scaled by a SEPARATE
 * per-instance brightness attribute.
 *
 * WHY A SECOND ATTRIBUTE
 * `instanceColor` feeds `diffuseColor` (albedo). If the status brightness were
 * baked into it, dimming a pending pod's pulse would also darken its body and the
 * amber would read brown. Two attributes keep the channels independent: hue from
 * `instanceColor`, glow from `instanceGlow`.
 *
 * WHY NOT `emissiveIntensity`
 * `emissiveIntensity` is NOT a shader uniform - three multiplies it into the
 * `emissive` value on the JS side before upload, so referencing it in GLSL fails
 * to compile ("undeclared identifier"). The injected term therefore uses
 * `emissive` (already scaled) multiplied by the per-instance glow.
 *
 * `USE_COLOR` is defined whenever instancing colours are present (three's
 * `WebGLProgram` emits it for `instancingColor || batchingColor || vertexColors`),
 * so `vColor` exists in the fragment stage. `customProgramCacheKey` is REQUIRED:
 * without a unique key three reuses the cached stock programme, silently dropping
 * the patch and producing pods that shift albedo but never glow.
 */
const EMISSIVE_PATCH_KEY = 'kubevision/instance-emissive/v3';

/** Name of the per-instance brightness attribute injected into the programme. */
const GLOW_ATTRIBUTE = 'instanceGlow';

function patchMaterialEmissive(material: MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    /* Vertex: forward the attribute to the fragment stage. Injected at the top of
       `main` so it runs before the stock `begin_vertex` include. */
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          `attribute float ${GLOW_ATTRIBUTE};`,
          'varying float vGlow;',
        ].join('\n'),
      )
      .replace('void main() {', 'void main() {\n\tvGlow = ' + GLOW_ATTRIBUTE + ';');

    /* Fragment: `emissive` already carries `emissiveIntensity` (pre-multiplied on
       the JS side), so the glow only has to supply the per-instance multiplier. */
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', ['#include <common>', 'varying float vGlow;'].join('\n'))
      .replace(
        'vec3 totalEmissiveRadiance = emissive;',
        [
          'vec3 totalEmissiveRadiance = emissive;',
          '#if defined( USE_COLOR )',
          '  totalEmissiveRadiance = vColor * vGlow;',
          '#endif',
        ].join('\n'),
      );
  };
  material.customProgramCacheKey = () => EMISSIVE_PATCH_KEY;
  material.needsUpdate = true;
}

/* ==========================================================================
   Slot runtime state
   ========================================================================== */

/**
 * Render-side state for one slot.
 *
 * A plain mutable object mutated in place by the frame loop. `podId` / `status`
 * are re-read from the transient pool every frame, so a rescheduled or healed pod
 * is picked up without a re-render. `color` and `emphasis` carry the eased values
 * so a status flip fades instead of snapping.
 */
interface SlotRuntime {
  podId: string | null;
  status: PodStatus | null;
  /** Eased 0..1 emphasis: 1 = full size, `FILTERED_OUT_SCALE` = demoted. */
  emphasis: number;
  /** Eased current colour. */
  color: Color;
  /** Eased scale envelope for the motion pulse (kept separate from emphasis). */
  pulseScale: number;
  /** Eased hover boost; grows to `HOVER_SCALE_BOOST` only for the hovered slot. */
  hover: number;
}

/* ==========================================================================
   Module-level frame scratch
   ========================================================================== */

/**
 * Slot -> pod resolution buffer type.
 *
 * PER COMPONENT INSTANCE, NOT MODULE-LEVEL
 * The frame loop would be safe with a shared buffer (R3F drives every `useFrame`
 * callback from one synchronous pass, so no rack can interleave a write with
 * another's read). POINTER HANDLERS ARE NOT: they fire outside the frame loop and
 * read whatever the LAST rack wrote, so hovering a cell on rack 0 would resolve to
 * a pod hosted on rack 2 and the tooltip would name a container from another node.
 * Each mesh therefore owns its buffer, allocated once in `useMemo`.
 */
type SlotPodBuffer = Array<PodEntityView | null>;

/** Minimal structural view of the mutable live pod we read on the frame path. */
interface PodEntityView {
  id: string;
  name: string;
  status: PodStatus;
  cpuUsage: number;
}

/* ==========================================================================
   Component
   ========================================================================== */

interface PodInstancedMeshProps {
  /** Rack whose 16 slots this mesh renders. */
  readonly rackIndex: RackIndex;
}

export function PodInstancedMesh({
  rackIndex,
}: PodInstancedMeshProps): ReactElement {
  const meshRef = useRef<InstancedMesh | null>(null);
  const materialRef = useRef<MeshStandardMaterial | null>(null);

  /**
   * Instance count is the SLOT CAPACITY, not the live pod count.
   *
   * A fixed buffer means a pod arriving or leaving never resizes the
   * `InstancedBufferAttribute`s - empty slots simply scale to zero. That keeps
   * the geometry stable for the mesh's lifetime, which is what preserves the
   * single draw call through scheduling churn.
   */
  const instanceCount = POD_SLOT_COUNT;

  /** Rounded, bevelled container geometry. Built once, disposed on unmount. */
  const geometry = useMemo(
    () =>
      new RoundedBoxGeometry(
        POD_CUBE_SIZE,
        POD_CUBE_SIZE,
        POD_CUBE_SIZE,
        /* segments */ 3,
        /* radius  */ POD_CUBE_SIZE * 0.18,
      ),
    [],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  /** Per-slot render state, allocated once. */
  const slots = useMemo<SlotRuntime[]>(
    () =>
      Array.from({ length: instanceCount }, () => ({
        podId: null,
        status: null,
        emphasis: FILTERED_OUT_SCALE,
        color: new ThreeColor().copy(STATUS_EMPTY_COLOR),
        pulseScale: 1,
        hover: 1,
      })),
    [instanceCount],
  );

  /**
   * This mesh's own slot -> pod resolution buffer.
   *
   * Must be per instance: pointer handlers read it OUTSIDE the frame loop, so a
   * shared buffer would hand rack 0 the pod list rack 2 wrote last frame.
   */
  const slotPods = useMemo<SlotPodBuffer>(
    () => new Array<PodEntityView | null>(instanceCount).fill(null),
    [instanceCount],
  );

  /* Preallocated frame scratch. Never allocated inside `useFrame`. */
  const tempObject = useMemo(() => new ThreeObject3D(), []);

  /** Local slot anchors, computed once: the grid never moves at runtime. */
  const slotPositions = useMemo(() => {
    const positions: Vector3[] = [];
    for (let slotIndex = 0; slotIndex < instanceCount; slotIndex += 1) {
      positions.push(writePodSlotLocal(slotIndex, new Vector3()));
    }
    return positions;
  }, [instanceCount]);

  /* Zero-sized slot anchor, reused when an index is unexpectedly missing. */
  const origin = useMemo(() => new Vector3(), []);

  /**
   * Per-instance glow attribute.
   *
   * Created once and attached to the mesh's geometry by `attachInstanceAttributes`.
   * `InstancedBufferAttribute` is resized only if the slot count changes, which it
   * never does at runtime - so this is a stable GPU buffer that the frame loop
   * mutates in place.
   */
  const glowAttribute = useMemo(
    () => new InstancedBufferAttribute(new Float32Array(instanceCount).fill(0), 1),
    [instanceCount],
  );

  /** Direct view of the glow buffer: written in place, no per-frame allocation. */
  const glowArray = glowAttribute.array as Float32Array;

  /* ------------------------------------------------------------------ hover */
  /**
   * Hovered slot index and its pod id.
   *
   * `hoveredSlot` is a ref because the frame loop reads it every frame and must
   * not depend on a re-render to see the change. The TOOLTIP, however, is DOM: it
   * only re-renders when the hovered pod CHANGES (an event, not a frame), so the
   * label is mounted exactly once per hover and its numbers are then updated
   * through refs at 4 Hz.
   */
  const hoveredSlotRef = useRef<number | null>(null);
  const [tooltipPodId, setTooltipPodId] = useState<string | null>(null);

  /** Which instance the cursor currently owns, so `pointerout` can be matched. */
  const pointerCursorSlotRef = useRef<number | null>(null);

  /* Tooltip DOM refs: written directly, never through React state. */
  const tooltipNameRef = useRef<HTMLSpanElement | null>(null);
  const tooltipStatusRef = useRef<HTMLSpanElement | null>(null);
  const tooltipCpuRef = useRef<HTMLSpanElement | null>(null);
  const tooltipBoxRef = useRef<HTMLDivElement | null>(null);
  const lastTooltipWriteRef = useRef<number>(0);

  /**
   * Scratch vector for the hover probe.
   *
   * The tooltip is positioned at the hovered slot's LOCAL anchor, so it follows
   * the cell without a per-frame matrix read. Preallocated because it is touched
   * inside the render path of an event handler that fires on every pointer move.
   */
  const hoverAnchor = useMemo(() => new Vector3(), []);

  /* Release the shared cursor if this mesh unmounts while still hovered: React
     never fires `pointerout` for a removed object. */
  useEffect(
    () => () => {
      if (pointerCursorSlotRef.current !== null) {
        releasePointerCursor();
        pointerCursorSlotRef.current = null;
      }
    },
    [],
  );

  /* ------------------------------------------------------------------ handlers */
  /**
   * Resolves the instance under the pointer to its pod.
   *
   * `e.instanceId` is three's index into the instance buffer, and it maps 1:1
   * onto `slotPods` because the buffer IS the slot array - the same indexing the
   * frame loop writes matrices with. Returning null for an empty slot is what
   * keeps the invisible cells from hovering: a slot with no pod has zero scale, so
   * it should not respond at all.
   */
  const resolvePodForInstance = useCallback(
    (instanceId: number | undefined): { slot: number; pod: PodEntityView } | null => {
      if (instanceId === undefined || instanceId < 0 || instanceId >= instanceCount) {
        return null;
      }
      const pod = slotPods[instanceId];
      if (pod === undefined || pod === null) {
        return null;
      }
      return { slot: instanceId, pod };
    },
    [instanceCount, slotPods],
  );

  const handlePointerMove = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      const resolved = resolvePodForInstance(event.instanceId);
      if (resolved === null) {
        return;
      }
      /* The pod is the front-most pickable object, so it must claim the event:
         without this the rack's pick box behind it also enters and both hover
         animations run at once. */
      event.stopPropagation();

      const alreadyHovered = hoveredSlotRef.current === resolved.slot;
      if (!alreadyHovered) {
        hoveredSlotRef.current = resolved.slot;
        setTooltipPodId(resolved.pod.id);
      }

      /* Cursor ownership is tracked per slot so a move from one cell to another on
         the SAME mesh does not double-acquire (three only fires `pointerout` for
         the previous instance when the instance actually changes). */
      if (pointerCursorSlotRef.current !== resolved.slot) {
        if (pointerCursorSlotRef.current === null) {
          acquirePointerCursor();
        }
        pointerCursorSlotRef.current = resolved.slot;
      }
    },
    [resolvePodForInstance],
  );

  const handlePointerOut = useCallback(() => {
    /* Any `pointerout` on this mesh means the pointer left the instance that was
       hovered - three reports the leaving instance in `event.instanceId`, but
       since returns null the bookkeeping is simpler and equivalent. */
    hoveredSlotRef.current = null;
    setTooltipPodId(null);
    if (pointerCursorSlotRef.current !== null) {
      releasePointerCursor();
      pointerCursorSlotRef.current = null;
    }
  }, []);

  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      const resolved = resolvePodForInstance(event.instanceId);
      if (resolved === null) {
        return;
      }
      /* Critical: stop the click reaching the rack pick box behind the pod, which
         would otherwise select the node right after selecting the container. */
      event.stopPropagation();

      const store = useClusterStore.getState();
      if (store.selectedEntityId === resolved.pod.id) {
        store.clearSelection();
        return;
      }
      store.selectEntity(resolved.pod.id, 'pod');
    },
    [resolvePodForInstance],
  );

  /* Patch the material once, after R3F has instantiated it. */
  useEffect(() => {
    const material = materialRef.current;
    if (material === null) {
      return;
    }
    patchMaterialEmissive(material);
  }, []);

  /* Attach the glow attribute to the geometry the mesh actually renders. */
  useEffect(() => {
    geometry.setAttribute(GLOW_ATTRIBUTE, glowAttribute);
    return () => {
      geometry.deleteAttribute(GLOW_ATTRIBUTE);
    };
  }, [geometry, glowAttribute]);

  /**
   * Publish the initial buffer state.
   *
   * `useFrame` first runs after the initial commit, so without this the pods would
   * pop from scale 0 on frame two. Writing `setColorAt` synchronously here also
   * guarantees `instanceColor` exists before the first render, which is what makes
   * three compile the programme with the instancing-colour define.
   */
  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) {
      return;
    }
    for (let slotIndex = 0; slotIndex < instanceCount; slotIndex += 1) {
      tempObject.position.copy(slotPositions[slotIndex] ?? origin);
      /* EMPTY_SLOT_SCALE, never 0: a zero-scale instance would collapse the mesh's
         bounding sphere and disable picking for every pod in this rack. */
      tempObject.scale.setScalar(EMPTY_SLOT_SCALE);
      tempObject.updateMatrix();
      mesh.setMatrixAt(slotIndex, tempObject.matrix);
      mesh.setColorAt(slotIndex, STATUS_EMPTY_COLOR);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) {
      mesh.instanceColor.needsUpdate = true;
    }
    /* Seed the bounding volume from the final slot matrices so the very first
       pointer event can hit, instead of waiting for three to lazily compute it
       from a buffer that is rewritten every frame. */
    mesh.computeBoundingSphere();
  }, [instanceCount, origin, slotPositions, tempObject]);

  /* --------------------------------------------------------------- frame loop */
  useFrame((state, delta) => {
    const mesh = meshRef.current;
    if (mesh === null) {
      return;
    }

    const dt = Math.min(Math.max(delta, 0), 0.1);
    const elapsed = state.clock.elapsedTime;

    /* The filter is React state, but reading it through `getState()` keeps it off
       the render path: changing the filter re-renders the toolbar, not the scene. */
    const filter: PodStatusFilter = useClusterStore.getState().statusFilter;
    const snapshot = getSnapshot();

    assignPodsToSlots(rackIndex, snapshot.nodes, snapshot.pods, slotPods);

    for (let slotIndex = 0; slotIndex < instanceCount; slotIndex += 1) {
      const runtime = slots[slotIndex];
      if (runtime === undefined) {
        continue;
      }
      const pod = slotPods[slotIndex] ?? null;

      /* ---------------- resolve targets ------------------------------- */
      let targetColor = STATUS_EMPTY_COLOR;
      let emphasisTarget = 1;
      let offsetX = 0;
      let offsetY = 0;
      let targetScale = 1;
      /* Emissive multiplier per status, folded into the instance colour below so
         each pod glows with its OWN hue at its own intensity. */
      let emissiveGain = 0;

      if (pod === null) {
        /* Empty slot: collapse to zero. The colour is left at the empty tone so a
           pod that leaves a slot fades out rather than flashing its old status. */
        emphasisTarget = FILTERED_OUT_SCALE;
        targetScale = 0;
        runtime.status = null;
        runtime.podId = null;
      } else {
        runtime.status = pod.status;
        runtime.podId = pod.id;
        const matchesFilter = matchesStatusFilter(pod.status, filter);
        emphasisTarget = matchesFilter ? 1 : FILTERED_OUT_SCALE;
        targetColor = statusColor(pod.status);

        const cpuSpan = Math.min(1, Math.max(0, pod.cpuUsage / 100));

        switch (pod.status) {
          case 'Running': {
            /* Gentle float, nudged by load: a hot container visibly breathes a
               little higher than an idle one. Amplitude stays tiny so 16 pods
               never read as a jittery swarm. */
            offsetY =
              Math.sin(elapsed * RUNNING_FLOAT_RATE + slotIndex * 0.7) *
              RUNNING_FLOAT_AMPLITUDE *
              (0.6 + cpuSpan * 0.8);
            emissiveGain = RUNNING_GLOW_MIN + cpuSpan * RUNNING_GLOW_SPAN;
            break;
          }
          case 'Pending': {
            /* Brightness only. A pending pod has no work to show; motion would
               imply progress that is not happening. */
            const wave =
              0.5 + 0.5 * Math.sin(elapsed * PENDING_PULSE_RATE + slotIndex * 1.1);
            emissiveGain =
              PENDING_PULSE_MIN + (PENDING_PULSE_MAX - PENDING_PULSE_MIN) * wave;
            break;
          }
          case 'CrashLoopBackOff':
          case 'OOMKilled':
          case 'Terminating': {
            /* The fault language: horizontal shake plus a fast size/glow pulse, so
               a broken container is findable in the wide overview even when hue is
               the only cue an operator can lean on. */
            const phase = slotIndex * 1.9;
            offsetX =
              Math.sin(elapsed * FAILED_SHAKE_RATE + phase) * FAILED_SHAKE_AMPLITUDE;
            offsetY =
              Math.cos(elapsed * FAILED_SHAKE_RATE * 0.5 + phase) *
              FAILED_SHAKE_AMPLITUDE *
              0.45;
            const beat = 0.5 + 0.5 * Math.sin(elapsed * FAILED_SCALE_RATE + phase);
            targetScale = 1 + (beat - 0.5) * 2 * FAILED_SCALE_SWING;
            emissiveGain =
              FAILED_GLOW_MIN + (FAILED_GLOW_MAX - FAILED_GLOW_MIN) * beat;
            break;
          }
          default: {
            /* `Running` is exhaustive above; anything unexpected renders as a
               calm emerald cell rather than disappearing. */
            emissiveGain = 0.6;
            break;
          }
        }
      }

      /* ---------------- ease the envelopes ---------------------------- */
      runtime.emphasis = ease(runtime.emphasis, emphasisTarget, EASE_LAMBDA, dt);
      runtime.pulseScale = ease(runtime.pulseScale, targetScale, EASE_LAMBDA, dt);
      /* Only the hovered slot boosts; every other slot eases back to 1. */
      const hoverTarget =
        hoveredSlotRef.current === slotIndex ? HOVER_SCALE_BOOST : 1;
      runtime.hover = ease(runtime.hover, hoverTarget, HOVER_LAMBDA, dt);
      /* `lerp` toward the target with a frame-rate independent factor. */
      const colorT = 1 - Math.exp(-EASE_LAMBDA * dt);
      runtime.color.lerp(targetColor, colorT);

      /* ---------------- compose the instance matrix ------------------- */
      const anchor = slotPositions[slotIndex] ?? origin;
      tempObject.position.set(
        anchor.x + offsetX,
        anchor.y + offsetY,
        anchor.z,
      );
      const scale = runtime.pulseScale * runtime.emphasis * runtime.hover;
      /* Never exactly 0: see EMPTY_SLOT_SCALE - a zero-scale instance poisons the
         mesh's bounding sphere and makes the whole rack unpickable. */
      const safeScale = Number.isFinite(scale) ? Math.max(EMPTY_SLOT_SCALE, scale) : EMPTY_SLOT_SCALE;
      tempObject.scale.setScalar(safeScale);
      tempObject.updateMatrix();
      mesh.setMatrixAt(slotIndex, tempObject.matrix);

      /* Colour carries the HUE only; brightness rides in `instanceGlow`. Keeping
         the two channels separate means dimming a pending pod's pulse never
         muddies its amber into brown. */
      mesh.setColorAt(slotIndex, runtime.color);
      /* Clamped so the emissive term can never clip a channel and shift the hue:
         see MAX_GLOW_GAIN. */
      glowArray[slotIndex] = Math.min(MAX_GLOW_GAIN, Math.max(0, emissiveGain));
    }

    mesh.instanceMatrix.needsUpdate = true;
    /* `instanceColor` is created lazily by the first `setColorAt`; guard it. */
    if (mesh.instanceColor !== null) {
      mesh.instanceColor.needsUpdate = true;
    }
    glowAttribute.needsUpdate = true;

    /* ---------------- hover tooltip text (throttled) ------------------ */
    /* The tooltip's NUMBERS are live, so they refresh here at 4 Hz. Only text and
       colour are touched - never React state - which keeps the 60 FPS budget. */
    const hoveredSlot = hoveredSlotRef.current;
    if (hoveredSlot !== null && tooltipPodId !== null) {
      const now = elapsed * 1000;
      if (now - lastTooltipWriteRef.current >= TOOLTIP_REFRESH_MS) {
        lastTooltipWriteRef.current = now;
        const pod = slotPods[hoveredSlot] ?? null;
        if (pod !== null) {
          const nameEl = tooltipNameRef.current;
          if (nameEl !== null) {
            nameEl.textContent = pod.name;
          }
          const statusEl = tooltipStatusRef.current;
          if (statusEl !== null) {
            statusEl.textContent = pod.status;
            statusEl.className = tooltipStatusClass(pod.status);
          }
          const cpuEl = tooltipCpuRef.current;
          if (cpuEl !== null) {
            cpuEl.textContent = `${pod.cpuUsage.toFixed(1)}%`;
          }
          const box = tooltipBoxRef.current;
          if (box !== null) {
            writeStatusStyle(pod.status, box);
          }
        }
      }

      /* Track the slot's live anchor so the label stays glued to the cell even
         while a failing pod shakes. */
      const anchor = slotPositions[hoveredSlot];
      if (anchor !== undefined) {
        hoverAnchor.copy(anchor);
        hoverAnchor.y += POD_CUBE_SIZE * 0.9;
      }
    }
  });

  return (
    <>
      <instancedMesh
        ref={meshRef}
        args={[geometry, undefined, instanceCount]}
        onPointerMove={handlePointerMove}
        onPointerOut={handlePointerOut}
        onClick={handleClick}
        /* The instance buffer is rewritten every frame and a failing pod shakes
           horizontally, so the stock bounding sphere would cull visible cells. */
        frustumCulled={false}
      >
        <meshStandardMaterial
          ref={materialRef}
          /* ALBEDO IS NEARLY BLACK ON PURPOSE.
             `instanceColor` feeds BOTH the albedo and (via the patch) the emissive
             term. A white base gave every channel a lit diffuse contribution on top
             of the glow, which clipped the bright ones and dragged emerald toward
             yellow-brown. Keeping the base black means the container's colour comes
             almost entirely from its own emissive hue - which is exactly the
             "self-luminous telemetry cell" look the palette calls for, and it keeps
             a rose pod red instead of pink. */
          color="#0a0f14"
          emissive="#ffffff"
          emissiveIntensity={1}
          roughness={0.5}
          metalness={0.08}
          toneMapped={false}
        />
      </instancedMesh>

      {/*
        HOVER TOOLTIP - one label, mounted only while hovering.
        Its position is driven by `hoverAnchor`, mutated in the frame loop, so the
        label follows the cell without a re-render. `pointerEvents="none"` is
        mandatory: a hit-testable DOM overlay above the canvas would swallow the
        very pointer moves that drive the hover, and the label would latch on
        forever.
      */}
      {tooltipPodId === null ? null : (
        <Html
          position={[hoverAnchor.x, hoverAnchor.y, hoverAnchor.z]}
          center
          distanceFactor={18}
          pointerEvents="none"
          wrapperClass={HTML_OVERLAY_WRAPPER_CLASS}
          zIndexRange={[40, 0]}
        >
          {/*
            `wrapperClass` + inline `pointerEvents` are load-bearing, not
            belt-and-braces: drei's non-`transform` Html drops the `pointerEvents`
            prop, so without them this tooltip is hit-testable. Mounted directly over
            the hovered cell, it would swallow the `pointermove` stream that keeps it
            alive - the label would latch on and never clear. See `htmlOverlay.ts`.
          */}
          <div
            ref={tooltipBoxRef}
            className="select-none whitespace-nowrap rounded border bg-slate-950/92 px-2 py-1 text-center backdrop-blur-md"
            style={{
              ...HTML_OVERLAY_CONTENT_STYLE,
              borderColor: '#22d3ee',
              color: '#22d3ee',
            }}
          >
            <span
              ref={tooltipNameRef}
              className="block font-mono text-[10px] uppercase tracking-[0.16em]"
            >
              pod
            </span>
            <span className="mt-0.5 flex items-center justify-center gap-1.5 font-mono text-[8px] tracking-wider text-slate-400">
              <span ref={tooltipStatusRef}>--</span>
              <span className="text-slate-700" aria-hidden>
                |
              </span>
              <span>
                cpu <span ref={tooltipCpuRef}>--</span>
              </span>
            </span>
          </div>
        </Html>
      )}
    </>
  );
}

/* ==========================================================================
   Helpers
   ========================================================================== */

/** Frame-rate independent exponential easing, allocation-free. */
function ease(current: number, target: number, lambda: number, dt: number): number {
  if (!Number.isFinite(dt) || dt <= 0) {
    return current;
  }
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

/** Status -> palette colour. Never allocates: the constants are singletons. */
function statusColor(status: PodStatus): Color {
  switch (status) {
    case 'Running':
      return STATUS_RUNNING_COLOR;
    case 'Pending':
      return STATUS_PENDING_COLOR;
    default:
      return STATUS_FAILED_COLOR;
  }
}

/**
 * Tailwind class for the tooltip's status word.
 *
 * Mirrors the 3D palette (emerald / amber / rose) so the DOM label and the glowing
 * cell can never tell different stories about the same pod.
 */
function tooltipStatusClass(status: PodStatus): string {
  const base = 'tracking-wider';
  switch (status) {
    case 'Running':
      return `text-emerald-400 ${base}`;
    case 'Pending':
      return `text-amber-400 ${base}`;
    default:
      return `text-rose-500 ${base}`;
  }
}

/**
 * Writes the tooltip border/text colour for a status.
 *
 * Inline styles rather than classes because the value is derived from live
 * telemetry, not from a static Tailwind token - computing a class string per
 * refresh would defeat Tailwind's static extraction.
 */
function writeStatusStyle(status: PodStatus, box: HTMLDivElement): void {
  const hex =
    status === 'Running'
      ? '#10b981'
      : status === 'Pending'
        ? '#f59e0b'
        : '#f43f5e';
  box.style.borderColor = hex;
  box.style.color = hex;
}

/**
 * Maps the pods of one rack's node onto its 16 slots.
 *
 * ORDERING IS A CONTRACT WITH THE CAMERA
 * `node.podIds` is the scheduling list and a pod's index in it IS its slot index.
 * `cameraFocus.resolveFocusPose` derives a pod's close-up pose from
 * `node.podIds.indexOf(pod.id)`, so both paths must agree or the camera would fly
 * to an empty cell. Do not reorder here.
 *
 * Writes `slotPods` in place; allocation-free.
 */
function assignPodsToSlots(
  rackIndex: RackIndex,
  nodes: readonly WorkerNodeEntity[],
  pods: readonly PodEntityView[],
  slotPods: SlotPodBuffer,
): void {
  for (let slotIndex = 0; slotIndex < POD_SLOT_COUNT; slotIndex += 1) {
    slotPods[slotIndex] = null;
  }

  for (const node of nodes) {
    if (node.rackIndex !== rackIndex) {
      continue;
    }
    const count = Math.min(node.podIds.length, POD_SLOT_COUNT);
    for (let slotIndex = 0; slotIndex < count; slotIndex += 1) {
      const podId = node.podIds[slotIndex];
      if (podId === undefined) {
        continue;
      }
      const pod = findPod(pods, podId);
      if (pod !== null) {
        slotPods[slotIndex] = pod;
      }
    }
  }
}

/**
 * Linear scan over the live pod list.
 *
 * Deliberately not a `Map`: 24 pods x 16 slots is 384 string comparisons per
 * frame per rack, which is far cheaper than rebuilding a `Map` every frame (and
 * the map would be a per-frame allocation, which rule 3 forbids).
 */
function findPod(
  pods: readonly PodEntityView[],
  podId: string,
): PodEntityView | null {
  for (const pod of pods) {
    if (pod.id === podId) {
      return pod;
    }
  }
  return null;
}

/* ==========================================================================
   Scene wrapper
   ========================================================================== */

/** Rack slots, mirroring the cluster contract. */
const RACK_SLOTS: readonly RackIndex[] = [0, 1, 2];

/**
 * Mounts one instanced pod field per rack.
 *
 * THE RACK TRANSFORM IS APPLIED HERE, NOT PER INSTANCE
 * `writePodSlotLocal` returns RACK-LOCAL coordinates. Without the rack's own
 * position and yaw the cells would all pile up around the cluster origin instead
 * of sitting on the shelves that `WorkerRack3D` draws - and every pointer hit
 * would resolve against empty space near the master. Matching the rack's
 * `position`/`rotation` here means the yaw is baked into the parent transform
 * once, and the frame loop keeps working in the simple local frame.
 *
 * Exported as a field (not three separate mounts) so `ClusterCanvas` keeps one
 * declarative child and the rack list has a single owner.
 */
export function PodInstancedField(): ReactElement {
  return (
    <group>
      {RACK_SLOTS.map((rackIndex) => (
        <PodRackSlot key={`pod-field-${rackIndex}`} rackIndex={rackIndex} />
      ))}
    </group>
  );
}

/**
 * One rack's pod field, placed on that rack's orbit slot.
 *
 * Split out of `PodInstancedField` so the `useMemo` transforms are per-component
 * (a hook cannot run inside the map above).
 */
function PodRackSlot({ rackIndex }: PodInstancedMeshProps): ReactElement {
  const placement = useMemo(
    () => writeRackOrigin(rackIndex, new Vector3()),
    [rackIndex],
  );
  const yaw = useMemo(() => rackFacingYaw(rackIndex), [rackIndex]);

  return (
    <group position={[placement.x, placement.y, placement.z]} rotation={[0, yaw, 0]}>
      <PodInstancedMesh rackIndex={rackIndex} />
    </group>
  );
}

export default PodInstancedMesh;