/**
 * KubeVision AI - telemetry stream (Server-Sent Events).
 *
 * ROUTE: GET /api/telemetry?mode=demo|live&chaos=<ChaosScenario>
 *
 * WHAT THE CLIENT GETS
 * One `data: <snapshot JSON>` frame per second, where `<snapshot>` is a full
 * `TelemetrySnapshot` produced by `stepTelemetrySimulation`. The stream is the
 * SERVER's authority: the browser never runs the engine for a live session, it
 * just applies each frame to the transient pool.
 *
 * WHY `force-dynamic`
 * A route handler is statically evaluated at build time when Next can prove it
 * takes no request-dependent input. This one reads `request.url` and
 * `request.signal`, and it must never be pre-rendered: a cached response would
 * hand every client the same frozen frame and no stream at all.
 *
 * WHY A MANUAL `ReadableStream`
 * The leak this route has to be immune to is a timer outliving its response.
 * Next keeps a route module alive for the life of the server process, so a
 * `setInterval` that is not cleared keeps stepping the simulation and writing
 * into a dead stream forever - one timer and one retained snapshot graph per
 * closed browser tab.
 *
 * The defence is structural, not vigilant:
 *
 *   1. ONE `cleanup()` closure owns the timer and the controller, and it is
 *      idempotent - calling it twice is a no-op, so overlapping exit paths
 *      cannot double-close;
 *   2. every way a stream can end routes through it: the `abort` signal
 *      (normal client disconnect), a write failure, and `cancel()` (consumer
 *      cancellation);
 *   3. the frame-zero write happens synchronously in `start()`, so the client's
 *      `onopen` carries usable data instead of a blank second that reads as a
 *      hang.
 *
 * BACKPRESSURE
 * `controller.desiredSize <= 0` means the consumer's queue is full, i.e. it is
 * not reading. Enqueueing anyway would grow that queue without bound on a stalled
 * client. Skipping the frame is correct here: telemetry is a latest-value feed,
 * not a log, so a dropped intermediate frame costs nothing - the next tick
 * carries newer state.
 */

import {
  SIMULATION_TICK_MS,
  createSimulationSeed,
  stepTelemetrySimulation,
} from '@/utils/syntheticEngine';
import { isChaosScenario } from '@/types/cluster';
import type { ChaosScenario, TelemetrySnapshot } from '@/types/cluster';
import { isConnectionMode } from '@/types/store';
import type { ConnectionMode } from '@/types/store';

/** Never pre-render, never cache: this response is an open-ended stream. */
export const dynamic = 'force-dynamic';

/**
 * Node.js runtime, not Edge.
 *
 * The engine is a 1 Hz interval that runs for as long as a tab is open. Edge
 * workers cap wall-clock execution per request, so a long-lived stream there is
 * either cut off or billed as a permanently-running invocation; the Node runtime
 * keeps it as a plain timer on the server process.
 */
export const runtime = 'nodejs';

/**
 * Serverless 墙钟上限。到点后平台回收这条 SSE，浏览器里的
 * `EventSource` 失败会切到本地仿真，时间线由页面内引擎继续推进。
 */
export const maxDuration = 30;

/* ==========================================================================
   Response headers
   ========================================================================== */

/**
 * SSE headers.
 *
 * - `text/event-stream` is what makes `EventSource` parse the body at all.
 * - `no-cache, no-transform` stops intermediaries (and Next's own compression)
 *   from batching frames; without it a proxy can hold 30 s of 1 Hz frames and
 *   defeat the entire point of a live feed.
 * - `X-Accel-Buffering: no` is the nginx switch for the same problem, kept
 *   because this app is expected to sit behind an ingress.
 * - `keep-alive` holds the connection open through those intermediaries.
 */
const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/* ==========================================================================
   Query parsing
   ========================================================================== */

/** Everything a stream needs, resolved from the URL exactly once. */
interface StreamOptions {
  readonly mode: ConnectionMode;
  readonly chaos: ChaosScenario;
}

