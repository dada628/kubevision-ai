'use client';

/**
 * KubeVision AI - live telemetry transport (SSE with an in-browser fallback).
 *
 * WHAT THIS HOOK OWNS
 * The single connection between the dashboard and a telemetry source. It is
 * mounted exactly once (in `DashboardShell`, alongside `useHudSync`), and it is
 * the ONLY writer of `telemetryTransientRef` on the client.
 *
 * TWO TRANSPORTS, ONE CONTRACT
 * 1. `sse`   - `EventSource` against `/api/telemetry`, the primary path. The
 *              SERVER owns the simulation, so every browser tab renders the same
 *              trajectory and the client bundle stays free of per-frame maths.
 * 2. `local` - a `setInterval` that calls `stepTelemetrySimulation` in the
 *              browser. This is the fallback for two very different situations:
 *              a static export / CDN deploy where no route handler exists at all,
 *              and a transient network failure during a demo.
 *
 * WHY THE FALLBACK EXISTS AT ALL
 * This project is demonstrated on machines that may be offline, behind a proxy
 * that strips `text/event-stream`, or served from a static export. In every one
 * of those cases an `EventSource` that fails is worse than useless: the canvas
 * freezes at the last frame and the "live cluster" reads as a dead screenshot.
 * Degrading to a local simulation keeps the 3D scene, the HUD and the sparklines
 * moving, which is the entire point of the screen.
 *
 * WHY DEGRADING IS ONE-WAY WITHIN A (mode, chaos) PAIR
 * `EventSource` retries on its own and fires `onerror` in a loop while the
 * endpoint is missing, which would produce an unbounded reconnect storm against a
 * static host. This hook therefore CLOSES the source on the first error and never
 * reopens it until the operator changes `connectionMode` or `activeChaos` - at
 * which point a fresh `EventSource` is attempted. Deterministic, no flapping, and
 * the demo never shows a gap.
 *
 * ZERO REACT RE-RENDERS ON THE HOT PATH
 * `connectionMode` and `activeChaos` are read through `useClusterStore.subscribe`
 * rather than selector hooks, so a chaos toggle does NOT re-render the entire
 * shell tree just to restart a transport. Frames mutate `telemetryTransientRef`
 * directly (the R3F frame loop eases toward those targets), and only the 1 Hz
 * summary commit touches React state.
 */

import { useEffect } from 'react';
import { useClusterStore } from '@/store/useClusterStore';
import { noteTelemetryArrival } from '@/store/renderBudget';
import { getSnapshot, writeSnapshot } from '@/store/useTelemetryRef';
import {
  SIMULATION_TICK_MS,
  createSimulationSeed,
  stepTelemetrySimulation,
} from '@/utils/syntheticEngine';
import type {
  AlertEvent,
  ChaosScenario,
  TelemetrySnapshot,
} from '@/types/cluster';
import type { ConnectionMode } from '@/types/store';

/* ==========================================================================
   Constants
   ========================================================================== */

/** Route the SSE transport connects to. Exported so a test can assert the URL. */
export const TELEMETRY_STREAM_PATH = '/api/telemetry';

/**
 * Maximum characters of an alert carried into a terminal line.
 *
 * The terminal is a 5-line-tall strip; an unbounded alert message would consume
 * the whole viewport for one line. Truncation is explicit (`...`) rather than a
 * silent cut so the operator knows there is more in the inspector.
 */
const MAX_ALERT_LOG_LENGTH = 160;

/**
 * How stale a snapshot may be before the local fallback re-seeds its clock.
 *
 * The fallback continues from whatever the live pool already holds, so a stream
 * that dies mid-demo resumes without a visual jump. But if the pool has never
 * received a frame (the static-export case), its timestamp is the frozen fixture
 * date - continuing from that would emit timestamps days in the past and the HUD
 * would show a stale "last sync" forever. Anything older than a few ticks
 * therefore re-seeds from the wall clock instead.
 */
