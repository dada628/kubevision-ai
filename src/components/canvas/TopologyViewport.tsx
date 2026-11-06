'use client';

/**
 * KubeVision AI - topology viewport mount point.
 *
 * WHY THIS FILE EXISTS
 * `.cursorrules` rule 4 requires the root canvas to be imported through
 * `next/dynamic({ ssr: false })`. In the App Router `ssr: false` is only legal
 * inside a Client Component, so the dynamic boundary lives HERE and
 * `app/page.tsx` passes this component into the shell as `viewportSlot`. That
 * keeps `page.tsx` a Server Component (it still exports `metadata`) and keeps
 * `three` out of the RSC graph.
 *
 * LAYERING (bottom -> top)
 *   1. the lazily loaded WebGL canvas, absolutely filling the cell
 *   2. a pointer-transparent DOM overlay: legend, interaction hints, reset view,
 *      and the floating camera control bar (bottom-right)
 *
 * The overlay never wraps the canvas in a pointer-capturing element; only the
 * individual controls opt back into pointer events, so orbit/zoom reach the
 * canvas everywhere else.
 */

import dynamic from 'next/dynamic';
import { useCallback, type ReactElement } from 'react';
import { Maximize2 } from 'lucide-react';
import { cn } from '@/utils/cn';
import { NodeInspectHUD } from '@/components/hud/NodeInspectHUD';
import CanvasSkeleton from './CanvasSkeleton';
import CameraControls from './CameraControls';
import { requestPreset } from './cameraCommandBus';
import { useSelectedEntityId, useClusterStore } from '@/store/useClusterStore';

/**
 * The canvas is fetched only in the browser. `ssr: false` also guarantees the
 * `three` module graph is absent from the server bundle.
 *
 * No `loading` spinner flashes on fast connections because the skeleton is the
 * same visual language as the final scene: a swap, not a spinner.
 */
const ClusterCanvas = dynamic(() => import('./ClusterCanvas'), {
  ssr: false,
  loading: () => <CanvasSkeleton />,
});

/* ==========================================================================
   TopologyViewport
   ========================================================================== */

/**
 * 3D 集群拓扑视口。
 *
 * Interaction contract surfaced to the operator by the overlay:
 * - drag to orbit, wheel to dolly (clamped by the camera rig)
 * - click a rack or the beacon to trigger the cinematic close-up
 * - click the focused object again (or "reset view") to fly back to the overview
 * - use the floating bar (bottom-right) for presets and the patrol auto-rotation
 */
export function TopologyViewport(): ReactElement {
  const selectedEntityId = useSelectedEntityId();

  const handleReset = useCallback(() => {
    /* Same path as the toolbar's "全景鸟瞰" chip: one command channel, so the
       header button and the preset can never drift apart. It also clears any
       selection, which keeps the "overview / focused" badge truthful. */
    useClusterStore.getState().clearSelection();
    requestPreset('overview');
  }, []);

  return (
    <div className="relative min-h-0 w-full flex-1 overflow-hidden rounded-xl border border-slate-800 bg-slate-950/60">
      {/* -------------------------------------------------- WebGL scene layer */}
      <div className="absolute inset-0">
        <ClusterCanvas />
      </div>

      {/* --------------------------- inspection HUD (TL) --------------------- */}
      {/* The HUD owns the top-left corner: it shows the legend when nothing is
          selected and grows into the entity probe card when something is. */}
      <NodeInspectHUD />

      {/* --------------------------------------------------- controls (TR) */}
      {/* The wrapper is `pointer-events-none` so the gap between the badge and the
          button stays transparent to orbit gestures; only the button opts in. */}
      <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-1.5">
        <span
          className={cn(
            'rounded border px-1.5 py-1 font-mono text-[9px] uppercase tracking-widest backdrop-blur-md',
            selectedEntityId === null
              ? 'border-slate-800/80 bg-slate-900/70 text-slate-600'
              : 'border-cyan-500/40 bg-cyan-500/10 text-cyan-400',
          )}
        >
          {selectedEntityId === null ? 'overview' : 'focused'}
        </span>
        <button
          type="button"
          onClick={handleReset}
          title="Fly back to the overview framing"
          aria-label="Reset camera to the overview framing"
          className="pointer-events-auto flex items-center gap-1.5 rounded border border-slate-700 bg-slate-900/80 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-slate-400 backdrop-blur-md transition-colors duration-150 hover:border-cyan-500/50 hover:text-cyan-400"
        >
          <Maximize2 className="h-3 w-3" aria-hidden />
          reset view
        </button>
      </div>

      {/* ---------------------------------- camera control bar (bottom-right) */}
      {/* Same rule: the positioning box must not capture pointer events. Its only
          child is the toolbar, which opts back in itself. */}
      <div className="pointer-events-none absolute bottom-3 right-3">
        <CameraControls />
      </div>

      {/* Corner brackets: frames the scene like an ops console viewport. */}
      <span className="pointer-events-none absolute left-0 top-0 h-4 w-4 border-l border-t border-cyan-500/25" aria-hidden />
      <span className="pointer-events-none absolute right-0 top-0 h-4 w-4 border-r border-t border-cyan-500/25" aria-hidden />
      <span className="pointer-events-none absolute bottom-0 left-0 h-4 w-4 border-b border-l border-cyan-500/25" aria-hidden />
      <span className="pointer-events-none absolute bottom-0 right-0 h-4 w-4 border-b border-r border-cyan-500/25" aria-hidden />
    </div>
  );
}

export default TopologyViewport;