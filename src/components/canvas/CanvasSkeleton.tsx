'use client';

/**
 * KubeVision AI - WebGL boot skeleton.
 *
 * Rendered by `next/dynamic` while `ClusterCanvas` is being fetched and, once
 * loaded, for the handful of milliseconds the WebGL context takes to initialise.
 *
 * DESIGN CONSTRAINTS
 * - Zero dependency on `three`, the store or the telemetry pool: it renders on
 *   the server too (it is the `loading` fallback of a `ssr: false` import, so it
 *   is the ONLY markup the first HTML payload can contain for the viewport). Any
 *   seed-derived number here would risk a hydration mismatch.
 * - Deterministic markup: no `Math.random()`, no clocks. Every animation is pure
 *   CSS, so the skeleton paints before JS is even parsed.
 * - It mirrors the final composition (three rack columns under a floating
 *   beacon) so the swap to the real canvas is a fade, not a layout jump.
 */

import type { ReactElement } from 'react';

/** Three rack columns, mirroring the real topology's rack count. */
const RACK_COLUMNS: readonly number[] = [0, 1, 2];

/** Scan-line offsets, in ms, so the boot sweep staggers across columns. */
const RACK_DELAYS_MS: readonly number[] = [0, 180, 360];

export function CanvasSkeleton(): ReactElement {
  return (
    <div
      className="relative grid h-full w-full place-items-center overflow-hidden rounded-xl border border-slate-800 bg-slate-950"
      role="status"
      aria-live="polite"
      aria-label="Initialising 3D cluster topology renderer"
    >
      {/* Atmosphere: the same bloom + hairline grid the live canvas sits on. */}
      <div className="bg-void-bloom absolute inset-0" aria-hidden />
      <div className="kv-grid-overlay" aria-hidden />

      {/* Faux topology: three rack columns and a floating beacon. */}
      <div className="relative flex h-full w-full items-end justify-center gap-8 pb-24">
        {/* Control-plane beacon */}
        <div
          className="absolute top-10 left-1/2 -translate-x-1/2"
          aria-hidden
        >
          <div className="relative grid h-10 w-10 place-items-center">
            <span className="absolute inset-0 animate-ping rounded-full border border-emerald-400/40" />
            <span className="h-4 w-4 rotate-45 border border-emerald-400/80 bg-emerald-400/20 shadow-glow-emerald" />
          </div>
          <div className="mx-auto mt-3 h-px w-16 bg-gradient-to-r from-transparent via-emerald-400/50 to-transparent" />
        </div>

        {RACK_COLUMNS.map((column) => (
          <div key={column} className="flex flex-col items-center gap-2">
            {/* Rack chassis */}
            <div
              className="relative h-40 w-20 overflow-hidden rounded-md border border-cyan-500/30 bg-slate-900/70 shadow-glow-cyan"
              aria-hidden
            >
              {/* Vertical pod slots */}
              <div className="grid h-full grid-cols-3 gap-1 p-1.5">
                {Array.from({ length: 12 }, (_unused, slot) => (
                  <span
                    key={slot}
                    className="rounded-sm bg-cyan-400/15 animate-pulse-glow"
                    style={{
                      animationDelay: `${(RACK_DELAYS_MS[column] ?? 0) + slot * 40}ms`,
                    }}
                  />
                ))}
              </div>
              {/* Boot scan line */}
              <span className="kv-scan-line absolute inset-0" aria-hidden />
            </div>
            <span className="h-px w-24 bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent" />
          </div>
        ))}
      </div>

      {/* Status readout */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-center">
        <p className="font-mono text-[10px] uppercase tracking-ultra-wide text-cyan-400">
          initialising webgl topology
        </p>
        <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-slate-600">
          compiling shaders · seeding instanced mesh · calibrating orbit rig
        </p>
        <div className="mx-auto mt-2 h-px w-40 overflow-hidden bg-slate-800">
          <span className="block h-full w-1/3 animate-stream bg-gradient-to-r from-transparent via-cyan-400 to-transparent" />
        </div>
      </div>

      {/* Screen-reader-only narration; the visual above is decorative. */}
      <span className="sr-only">
        Loading the 3D cluster topology. The dashboard shell and terminal remain
        interactive while the renderer initialises.
      </span>
    </div>
  );
}

export default CanvasSkeleton;