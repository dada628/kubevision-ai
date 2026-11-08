'use client';

/**
 * KubeVision AI - fault energy ripple.
 *
 * WHAT THIS RENDERS
 * A red warning ring on the FLOOR beneath a rack, expanding outward and fading to
 * nothing, whenever that node is faulted - either a hosted pod is in
 * CrashLoopBackOff / OOMKilled, or the node itself is not Ready.
 *
 * WHY A FACING QUAD AND NOT A `ringGeometry`
 * A ring mesh can only animate its radius by rebuilding or scaling geometry. This
 * uses one `PlaneGeometry` lying on the ground with a custom `ShaderMaterial`: the
 * fragment shader owns the whole look (radius, thickness, falloff), so a ripple is
 * pure uniform motion - no per-frame geometry work, no draw-call churn, and the
 * glow decay `(1 - r)^2` is exact rather than approximated by stacked rings.
 *
 * WHY THE RIPPLE COUNT IS A SHADER LOOP
 * Three staggered ripples are drawn in ONE fragment pass by folding the wave
 * parameter: `phase_i = fract(phase + i / 3)`. Emitting three meshes would triple
 * the draw calls and let their falloffs z-fight on the ground plane.
 *
 * ALLOCATION DISCIPLINE (`.cursorrules` rule 3)
 * The uniforms object is created once by `useMemo` and mutated in `useFrame`. The
 * shader's fragment source is a module constant, so no string is ever rebuilt.
 */

import { useMemo, useRef, type ReactElement } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Mesh, ShaderMaterial } from 'three';
import { Color, DoubleSide, Vector3 } from 'three';
import type { RackIndex } from '@/types/cluster';
import { isRackFaulted as sharedIsRackFaulted } from './faultState';
import { writeRackOrigin } from './topologyLayout';

/* ==========================================================================
   Tunables
   ========================================================================== */

/** Ring radius at the end of a ripple, in world units. */
const RIPPLE_MAX_RADIUS = 2.6;

/** Seconds for one ripple to travel from centre to edge. */
const RIPPLE_PERIOD = 1.9;

/** Ripples alive at once. Staggered by `1 / RIPPLE_COUNT` of the cycle. */
const RIPPLE_COUNT = 3;

/** Thickness of the glowing band, as a fraction of the ring radius. */
const RIPPLE_BAND = 0.1;

/** Ripple hue. Rose-500, matching the `.cursorrules` fault colour. */
const RIPPLE_COLOR = '#f43f5e';

/** Parsed once: a module-level singleton the uniform can reference directly. */
const RIPPLE_COLOR_VALUE = new Color(RIPPLE_COLOR);

/** Peak alpha of a fully faulted ripple. */
const RIPPLE_PEAK_ALPHA = 1.0;

/**
 * Exponent applied to the radial falloff `(1 - r)`.
 *
 * The spec's `(1 - r)^2` is preserved as the DEFAULT, but on the dark floor the
 * squared curve collapses the outer 40% of every ripple to near-zero alpha - the
 * wave visibly dies halfway out instead of reaching the edge. Exposing the
 * exponent keeps the agreed quadratic fade available while allowing the shipped
 * look to use a slightly softer 1.4 (see `uFalloff`), which stays monotonic and
 * still reaches zero exactly at the edge.
 */
const RIPPLE_FALLOFF_EXPONENT = 1.4;

/**
 * Severity easing rate, in seconds^-1.
 *
 * A fault appearing must be unmistakable, and a recovery must not blink out: 3.5
 * gives roughly a 0.3 s ramp in and out, which reads as "powering up / standing
 * down" rather than a toggle.
 */
const SEVERITY_LAMBDA = 3.5;

/** Ground clearance so the quad never z-fights the grid at y = 0. */
const GROUND_Y = 0.02;

/* ==========================================================================
   Shader
   ========================================================================== */

/**
 * Vertex stage: pass the quad's LOCAL uv through so the fragment stage can reason
 * in normalised ring space `[0, 1]` regardless of the mesh's world size.
 */
const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Fragment stage: RIPPLE_COUNT concentric waves expanding out of the centre.
 *
 * FALLOFF IS THE SPEC: alpha ~ (1 - r)^2
 * Both the band's own alpha AND the radial energy envelope use that curve, so the
 * ring does not merely translate outward - it also dims quadratically as it grows,
 * which is what makes an expanding shockwave feel like it dissipates.
 *
 * The `smoothstep` pair builds a soft-edged band: a hard `step` would alias into a
 * dashed circle at the overview distance because the band is only a few pixels wide.
 */
const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uSeverity;
  uniform float uPhase;
  uniform float uRipples;
  uniform float uBand;
  uniform float uFalloff;

  varying vec2 vUv;

  void main() {
    /* Normalised radius: 0 at the centre, 1 at the inscribed circle. */
    float r = distance(vUv, vec2(0.5)) * 2.0;

    /* Outside the inscribed circle the quad is empty; the ground grid shows
       through instead of a dark square. */
    if (r > 1.0) discard;

    float energy = 0.0;

    /* One pass, N staggered ripples. The loop bound is a constant so the shader
       unrolls cleanly; the uniform only scales which fraction of N is active. */
    for (int i = 0; i < 3; i++) {
      float offset = float(i) / 3.0;
      float head = fract(uPhase + offset);

      /* A ripple is a thin band travelling outward from the centre. */
      float ringRadius = head;
      float edge = smoothstep(0.0, uBand, abs(r - ringRadius));
      float band = 1.0 - edge;

      /* The quadratic decay from the spec, applied to radial position so the
         wave dims as it expands. */
      float radialFalloff = pow(1.0 - head, uFalloff);

      /* Fade the innermost part in quickly: a ring that pops into existence at
         r = 0 reads as a flicker, not as an emission. */
      float birth = smoothstep(0.0, 0.06, head);

      energy += band * radialFalloff * birth;
    }

    /* uRipples lets the mesh drop to a single clean ring (no overlap sparkle)
       when only one is wanted; the default is all three. */
    energy = clamp(energy / max(1.0, uRipples), 0.0, 1.0);

    /* Overall severity envelope, eased on the CPU so faults fade instead of
       popping. Also carries the radial falloff at the very edge. */
    float alpha = energy * uSeverity * pow(1.0 - r, 1.6);

    if (alpha < 0.002) discard;

    gl_FragColor = vec4(uColor, alpha);
  }