/**
 * Reads `?mode` and `?chaos`, falling back instead of failing.
 *
 * WHY LENIENT: an `EventSource` URL gets assembled by hand in several places (a
 * toolbar, a deep link, a manual curl) and a typo in an optional flag should not
 * take the live view down. Unknown values degrade to the documented defaults -
 * `demo` and `NONE` - and the response echoes what it actually used in
 * `X-Telemetry-Mode` / `X-Telemetry-Chaos`, so a misconfigured client is still
 * diagnosable from the network panel.
 */
function readStreamOptions(url: URL): StreamOptions {
  const modeParam = url.searchParams.get('mode');
  const chaosParam = url.searchParams.get('chaos');
  return {
    mode: isConnectionMode(modeParam) ? modeParam : 'demo',
    chaos: isChaosScenario(chaosParam) ? chaosParam : 'NONE',
  };
}

/* ==========================================================================
   Frame encoding
   ========================================================================== */

/**
 * Encodes one snapshot as an SSE frame.
 *
 * The blank line terminator is not cosmetic: without it the browser keeps the
 * `data:` line as an incomplete event and `onmessage` never fires. A single
 * `data:` line is safe even though the payload is multi-key JSON, because
 * `JSON.stringify` cannot emit a raw newline inside a string.
 */
function encodeFrame(snapshot: TelemetrySnapshot): string {
  return `data: ${JSON.stringify(snapshot)}\n\n`;
}

/* ==========================================================================
   Handler
   ========================================================================== */

export function GET(request: Request): Response {
  const url = new URL(request.url);
  const { mode, chaos } = readStreamOptions(url);

  /* Stamped from the wall clock at CONNECT time, so a tab opened an hour into a
     server's life starts with a fresh "last sync" rather than a boot timestamp. */
  const seed = createSimulationSeed(Date.now());
  const encoder = new TextEncoder();

  /** Held by the closure below; cleared by `cleanup`, which is the only writer. */
  let intervalId: ReturnType<typeof setInterval> | null = null;
  /** Set once by `cleanup`; makes every later call a no-op. */
  let closed = false;
  /** Assigned inside `start()`; the handler-scope teardown delegates to it. */
  let closeStream: () => void = () => {
    /* Before `start()` runs there is nothing to release: the stream cannot have
       produced a frame or a timer yet. */
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      /* The engine's state lives in THIS closure, not in a module singleton, so
         two concurrent clients advance two independent trajectories. */
      let latest = seed;

      /* Declared as a function so `push` and `tick` can refer to it above its
         definition without a temporal-dead-zone hazard. */
      function cleanup(): void {
        if (closed) {
          return;
        }
        closed = true;
        /* Timer FIRST, then the controller: closing the stream while the
           interval is still armed leaves a window in which the next tick writes
           into a closed controller. */
        if (intervalId !== null) {
          clearInterval(intervalId);
          intervalId = null;
        }
        try {
          controller.close();
        } catch {
          /* Already closed or errored: nothing left to release. */
        }
      }
      closeStream = cleanup;

      function push(snapshot: TelemetrySnapshot): void {
        if (closed) {
          return;
        }
        const expected = controller.desiredSize;
        if (expected !== null && expected <= 0) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(encodeFrame(snapshot)));
        } catch {
          /* The stream closed between the guard above and this write (an abort
             can land on another microtask). Treat it as a disconnect: letting the
             throw escape into the timer callback would surface as an unhandled
             server error. */
          cleanup();
        }
      }

      function tick(): void {
        if (closed) {
          return;
        }
        latest = stepTelemetrySimulation(latest, chaos);
        push(latest);
      }

      /* Frame zero, written before `start()` returns. */
      push(latest);
      intervalId = setInterval(tick, SIMULATION_TICK_MS);

      /* The one reliable disconnect signal on the Node runtime: it fires when the
         client navigates away, closes the tab, or the response is aborted. */
      request.signal.addEventListener('abort', cleanup, { once: true });
    },

    /**
     * Called by the runtime when the CONSUMER cancels. It must release the timer
     * for the same reason the abort listener exists: a cancelled stream whose
     * interval survives IS the leak this route exists to prevent.
     */
    cancel() {
      closeStream();
    },
  });

  return new Response(stream, {
    headers: {
      ...SSE_HEADERS,
      'X-Telemetry-Mode': mode,
      'X-Telemetry-Chaos': chaos,
    },
  });
}