const STALE_RESUME_TICKS = 5;

/* ==========================================================================
   Frame parsing
   ========================================================================== */

/** Narrowing helper for `JSON.parse` output. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parses one SSE `data:` payload into a snapshot, or null when it is not one.
 *
 * WHY THE STRUCTURAL CHECK
 * A 404 from a static host, a proxy error page or an HTML login redirect can all
 * be delivered as a "successful" event with a body that is not JSON at all.
 * `JSON.parse` catches the first case; the shape checks catch the second (a JSON
 * error envelope would otherwise reach `writeSnapshot` and blank the canvas).
 *
 * This is the ONE trust boundary for server data on the client, which is why the
 * final cast is acceptable: everything the renderer needs has been verified to be
 * the right *kind*, and a field that is individually malformed (say a NaN CPU)
 * is clamped downstream by `writeSnapshot` -> `clampPercentage`.
 */
export function parseTelemetryFrame(raw: string): TelemetrySnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const {
    timestamp,
    clusterHealthScore,
    totalQps,
    master,
    nodes,
    pods,
    activeAlerts,
  } = parsed;
  if (typeof timestamp !== 'string' || timestamp.length === 0) {
    return null;
  }
  if (typeof clusterHealthScore !== 'number' || !Number.isFinite(clusterHealthScore)) {
    return null;
  }
  if (typeof totalQps !== 'number' || !Number.isFinite(totalQps)) {
    return null;
  }
  if (!isRecord(master)) {
    return null;
  }
  if (!Array.isArray(nodes) || !Array.isArray(pods) || !Array.isArray(activeAlerts)) {
    return null;
  }
  return parsed as unknown as TelemetrySnapshot;
}

/* ==========================================================================
   Alert -> terminal line
   ========================================================================== */

/**
 * `HH:MM:SS` in the operator's local time, matching `parseTerminalLogLine`.
 *
 * @param isoTimestamp - the alert's own timestamp, normally ISO-8601
 * @param fallbackMs   - ingest time, used when the server timestamp is unusable
 *
 * WHY THERE IS A FALLBACK AT ALL
 * `parseTerminalLogLine` anchors on `^\[(\d{2}:\d{2}:\d{2})\]`. A literal
 * `[--:--:--]` therefore fails to match the WHOLE line, and the fix for a
 * missing timestamp would silently cost the line its channel - i.e. a P0 alert
 * would render in neutral grey exactly when colour matters most. Stamping the
 * arrival time is what log collectors (Fluent Bit, Filebeat) do for the same
 * reason: an ingest timestamp is a defensible fact, whereas an unparseable one
 * destroys the record. The clip is never silent - the message still carries the
 * original value.
 */
