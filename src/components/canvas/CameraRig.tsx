'use client';

/**
 * KubeVision AI - cinematic camera rig.
 *
 * RESPONSIBILITIES
 * 1. Own the single `OrbitControls` instance for the topology canvas and clamp
 *    the orbit so the operator can never dive under the ground plane
 *    (`maxPolarAngle = PI/2 - 0.05`) or lose the cluster in the distance
 *    (`maxDistance = 35`).
 * 2. Follow the operator's selection: when a worker rack, a pod or the control
 *    plane is selected, ease BOTH the orbit pivot (`controls.target`) and the
 *    camera position toward a pre-computed close-up pose.
 * 3. Serve the floating camera toolbar (`CameraControls`): fly to a named preset
 *    ("全景鸟瞰" / "俯视拓扑") and run the "环绕巡检" auto-rotation.
 *
 * WHY THE FLIGHT LIVES IN `useFrame`
 * Camera motion must be frame-rate independent and must NEVER trigger a React
 * render - a selection only happens on click, but the interpolation runs for
 * ~1 s afterwards, i.e. ~60 renders if it were driven by state. Per
 * `.cursorrules` rule 3 every scratch object here is preallocated in `useMemo`;
 * `useFrame` allocates nothing.
 *
 * INTERACTION CONTRACT
 * The flight is advisory, not authoritative: the moment the operator touches the
 * orbit controls (`onStart`), the automatic easing is cancelled so the camera
 * never fights the mouse. Auto-rotation is intentionally NOT cancelled by a
 * drag - the operator grabbed the camera mid-inspection and expects the slow
 * orbit to resume on release.
 *
 * FLIGHT vs AUTO-ROTATION
 * `OrbitControls.update()` (drei runs it at `useFrame` priority -1) rewrites
 * `camera.position` from its own spherical state every frame, and auto-rotation
 * mutates that state. If a flight wrote the position while auto-rotation was
 * live, the two would overwrite each other and the dolly would stutter. The rig
 * therefore suspends `controls.autoRotate` for the duration of a flight and
 * restores the operator's preference when the pose settles.
 */

import { useCallback, useEffect, useMemo, useRef, type ReactElement } from 'react';
import type { ComponentRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Vector3 } from 'three';
import type { EntityType } from '@/types/store';
import {
  useClusterStore,
  useSelectedEntityId,
  useSelectedEntityType,
} from '@/store/useClusterStore';
import { DEFAULT_DAMP_LAMBDA, damp, getSnapshot } from '@/store/useTelemetryRef';
import { resolveFocusPose } from './cameraFocus';
import {
  noteRigCameraMode,
  onAutoRotateChange,
  onCameraPreset,
  onRackFocusRequest,
} from './cameraCommandBus';
import {
  writeOverviewPose,
  writeRackFocusPose,
  writeTopPose,
} from './topologyLayout';

/* ==========================================================================
   Orbit limits & flight tuning
   ========================================================================== */

/** Overview framing shared with `Canvas`'s default camera (see `ClusterCanvas`). */
export const OVERVIEW_CAMERA_POSITION: readonly [number, number, number] = [
  0, 14, 22,
];

/** Hard floor: keep the camera above the horizon so it never sees the grid edge. */
export const MAX_POLAR_ANGLE = Math.PI / 2 - 0.05;

/**
 * Hard ceiling: prevents a top-down view that would flatten the racks to lines.
 *
 * MUST stay below the polar angle of `writeTopPose` (0.222 rad): the "俯视拓扑"
 * preset has to be reachable, or `controls.update()` clamps the camera back every
 * frame and the flight never settles.
 */
export const MIN_POLAR_ANGLE = 0.2;

/** Furthest the operator may dolly out, in world units. */
export const MAX_CAMERA_DISTANCE = 35;

/** Closest approach; just inside the pod close-up radius (3.57). */
export const MIN_CAMERA_DISTANCE = 2.6;

/**
 * Easing rate for the flight. Lower than `DEFAULT_DAMP_LAMBDA` (8) on purpose:
 * a snappier value reads as a teleport, while ~4 converges in roughly a second
 * and keeps the dolly feeling like a camera move instead of a cut.
 */
const FLIGHT_LAMBDA = 4.2;

