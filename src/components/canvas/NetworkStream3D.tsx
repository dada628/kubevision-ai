'use client';

/**
 * KubeVision AI - control-plane <-> kubelet traffic streams.
 *
 * WHAT THIS RENDERS
 * Three arched fibre cables, one per worker rack, leaving the master's core and
 * landing on the top of each chassis. Each cable carries 18 glowing packets whose
 * position along the curve is advanced every frame by the node's LIVE throughput.
 *
 * WHY A CUBIC BEZIER AND NOT A STRAIGHT BEAM
 * A straight line from the core to a rack top would pass straight through the
 * master's own wireframe shell and read as a debug overlay. Lifting the two
 * control points turns it into an arch that clears the shell, keeps the three
 * cables visually separated, and gives the packets a sense of travel.
 *
 * WHY `getPointAt` (ARC LENGTH) AND NOT `getPoint` (RAW PARAMETER)
 * `getPoint(t)` traverses the Bezier at non-uniform speed: the packets would
 * visibly bunch up near the control points and sprint through the apex. `getPointAt`
 * maps `u` onto equal arc lengths, so 18 evenly spaced `u` values really do render
 * 18 evenly spaced packets.
 *
 * ALLOCATION DISCIPLINE (`.cursorrules` rule 3)
 * `tempVec`, `tempObject` and `tempColor` are preallocated singletons. The frame
 * loop only writes matrices and instance colours; the curve's arc-length table is
 * built once by three on the first `getPointAt` call and cached thereafter, so
 * steady-state frames allocate nothing.
 *
 * PICKING
 * Purely decorative: `raycast={() => null}` on the particles and drei's Line is
 * never hit-tested, so the cables can never steal a click from the chassis or the
 * pods they pass in front of.
 */

import { useEffect, useMemo, useRef, type ReactElement } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import type { InstancedMesh } from 'three';
import {
  AdditiveBlending,
  Color,
  CubicBezierCurve3,
  Object3D,
  Vector3,
} from 'three';
import type { LineMaterial } from 'three-stdlib';
import type { RackIndex } from '@/types/cluster';
import {
  getNodeFloatIndex,
  getSnapshot,
  readNodeNetTarget,
} from '@/store/useTelemetryRef';
import { readRackFault } from './faultState';
import { sampleHealFlow } from './healFlowBus';
import {
  MASTER_POSITION,
  RACK_HEIGHT,
  writeRackOrigin,
} from './topologyLayout';

/* ==========================================================================
   Tunables
   ========================================================================== */

/** Packets per cable. 18 keeps a dense "flow" read without a particle system. */
const PACKETS_PER_CABLE = 18;

/** Rack slots the cables terminate on. */
const CABLES: readonly RackIndex[] = [0, 1, 2];

/**
 * Height of the arch apex above the taller endpoint, in world units.
 *
 * The master core sits at y = 2.5 and a rack top at y = 5.2, so the apex lands at
 * ~7.6: above both, low enough to stay inside the overview frustum and high enough
 * that the cable visibly clears the master's octahedron shell.
 */
const ARCH_LIFT = 2.4;

/**
 * Packet travel speed in `u` per second at 0% and 100% NIC utilization.
 *
 * The idle floor is non-zero so an unused link still shows a slow keep-alive
 * trickle instead of looking broken.
 */
const SPEED_IDLE = 0.045;
const SPEED_SATURATED = 0.34;

/**
 * Average speed of a FAULTED cable, as a fraction of its healthy speed.
 *
 * A partition drops throughput to zero, which would freeze the packets entirely -
 * and a frozen cable is indistinguishable from a broken renderer. Keeping a small
 * minimum crawl means the packet still moves (so the cable reads as "barely alive")
 * while the STUTTER is what tells the operator the link is damaged.
 */
const FAULT_SPEED_FACTOR = 0.34;

/* ==========================================================================
   Alert palette
   ========================================================================== */

/** Cable base geometry - healthy cyan. */
const CABLE_COLOR = '#22d3ee';

/** Cable base geometry - alert orange-red (rose-leaning for the dark backdrop). */
const CABLE_ALERT_COLOR = '#fb7185';