function clockLabel(isoTimestamp: string, fallbackMs: number): string {
  const parsed = Date.parse(isoTimestamp);
  const ms = Number.isFinite(parsed) ? parsed : fallbackMs;
  const instant = new Date(ms);
  const hh = String(instant.getHours()).padStart(2, '0');
  const mm = String(instant.getMinutes()).padStart(2, '0');
  const ss = String(instant.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Channel tag for an alert line.
 *
 * `ERR` renders rose and `WARN` amber in the terminal (see
 * `TERMINAL_LOG_CHANNEL_TONE`), which is the same severity language the 3D scene
 * uses. P1/P2 share `WARN` deliberately: the palette has one warning tone, and
 * inventing a second amber would make the two indistinguishable anyway.
 *
 * A `switch` with a `default` rather than a `Record` lookup, because the severity
 * arrives from the network and may not be one of the three known values.
 */
function alertChannel(severity: AlertEvent['severity']): string {
  switch (severity) {
    case 'P0':
      return 'ERR';
    case 'P1':
    case 'P2':
      return 'WARN';
    default:
      return 'WARN';
  }
}

/**
 * Formats an alert as a terminal line.
 *
 * Wire format matches the store's own (`[HH:MM:SS] [CHANNEL] message`), so
 * `parseTerminalLogLine` colours it without any special case. The entity is
 * always named explicitly: "OOMKilled" without a pod is useless when eight
 * containers are on the rack.
 */
export function formatAlertLogLine(alert: AlertEvent, ingestMs: number): string {
  const subject =
    alert.sourceType === 'cluster'
      ? 'cluster'
      : `${alert.sourceType}/${alert.sourceId}`;
  const body = `${alert.severity} ${subject}: ${alert.title} - ${alert.message}`;
  const message =
    body.length <= MAX_ALERT_LOG_LENGTH
      ? body
      : `${body.slice(0, MAX_ALERT_LOG_LENGTH - 3)}...`;
  return `[${clockLabel(alert.timestamp, ingestMs)}] [${alertChannel(alert.severity)}] ${message}`;
}

/* ==========================================================================
   Hook
   ========================================================================== */

/** Handle a transport returns so the coordinator can swap it out. */
interface TransportHandle {
  readonly dispose: () => void;
}

/**
 * Starts the live telemetry pipeline.
 *
 * Mount ONCE, at the top of the client tree. Mounting twice would open two
 * `EventSource`s and run two local timers, each advancing its own copy of the
 * simulation - the pool would end up interleaving two timelines.
 */
export function useTelemetryStream(): void {
  useEffect(() => {
    /* The effect body only ever runs in the browser, but the guard documents the
       contract and keeps the hook safe if it is ever rendered on a server. */
    if (typeof window === 'undefined') {
      return;
    }

    let disposed = false;
    let active: TransportHandle | null = null;
    /** True while the local timer is the active transport. */
    let localActive = false;

    const initialState = useClusterStore.getState();
    let currentMode: ConnectionMode = initialState.connectionMode;
    let currentChaos: ChaosScenario = initialState.activeChaos;

    /**
     * Alert ids already written to the terminal.
     *
     * Seeded on the FIRST frame without announcing, so the four alerts the
     * fixture ships with (which the boot log already mentions) do not appear a
     * second time the instant the stream connects. A resolved alert is removed
     * from the set, so if the same incident re-opens it is announced again -
     * one line per state transition, never one line per frame.
     */
    const announcedAlertIds = new Set<string>();
    let primed = false;

    const disposeActive = (): void => {
      if (active !== null) {
        active.dispose();
        active = null;
      }
    };

    /**
     * Commits one frame: pool first, then the throttled React summary.
     *
     * ORDER MATTERS. `writeSnapshot` republishes the Float32 targets that the R3F
     * loop reads next frame, and `syncSummary` reads the pool to build the HUD
     * summary. Syncing first would publish a summary describing the PREVIOUS
     * frame, so the HUD would be permanently one second behind the 3D scene.
     */
    const applyFrame = (
      snapshot: TelemetrySnapshot,
      transport: 'sse' | 'local',
    ): void => {
      if (disposed) {
        return;
      }
      noteTelemetryArrival(snapshot.timestamp, transport);
      writeSnapshot(snapshot);

      const lines: string[] = [];
      const ingestMs = Date.now();
      for (const alert of snapshot.activeAlerts) {
        if (alert.resolved) {
          /* Allow a re-open of this incident to be announced again. */
          announcedAlertIds.delete(alert.id);
          continue;
        }
        if (announcedAlertIds.has(alert.id)) {
          continue;
        }
        announcedAlertIds.add(alert.id);
        if (primed) {
          lines.push(formatAlertLogLine(alert, ingestMs));
        }
      }
      primed = true;

      const store = useClusterStore.getState();
      if (lines.length > 0) {
        store.appendTerminalLogs(lines);
      }
      /* `force`: the frame itself is the throttle (1 Hz). Leaving it at the
         default 1 s gate would drop roughly every other frame to jitter. */
      store.syncSummary(performance.now(), true);
    };

    /**
     * Snapshot the local transport should continue from.
     *
     * Continuing from the live pool is what makes a mid-demo degradation
     * invisible: the pods keep their current statuses and the only change is who
     * computes the next tick.
     */
    const resumeBase = (): TelemetrySnapshot => {
      const live = getSnapshot();
      const parsed = Date.parse(live.timestamp);
      const stale =
        !Number.isFinite(parsed) ||
        Math.abs(Date.now() - parsed) > SIMULATION_TICK_MS * STALE_RESUME_TICKS;
      return stale ? createSimulationSeed(Date.now()) : live;
    };

    /**
     * Switches to the in-browser simulation.
     *
     * Idempotent: the `localActive` guard means a burst of `onerror` events can
     * only start ONE timer.
     */
    const startLocal = (reason: string): void => {
      if (disposed || localActive) {
        return;
      }
      disposeActive();
      localActive = true;

      const degradedAt = Date.now();
      useClusterStore.getState().appendTerminalLog(
        `[${clockLabel(new Date(degradedAt).toISOString(), degradedAt)}] [WARN] telemetry stream unavailable (${reason}) - degraded to in-browser simulation`,
      );

      let base = resumeBase();
      /* A closure over `base` rather than a module variable: two mounted hooks
         (which should not happen) would then each advance their own timeline
         instead of corrupting a shared one. */
      const tick = (): void => {
        if (disposed) {
          return;
        }
        base = stepTelemetrySimulation(base, currentChaos);
        applyFrame(base, 'local');
      };

      /* Immediate first tick: waiting a full second would leave the canvas on a
         frozen frame right when the operator noticed the stream drop. */
      tick();
      const handle = window.setInterval(tick, SIMULATION_TICK_MS);
      active = {
        dispose: () => {
          window.clearInterval(handle);
        },
      };
    };

    /** Opens the primary transport, falling back on the first failure. */
    const startSse = (): void => {
      disposeActive();
      localActive = false;
      if (disposed) {
        return;
      }

      if (typeof EventSource === 'undefined') {
        startLocal('EventSource unsupported');
        return;
      }

      const url = `${TELEMETRY_STREAM_PATH}?mode=${currentMode}&chaos=${currentChaos}`;
      let source: EventSource;
      try {
        source = new EventSource(url);
      } catch {
        /* A malformed URL or a browser policy block. Same treatment. */
        startLocal('EventSource rejected the connection');
        return;
      }

      active = { dispose: () => source.close() };

      source.onmessage = (event: MessageEvent<string>) => {
        if (disposed) {
          return;
        }
        const snapshot = parseTelemetryFrame(event.data);
        /* A malformed frame is NOT proof the transport is dead (a proxy can inject
           one comment/heartbeat line), so it is dropped rather than triggering a
           downgrade the operator did not need. */
        if (snapshot === null) {
          return;
        }
        applyFrame(snapshot, 'sse');
      };

      source.onerror = () => {
        if (disposed) {
          return;
        }
        /* Close BEFORE delegating: an open EventSource keeps retrying in the
           background, which on a static host means a request per second forever. */
        source.close();
        startLocal('stream error');
      };
    };

    /* ------------------------------------------------------------- lifecycle */
    startSse();

    /* Restart only when the URL actually changes. `subscribe` fires on every store
       write (including log appends), so the comparison must be two primitive
       checks and nothing more. */
    const unsubscribe = useClusterStore.subscribe((next) => {
      if (
        next.connectionMode === currentMode &&
        next.activeChaos === currentChaos
      ) {
        return;
      }
      currentMode = next.connectionMode;
      currentChaos = next.activeChaos;
      /* A deliberate operator change re-arms the primary transport, so leaving
         the fallback is possible without a page reload. */
      startSse();
    });

    return () => {
      disposed = true;
      unsubscribe();
      disposeActive();
    };
  }, []);
}

export default useTelemetryStream;