/** Distance at which the flight is considered settled and snaps to the goal. */
const FLIGHT_SETTLE_EPSILON = 0.02;

/** Upper bound on the frame delta fed into the easing (tab-resume protection). */
const MAX_FRAME_DELTA_SECONDS = 0.1;

/**
 * "环绕巡检" speed, in OrbitControls' abstract units.
 *
 * OrbitControls advances `autoRotateSpeed * 6 deg/s`, so 0.9 is a full revolution
 * every ~67 s: slow enough to read the racks as they pass, fast enough to notice
 * the scene is alive.
 */
const PATROL_AUTO_ROTATE_SPEED = 0.9;

/**
 * Per-frame pose tolerance, in world units.
 *
 * A preset is reported as active only while the camera is genuinely parked on it.
 * 1.5 units is loose enough that `OrbitControls` damping settling within a few
 * centimetres never flickers the chip, and tight enough that a real dolly or drag
 * clears it immediately.
 */
const POSE_MATCH_EPSILON = 1.5;

/** Squared tolerance, precomputed so the frame loop never multiplies per axis. */
const POSE_MATCH_EPSILON_SQ = POSE_MATCH_EPSILON * POSE_MATCH_EPSILON;

/* ==========================================================================
   CameraRig
   ========================================================================== */

export function CameraRig(): ReactElement {
  const controls = useRef<ComponentRef<typeof OrbitControls> | null>(null);
  const camera = useThree((state) => state.camera);

  /* Discrete subscriptions only: these fire on click, never per frame. */
  const selectedEntityId = useSelectedEntityId();
  const selectedEntityType = useSelectedEntityType();
  const cameraFocusNonce = useClusterStore((state) => state.cameraFocusNonce);

  /**
   * All scratch vectors are allocated once for the component lifetime.
   * `useFrame` below only reads/writes them in place - no `new Vector3()`.
   */
  const scratch = useMemo(
    () => ({
      goalPosition: new Vector3(),
      goalTarget: new Vector3(),
    }),
    [],
  );

  const flyingRef = useRef<boolean>(false);
  /* Two scalar mirrors instead of one template-string key: building a key string
     every frame would allocate on the frame path, which rule 3 forbids. */
  const lastIdRef = useRef<string | null>(null);
  const lastTypeRef = useRef<EntityType | null>(null);
  const lastFocusNonceRef = useRef<number>(0);
  /** Distinguishes "never aimed" from "aimed at nothing / overview". */
  const hasAimedRef = useRef<boolean>(false);
  /** The operator's auto-rotation preference, separate from the live controls. */
  const autoRotateWantedRef = useRef<boolean>(false);

  /**
   * Reference poses for the two presets, allocated once.
   *
   * Comparing the LIVE camera against these every frame (see `noteModeForPose`)
   * is what keeps the toolbar honest: the chip is driven by where the camera
   * actually is, not by which button was clicked last. A drag, a wheel zoom or
   * an auto-rotation sweep all move the camera off the reference pose and the
   * highlight clears on its own - no event-ordering assumptions required.
   */
  const presetPoses = useMemo(
    () => ({
      overviewPosition: new Vector3(),
      overviewTarget: new Vector3(),
      topPosition: new Vector3(),
      topTarget: new Vector3(),
    }),
    [],
  );

  /* Fill the reference poses once. `topologyLayout` owns the numbers, so the
     rig never duplicates a coordinate. */
  useEffect(() => {
    writeOverviewPose(presetPoses.overviewPosition, presetPoses.overviewTarget);
    writeTopPose(presetPoses.topPosition, presetPoses.topTarget);
  }, [presetPoses]);

  /** Recomputes the goal pose for a selection and arms the flight. */
  const aimAtSelection = useCallback(
    (targetId: string | null, targetType: EntityType | null): void => {
      resolveFocusPose(
        targetId,
        targetType,
        getSnapshot(),
        scratch.goalPosition,
        scratch.goalTarget,
      );
      flyingRef.current = true;
    },
    [scratch],
  );

  /** True when the pose currently being eased is the overview framing. */
  const goalIsOverview = useCallback((): boolean => {
    const { goalPosition } = scratch;
    return (
      goalPosition.x === 0 &&
      goalPosition.y === OVERVIEW_CAMERA_POSITION[1] &&
      goalPosition.z === OVERVIEW_CAMERA_POSITION[2]
    );
  }, [scratch]);

  /* Initial pivot: the overview target, so the very first orbit drag rotates
     around the cluster centroid instead of around the world origin. */
  useEffect(() => {
    const instance = controls.current;
    if (instance === null) {
      return;
    }
    writeOverviewPose(scratch.goalPosition, scratch.goalTarget);
    instance.target.copy(scratch.goalTarget);
    flyingRef.current = false;
  }, [scratch]);

  /* Preset requests from the floating toolbar ("全景鸟瞰" / "俯视拓扑"). */
  useEffect(() => {
    return onCameraPreset((preset) => {
      if (preset === 'overview') {
        writeOverviewPose(scratch.goalPosition, scratch.goalTarget);
      } else {
        writeTopPose(scratch.goalPosition, scratch.goalTarget);
      }
      flyingRef.current = true;
    });
  }, [scratch]);

  /* "环绕巡检" toggle. Applied immediately, suspended while a flight is running. */
  useEffect(() => {
    return onAutoRotateChange((enabled) => {
      autoRotateWantedRef.current = enabled;
      const instance = controls.current;
      if (instance === null) {
        return;
      }
      /* A flight owns `camera.position` right now; leave the flag off and let the
         settle branch below turn it on so the dolly does not stutter. */
      instance.autoRotate = enabled && !flyingRef.current;
    });
  }, []);

  /**
   * Chaos drill: frame the rack that was just hit.
   *
   * This writes the GOAL only - it never touches the selection, so the drill does
   * not open the inspector card for a rack the operator did not click, and the
   * camera does not "un-select" anything on the way in. The pose comes from
   * `writeRackFocusPose`, the same function a rack click resolves to, so the
   * framing is identical whether the operator got there by clicking or by
   * injecting a fault.
   */
  useEffect(() => {
    return onRackFocusRequest((rackIndex) => {
      writeRackFocusPose(rackIndex, scratch.goalPosition, scratch.goalTarget);
      flyingRef.current = true;
    });
  }, [scratch]);

  /* Pointer / wheel input always wins over the automatic flight. */
  const handleControlStart = useCallback(() => {
    flyingRef.current = false;
  }, []);

  /**
   * Publishes the mode implied by the camera's ACTUAL (or target) pose.
   *
   * Deliberately derived from geometry instead of from the last clicked button:
   * - parked on the overview pose        -> `'overview'` (chip lit)
   * - parked on the top pose             -> `'top'` (chip lit)
   * - holding a selection close-up       -> `'entity'`
   * - anything else (dragged, zoomed, auto-rotating) -> `'manual'`
   *
   * While a flight is running the comparison is made against the flight GOAL, not
   * the in-between position. Judging the live position mid-flight would publish
   * `'manual'` on the first frame and make the chip flicker
   * "全景鸟瞰 -> 自由视角 -> 全景鸟瞰" on every preset click.
   *
   * Cost: a few `distanceToSquared` calls on preallocated vectors, no allocation.
   * `noteRigCameraMode` no-ops when the mode is unchanged, so this cannot cause a
   * render per frame.
   */
  const noteModeForPose = useCallback(
    (instance: ComponentRef<typeof OrbitControls>): void => {
      const { overviewPosition, overviewTarget, topPosition, topTarget } =
        presetPoses;

      if (flyingRef.current) {
        const { goalPosition, goalTarget } = scratch;
        if (
          goalPosition.distanceToSquared(overviewPosition) <
            POSE_MATCH_EPSILON_SQ &&
          goalTarget.distanceToSquared(overviewTarget) < POSE_MATCH_EPSILON_SQ
        ) {
          noteRigCameraMode('overview');
          return;
        }
        if (
          goalPosition.distanceToSquared(topPosition) < POSE_MATCH_EPSILON_SQ &&
          goalTarget.distanceToSquared(topTarget) < POSE_MATCH_EPSILON_SQ
        ) {
          noteRigCameraMode('top');
          return;
        }
        noteRigCameraMode(selectedEntityId === null ? 'manual' : 'entity');
        return;
      }

      const position = camera.position;
      const target = instance.target;
      if (
        position.distanceToSquared(overviewPosition) < POSE_MATCH_EPSILON_SQ &&
        target.distanceToSquared(overviewTarget) < POSE_MATCH_EPSILON_SQ
      ) {
        noteRigCameraMode('overview');
        return;
      }
      if (
        position.distanceToSquared(topPosition) < POSE_MATCH_EPSILON_SQ &&
        target.distanceToSquared(topTarget) < POSE_MATCH_EPSILON_SQ
      ) {
        noteRigCameraMode('top');
        return;
      }
      noteRigCameraMode(selectedEntityId === null ? 'manual' : 'entity');
    },
    [camera, presetPoses, scratch, selectedEntityId],
  );

  useFrame((_state, delta) => {
    /* Selection changed? Re-aim once, then keep easing every frame until the
       pose is reached. Two scalar refs, so this comparison allocates nothing. */
    if (
      !hasAimedRef.current ||
      lastIdRef.current !== selectedEntityId ||
      lastTypeRef.current !== selectedEntityType ||
      lastFocusNonceRef.current !== cameraFocusNonce
    ) {
      hasAimedRef.current = true;
      lastIdRef.current = selectedEntityId;
      lastTypeRef.current = selectedEntityType;
      lastFocusNonceRef.current = cameraFocusNonce;
      aimAtSelection(selectedEntityId, selectedEntityType);
    }

    const instance = controls.current;
    if (instance === null) {
      return;
    }

    /* Mirror the real pose into the toolbar. Runs every frame but only publishes
       on an actual mode change, so it is render-free while nothing moves. */
    noteModeForPose(instance);

    if (!flyingRef.current) {
      return;
    }

    const dt = Math.min(Math.max(delta, 0), MAX_FRAME_DELTA_SECONDS);
    const { goalPosition, goalTarget } = scratch;
    const position = camera.position;
    const target = instance.target;

    /* Auto-rotation would rewrite the position we are about to set. */
    instance.autoRotate = false;

    position.set(
      damp(position.x, goalPosition.x, FLIGHT_LAMBDA, dt),
      damp(position.y, goalPosition.y, FLIGHT_LAMBDA, dt),
      damp(position.z, goalPosition.z, FLIGHT_LAMBDA, dt),
    );
    target.set(
      damp(target.x, goalTarget.x, FLIGHT_LAMBDA, dt),
      damp(target.y, goalTarget.y, FLIGHT_LAMBDA, dt),
      damp(target.z, goalTarget.z, FLIGHT_LAMBDA, dt),
    );

    /* Exponential easing never exactly reaches its goal, so converge explicitly
       and stop burning cycles on sub-pixel motion. */
    if (
      position.distanceToSquared(goalPosition) <
        FLIGHT_SETTLE_EPSILON * FLIGHT_SETTLE_EPSILON &&
      target.distanceToSquared(goalTarget) <
        FLIGHT_SETTLE_EPSILON * FLIGHT_SETTLE_EPSILON
    ) {
      position.copy(goalPosition);
      target.copy(goalTarget);
      flyingRef.current = false;
      /* Hand the camera back to OrbitControls, restoring "环绕巡检" if the
         operator had it on before the flight started. */
      instance.autoRotate = autoRotateWantedRef.current;
    }
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.05}
      minPolarAngle={MIN_POLAR_ANGLE}
      maxPolarAngle={MAX_POLAR_ANGLE}
      minDistance={MIN_CAMERA_DISTANCE}
      maxDistance={MAX_CAMERA_DISTANCE}
      autoRotateSpeed={PATROL_AUTO_ROTATE_SPEED}
      onStart={handleControlStart}
      /* Panning is allowed but bounded: an unbounded pan can push the cluster
         off-screen with no visual way back except the reset control. */
      panSpeed={0.6}
      rotateSpeed={0.75}
      zoomSpeed={0.8}
    />
  );
}

/**
 * Kept for readability at call sites that tune the flight: the easing rate is
 * intentionally a fraction of the cartesian default.
 */
export const CAMERA_FLIGHT_LAMBDA = Math.min(FLIGHT_LAMBDA, DEFAULT_DAMP_LAMBDA);

export default CameraRig;