/** Parsed singletons: `lerpColors` writes INTO the material's own Color instance. */
const CABLE_HEALTHY_COLOR = new Color(CABLE_COLOR);
const CABLE_ALERT_COLOR_VALUE = new Color(CABLE_ALERT_COLOR);

/** Packet glow - healthy: cool cyan, ramping to white-hot when saturated. */
const PACKET_IDLE_COLOR = new Color('#22d3ee');
const PACKET_BUSY_COLOR = new Color('#a5f3fc');

/** Packet glow - faulted: amber-hot ember, ramping to pale warning orange. */
const PACKET_ALERT_COLOR = new Color('#f97316');
const PACKET_ALERT_BUSY_COLOR = new Color('#fecaca');

/** Packet glow while a heal surge is running: emerald, hot at the leading edge. */
const PACKET_HEAL_COLOR = new Color('#34d399');
const PACKET_HEAL_HOT_COLOR = new Color('#a7f3d0');
const CABLE_HEAL_COLOR = new Color('#34d399');

const CABLE_OPACITY = 0.22;

/**
 * Cable opacity when faulted.
 *
 * BRIGHTER, not dimmer: a damaged link must draw attention.
 */
const CABLE_ALERT_OPACITY = 0.62;

const CABLE_LINE_WIDTH = 1.4;

/** Packets are slightly larger while faulted so the warning reads at overview. */
const PACKET_ALERT_SIZE_BOOST = 1.35;

/**
 * Duration of one stutter cycle, in seconds.
 *
 * 0.62 s grouped with `STUTTER_DUTY` gives ~7 bursts per second alternating with
 * ~0.5 s stalls: fast enough to read as a glitch, slow enough that the eye can
 * actually see the packets freeze.
 */
const STUTTER_PERIOD = 0.62;

/**
 * Forward fraction of each stutter cycle. Outside this window the cable is FROZEN.
 *
 * WHY A DUTY CYCLE AND NOT A SLOWER SPEED
 * A uniformly slow cable reads as "underused". Damage reads as "intermittent":
 * a burst of packets, then a dead pause, then another burst. 0.22 means roughly
 * one fifth of the cycle carries motion and four fifths are stalled - enough to be
 * unmistakable at the overview distance while still showing the link is not dead.
 */
const STUTTER_DUTY = 0.22;

/** Depth of the brightness dropout during a stall, as a fraction of full colour. */
const STUTTER_DIM = 0.32;

/** Packet cube edge, in world units. */
const PACKET_SIZE = 0.1;

/**
 * Time constant for the eased throughput, in seconds^-1.
 *
 * The raw ratio is noisy tick to tick; easing it keeps the packets from stuttering
 * and makes a chaos-induced traffic collapse read as a smooth slowdown.
 */
const FLOW_LAMBDA = 2.6;

/**
 * Time constant for the eased severity (0 healthy -> 1 faulted), in seconds^-1.
 *
 * Slower than the flow ease on purpose: the colour must visibly SWEEP from cyan to
 * orange over ~0.4 s. An instant snap would read as a different cable appearing,
 * not as the same link degrading.
 */
const SEVERITY_LAMBDA = 3.4;

/* ==========================================================================
   Geometry helpers
   ========================================================================== */

/**
 * Builds the arch for one rack.
 *
 * @param rackIndex - which cable to build
 * @returns a curve from the master core to that rack's top surface
 */
function buildCableCurve(rackIndex: RackIndex): CubicBezierCurve3 {
  const rackTop = writeRackOrigin(rackIndex, new Vector3());
  rackTop.y = RACK_HEIGHT;

  const start = new Vector3(MASTER_POSITION.x, MASTER_POSITION.y, MASTER_POSITION.z);

  /* Control points are placed at 25% / 75% of the horizontal span so the arch is
     symmetric, then lifted to a common apex. Deriving the apex from the ENDPOINTS
     (not from a constant) keeps the cable clear of the chassis if the rack height
     ever changes. */
  const apexY = Math.max(start.y, rackTop.y) + ARCH_LIFT;
  const controlA = new Vector3(
    start.x + (rackTop.x - start.x) * 0.25,
    apexY,
    start.z + (rackTop.z - start.z) * 0.25,
  );
  const controlB = new Vector3(
    start.x + (rackTop.x - start.x) * 0.75,
    apexY,
    start.z + (rackTop.z - start.z) * 0.75,
  );

  return new CubicBezierCurve3(start, controlA, controlB, rackTop);
}