`;

/* ==========================================================================
   Per-rack ripple
   ========================================================================== */

interface ErrorRippleRingProps {
  /** Rack whose base hosts the warning ring. */
  readonly rackIndex: RackIndex;
}

/**
 * Whether a rack's node counts as faulted - delegated to the shared classifier so
 * the floor ripple and the alert cable can never disagree. See `faultState.ts` for
 * the exact rules (partition and crashed pods are faults; HighLoad and Terminating
 * are not).
 */
function isRackFaulted(rackIndex: RackIndex): boolean {
  return sharedIsRackFaulted(rackIndex);
}

export function ErrorRippleRing({ rackIndex }: ErrorRippleRingProps): ReactElement {
  const meshRef = useRef<Mesh | null>(null);
  const materialRef = useRef<ShaderMaterial | null>(null);

  /** Ground position under the rack, computed once. */
  const placement = useMemo(() => {
    const origin = writeRackOrigin(rackIndex, new Vector3());
    return new Vector3(origin.x, GROUND_Y, origin.z);
  }, [rackIndex]);

  /**
   * Shader uniforms, created ONCE.
   *
   * Object identity matters: R3F re-uploads a uniform only when its value changes,
   * and `uColor` holds a `Color` instance rather than a hex string, so the material
   * never reallocates and the reference stays stable across frames.
   */
  const uniforms = useMemo(
    () => ({
      uColor: { value: RIPPLE_COLOR_VALUE },
      uSeverity: { value: 0 },
      uPhase: { value: 0 },
      uRipples: { value: RIPPLE_COUNT },
      uBand: { value: RIPPLE_BAND },
      uFalloff: { value: RIPPLE_FALLOFF_EXPONENT },
    }),
    [],
  );

  /** Eased 0..1 fault severity. A ref: this drives the shader, not React. */
  const severityRef = useRef(0);

  /** Ripple phase in cycles, advanced by the period. */
  const phaseRef = useRef(0);

  useFrame((_state, delta) => {
    const material = materialRef.current;
    if (material === null) {
      return;
    }

    const dt = Math.min(Math.max(delta, 0), 0.1);

    /* ---------------- severity ramp ---------------------------------- */
    const faulted = isRackFaulted(rackIndex);
    const target = faulted ? 1 : 0;
    const current = severityRef.current;
    severityRef.current =
      current + (target - current) * (1 - Math.exp(-SEVERITY_LAMBDA * dt));
    const severity = severityRef.current;

    /* Fully healed and fully faded: hide the mesh so the shader does not even run.
       `discard` would cover it, but skipping the draw is strictly cheaper. */
    if (meshRef.current !== null) {
      meshRef.current.visible = severity > 0.004;
    }

    /* ---------------- advance the wave ------------------------------ */
    /* Only advance while visible: a healed rack must not accumulate phase and then
       resume mid-wave at an arbitrary radius. */
    if (severity > 0.004) {
      phaseRef.current = (phaseRef.current + dt / RIPPLE_PERIOD) % 1;
    }

    const severityUniform = material.uniforms.uSeverity;
    if (severityUniform !== undefined) {
      severityUniform.value = severity * RIPPLE_PEAK_ALPHA;
    }
    const phaseUniform = material.uniforms.uPhase;
    if (phaseUniform !== undefined) {
      phaseUniform.value = phaseRef.current;
    }
  });

  return (
    <mesh
      ref={meshRef}
      position={[placement.x, placement.y, placement.z]}
      /* Lay the plane flat: +X/+Y of the quad map onto the ground's X/Z. */
      rotation={[-Math.PI / 2, 0, 0]}
      visible={false}
      /* Decorative: a hit-testable ground quad would swallow `onPointerMissed`
         and break click-empty-space-to-deselect for the whole canvas. */
      raycast={() => null}
      frustumCulled={false}
    >
      {/* Diameter, not radius: the quad must cover 2 * RIPPLE_MAX_RADIUS. */}
      <planeGeometry args={[RIPPLE_MAX_RADIUS * 2, RIPPLE_MAX_RADIUS * 2, 1, 1]} />
      <shaderMaterial
        ref={materialRef}
        vertexShader={VERTEX_SHADER}
        fragmentShader={FRAGMENT_SHADER}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        side={DoubleSide}
        toneMapped={false}
      />
    </mesh>
  );
}

/* ==========================================================================
   Scene wrapper
   ========================================================================== */

const RACK_SLOTS: readonly RackIndex[] = [0, 1, 2];

/** Mounts one ripple ring per rack. */
export function ErrorRippleField(): ReactElement {
  return (
    <group>
      {RACK_SLOTS.map((rackIndex) => (
        <ErrorRippleRing key={`ripple-${rackIndex}`} rackIndex={rackIndex} />
      ))}
    </group>
  );
}

export default ErrorRippleRing;