/**
 * Samples a curve into the flat point list drei's `Line` expects.
 *
 * 72 samples: enough that the low-poly arch never shows a visible kink at the
 * overview distance, while staying far below a per-frame tessellation.
 */
function sampleCable(curve: CubicBezierCurve3): Vector3[] {
  const SEGMENTS = 72;
  const points: Vector3[] = [];
  for (let index = 0; index <= SEGMENTS; index += 1) {
    points.push(curve.getPoint(index / SEGMENTS));
  }
  return points;
}

/* ==========================================================================
   Component
   ========================================================================== */

/** Non-pickable override: a decorative cable must never swallow a click. */
const NO_RAYCAST: () => null = () => null;

export function NetworkStream3D(): ReactElement {
  const meshRef = useRef<InstancedMesh | null>(null);

  /** One curve per cable, built once. The topology never moves. */
  const curves = useMemo(
    () => CABLES.map((rackIndex) => buildCableCurve(rackIndex)),
    [],
  );

  /** Flat point lists for drei's `Line`, one per cable. */
  const sampled = useMemo(() => curves.map((curve) => sampleCable(curve)), [curves]);

  const instanceCount = CABLES.length * PACKETS_PER_CABLE;

  /** Preallocated frame scratch - never constructed inside `useFrame`. */
  const tempObject = useMemo(() => new Object3D(), []);
  const tempVec = useMemo(() => new Vector3(), []);
  const tempColor = useMemo(() => new Color(), []);
  /** Second scratch colour: the alert ramp is built per packet, never allocated. */
  const alertColor = useMemo(() => new Color(), []);

  /** Per-cable eased utilization (0..1) and travel phase. */
  const phases = useMemo(() => new Float32Array(CABLES.length), []);
  const flows = useMemo(() => new Float32Array(CABLES.length), []);

  /** Per-cable eased severity (0 healthy -> 1 faulted). Drives the colour sweep. */
  const severities = useMemo(() => new Float32Array(CABLES.length), []);

  /**
   * Per-cable drei `Line` materials, captured so their colour/opacity can be
   * mutated in place.
   *
   * `LineMaterial` exposes `color` and `opacity` as accessor properties backed by
   * its own uniforms, so assigning to them updates the GPU directly - no React
   * re-render and no material replacement, which would recompile the shader.
   */
  const cableMaterialsRef = useRef<Array<LineMaterial | null>>(
    Array.from({ length: CABLES.length }, () => null),
  );

  /* Attach the colour buffer before the first paint so three compiles the
     instancing-colour variant of the material up front. */
  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) {
      return;
    }
    for (let index = 0; index < instanceCount; index += 1) {
      mesh.setColorAt(index, PACKET_IDLE_COLOR);
    }
    if (mesh.instanceColor !== null) {
      mesh.instanceColor.needsUpdate = true;
    }
  }, [instanceCount]);

  useFrame((state, delta) => {
    const mesh = meshRef.current;
    if (mesh === null) {
      return;
    }

    const dt = Math.min(Math.max(delta, 0), 0.1);
    const elapsed = state.clock.elapsedTime;
    const snapshot = getSnapshot();
    const heal = sampleHealFlow(dt);

    /* Whether the rack-specific network context has changed. */
    for (let cable = 0; cable < CABLES.length; cable += 1) {
      const rackIndex = CABLES[cable];
      if (rackIndex === undefined) {
        continue;
      }

      /* ---------------- fault classification --------------------------- */
      /* Shared with the floor ripple, so the two effects can never disagree about
         whether this rack is in trouble. */
      const fault = readRackFault(rackIndex);
      const faulted = fault !== 'none';

      /* ---------------- eased severity -------------------------------- */
      const previousSeverity = severities[cable] ?? 0;
      const severityTarget = faulted ? 1 : 0;
      const severity =
        previousSeverity +
        (severityTarget - previousSeverity) *
          (1 - Math.exp(-SEVERITY_LAMBDA * dt));
      severities[cable] = severity;

      /* ---------------- live throughput ratio -------------------------- */
      /* `nodeNetFloat32` holds the DERIVED throughput in Mbps; dividing by the
         node's provisioned NIC speed turns it into the 0..1 utilization that
         drives packet speed, so a 10 GbE node and a 25 GbE node look equally busy
         at the same saturation. */
      let utilization = 0;
      for (const node of snapshot.nodes) {
        if (node.rackIndex !== rackIndex) {
          continue;
        }
        const capacity = node.networkMbps;
        const floatIndex = getNodeFloatIndex(node.id);
        const throughput = floatIndex < 0 ? 0 : readNodeNetTarget(floatIndex);
        if (capacity > 0 && Number.isFinite(throughput)) {
          utilization = Math.min(1, Math.max(0, throughput / capacity));
        }
        break;
      }

      /* Ease the ratio so a chaos tick does not make the packets jump. */
      const currentFlow = flows[cable] ?? 0;
      const easedFlow =
        currentFlow + (utilization - currentFlow) * (1 - Math.exp(-FLOW_LAMBDA * dt));
      flows[cable] = easedFlow;

      /* ---------------- advance the travel phase ----------------------- */
      const healthySpeed = SPEED_IDLE + (SPEED_SATURATED - SPEED_IDLE) * easedFlow;
      /* A faulted cable mixes DOWN toward `FAULT_SPEED_FACTOR` of its healthy
         speed, and then advances only inside the stutter window. Blending the
         speed by severity keeps the transition smooth instead of snapping the
         packets to a new cadence the instant a pod crashes. */
      const faultSpeed =
        healthySpeed * (FAULT_SPEED_FACTOR + (1 - FAULT_SPEED_FACTOR) * (1 - severity));
      const healing = heal !== null && heal.rack === rackIndex;
      const healStrength = healing && heal !== null ? heal.strength : 0;

      /* Duty-cycle gate: `burst` is 1 while the cable is moving, 0 while stalled.
         `fract` gives a hard on/off, which is exactly the "卡顿" read we want - a
         smooth sine would look like a pulsing throttle, not a dropped link. */
      const stutterPhase = (elapsed / STUTTER_PERIOD) % 1;
      const inBurst = stutterPhase < STUTTER_DUTY;
      /* Blend the gate with severity so a healthy cable is never gated at all.
         A heal surge ignores the stall: the link has just been restored. */
      const burst = healStrength > 0 || severity <= 0.001 ? 1 : inBurst ? 1 : 1 - severity;

      const travelSpeed =
        healStrength > 0
          ? healthySpeed * (1 + 2.8 * healStrength)
          : faultSpeed * burst;
      let phase = (phases[cable] ?? 0) + travelSpeed * dt;
      /* `% 1` on a positive value: the phase is the only state that grows without
         bound, so wrapping it here keeps float precision intact for hours. */
      phase -= Math.floor(phase);
      phases[cable] = phase;

      /* ---------------- cable material (smooth colour sweep) ----------- */
      const material = cableMaterialsRef.current[cable];
      if (material !== null && material !== undefined) {
        /* `lerpColors` writes INTO the uniform's own Color instance, so the
           uniform reference stays stable and three uploads the new value without
           rebuilding the material. */
        material.color.lerpColors(
          CABLE_HEALTHY_COLOR,
          CABLE_ALERT_COLOR_VALUE,
          severity,
        );
        if (healStrength > 0) {
          material.color.lerp(CABLE_HEAL_COLOR, healStrength);
        }
        material.opacity =
          CABLE_OPACITY + (CABLE_ALERT_OPACITY - CABLE_OPACITY) * severity;
      }

      const curve = curves[cable];
      if (curve === undefined) {
        continue;
      }
      const baseIndex = cable * PACKETS_PER_CABLE;

      for (let packet = 0; packet < PACKETS_PER_CABLE; packet += 1) {
        const instance = baseIndex + packet;
        let u = phase + packet / PACKETS_PER_CABLE;
        u -= Math.floor(u);

        /* Arc-length sampling: the packet really sits at `u` of the cable. */
        curve.getPointAt(u, tempVec);

        /* A tiny per-packet breath keeps the stream from reading as a rigid
           conveyor belt. Amplitude is scaled down at high load so a saturated link
           looks fast and tight rather than jittery; a faulted link adds a nervous
           high-frequency jitter instead. */
        const calmBreath =
          1 + Math.sin(elapsed * 5 + packet * 1.7) * 0.18 * (1 - easedFlow);
        const nervousJitter =
          1 + Math.sin(elapsed * 34 + packet * 3.1) * 0.26 * severity;
        /* During a stall the packet ALSO shrinks, which is what sells "the flow
           stopped" more than a frozen position does. */
        const stallDim = 1 - (1 - STUTTER_DIM) * severity * (1 - burst);

        const scale =
          (calmBreath * nervousJitter * stallDim) *
          (1 + (PACKET_ALERT_SIZE_BOOST - 1) * severity) *
          (1 + 0.45 * healStrength);

        tempObject.position.copy(tempVec);
        tempObject.scale.setScalar(scale);
        tempObject.updateMatrix();
        mesh.setMatrixAt(instance, tempObject.matrix);

        /* Colour: lerp the whole healthy ramp toward the alert ramp by severity, so
           a degrading link passes through amber rather than jumping hue. */
        tempColor.copy(PACKET_IDLE_COLOR).lerp(PACKET_BUSY_COLOR, easedFlow);
        alertColor.copy(PACKET_ALERT_COLOR).lerp(PACKET_ALERT_BUSY_COLOR, easedFlow);
        tempColor.lerp(alertColor, severity);
        if (healStrength > 0) {
          alertColor.copy(PACKET_HEAL_COLOR).lerp(PACKET_HEAL_HOT_COLOR, easedFlow);
          tempColor.lerp(alertColor, healStrength);
        }

        /* Brightness falls off at the endpoints so packets appear to be emitted by
           the master and absorbed by the kubelet rather than popping in and out. */
        const edge = Math.sin(Math.PI * u);
        tempColor.multiplyScalar(0.45 + 0.55 * edge);
        /* Dim during a stall so the frozen stretch is visibly "dead", not merely
           motionless. */
        tempColor.multiplyScalar(1 - (1 - STUTTER_DIM) * severity * (1 - burst));
        mesh.setColorAt(instance, tempColor);
      }
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) {
      mesh.instanceColor.needsUpdate = true;
    }
  });

  return (
    <group>
      {/* -------------------------------------------------- base cables */}
      {sampled.map((points, index) => (
        <Line
          key={`cable-${index}`}
          points={points}
          color={CABLE_COLOR}
          lineWidth={CABLE_LINE_WIDTH}
          transparent
          opacity={CABLE_OPACITY}
          depthWrite={false}
          toneMapped={false}
          /* The frame loop drives colour / opacity / dash from the fault state.
             Capturing the material here is what lets that happen without a React
             re-render - and `LineMaterial` re-exposes `color` and `opacity` as
             accessors over its own uniforms, so in-place writes reach the GPU. */
          ref={(instance) => {
            const material = instance?.material;
            cableMaterialsRef.current[index] = material ?? null;
          }}
        />
      ))}

      {/* ----------------------------------------------- data packets --- */}
      <instancedMesh
        ref={meshRef}
        args={[undefined, undefined, instanceCount]}
        raycast={NO_RAYCAST}
        /* Positions are rewritten every frame along three arches, so any cached
           bounding volume would cull visible packets. */
        frustumCulled={false}
      >
        {/* Low-poly octahedron: reads as a spark at this size for 8 triangles. */}
        <octahedronGeometry args={[PACKET_SIZE, 0]} />
        <meshBasicMaterial
          color="#ffffff"
          transparent
          opacity={0.95}
          /* Additive blending is what sells "self-luminous packet" on a dark
             background: overlapping packets brighten instead of occluding. */
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </instancedMesh>
    </group>
  );
}

export default NetworkStream3D;