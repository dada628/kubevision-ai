'use client';

/**
 * KubeVision AI - floating camera control bar.
 *
 * POSITION & STACKING
 * Bottom-right of the 3D viewport, above the WebGL layer. `pointer-events-auto`
 * is scoped to the bar itself: the surrounding overlay never captures pointer
 * events, so orbit / zoom still reach the canvas everywhere around it.
 *
 * WHY `useSyncExternalStore` AND NOT ZUSTAND
 * Camera framing is a VIEWPORT concern that only exists while the WebGL canvas is
 * mounted. Parking it in `useClusterStore` would put a lens position next to
 * cluster telemetry, and every button press would re-render every HUD consumer.
 * The bus in `cameraCommandBus` is already the subscription the rig uses; the
 * toolbar subscribes to the same snapshot, so the two can never disagree.
 *
 * WHY THE BUTTONS DISPATCH EVEN WHEN ALREADY ACTIVE
 * "全景鸟瞰" doubles as "bring me back": after orbiting by hand the mode reads
 * `'manual'`, but even in the `'overview'` state a click must re-fly the camera
 * (the operator may have dollied in and want the exact framing restored). The
 * dispatch is therefore unconditional; only the HIGHLIGHT is state-driven.
 */

import { useCallback, useSyncExternalStore, type ReactElement } from 'react';
import { Earth, Pause, Play, ScanEye } from 'lucide-react';
import { cn } from '@/utils/cn';
import {
  getCameraControlSnapshot,
  getServerCameraControlSnapshot,
  requestPreset,
  setAutoRotate,
  subscribeCameraControls,
  type CameraFocusMode,
  type CameraPreset,
} from './cameraCommandBus';

/* ==========================================================================
   Button definitions
   ========================================================================== */

interface PresetButton {
  readonly preset: CameraPreset;
  readonly label: string;
  readonly hint: string;
  readonly icon: ReactElement;
}

/**
 * `ScanEye` rather than a grid glyph for the top view: at 14px a grid reads as a
 * UI affordance, while an eye reading a plane is unambiguous.
 */
const PRESET_BUTTONS: readonly PresetButton[] = [
  {
    preset: 'overview',
    label: '全景鸟瞰',
    hint: '全景鸟瞰 · 回到整簇俯视角 [0, 14, 22]',
    icon: <Earth className="h-3.5 w-3.5" aria-hidden />,
  },
  {
    preset: 'top',
    label: '俯视拓扑',
    hint: '俯视拓扑 · 垂直俯瞰网格与机架排布',
    icon: <ScanEye className="h-3.5 w-3.5" aria-hidden />,
  },
];

/** Human readout of what the camera is currently doing. */
const MODE_LABEL: Readonly<Record<CameraFocusMode, string>> = {
  overview: '全景鸟瞰',
  top: '俯视拓扑',
  entity: '特写聚焦',
  manual: '自由视角',
};

/* ==========================================================================
   Component
   ========================================================================== */

export function CameraControls(): ReactElement {
  const { mode, autoRotate } = useSyncExternalStore(
    subscribeCameraControls,
    getCameraControlSnapshot,
    getServerCameraControlSnapshot,
  );

  const handlePreset = useCallback((preset: CameraPreset) => {
    requestPreset(preset);
  }, []);

  const handleTogglePatrol = useCallback(() => {
    setAutoRotate(!getCameraControlSnapshot().autoRotate);
  }, []);

  return (
    <div
      className={cn(
        'pointer-events-auto flex items-center gap-1 rounded-lg border p-1',
        'border-slate-800/80 bg-slate-900/60 backdrop-blur-md',
        'shadow-panel transition-colors duration-300',
        autoRotate && 'border-cyan-500/40',
      )}
      role="toolbar"
      aria-label="Camera controls"
      aria-orientation="horizontal"
    >
      {/* ---------------------------------------------------- mode readout */}
      <span
        className={cn(
          'pointer-events-none flex items-center gap-1.5 rounded px-1.5 py-1',
          'font-mono text-[9px] uppercase tracking-widest',
          mode === 'manual' ? 'text-slate-500' : 'text-cyan-400',
        )}
        aria-live="polite"
      >
        <span
          className={cn(
            'h-1 w-1 rounded-full',
            mode === 'manual' ? 'bg-slate-600' : 'bg-cyan-400 shadow-glow-cyan',
          )}
          aria-hidden
        />
        {MODE_LABEL[mode]}
      </span>

      <span className="h-5 w-px bg-slate-800" aria-hidden />

      {/* -------------------------------------------------- preset buttons */}
      {PRESET_BUTTONS.map((button) => {
        const active = mode === button.preset;
        return (
          <button
            key={button.preset}
            type="button"
            onClick={() => handlePreset(button.preset)}
            aria-pressed={active}
            title={button.hint}
            className={cn(
              'flex items-center gap-1.5 rounded px-2 py-1',
              'font-mono text-[9px] uppercase tracking-widest',
              'transition-colors duration-150',
              active
                ? 'bg-cyan-500/15 text-cyan-300 shadow-glow-inset-cyan'
                : 'text-slate-400 hover:bg-slate-800/60 hover:text-cyan-300',
            )}
          >
            {button.icon}
            {button.label}
          </button>
        );
      })}

      <span className="h-5 w-px bg-slate-800" aria-hidden />

      {/* ------------------------------------------------ patrol toggle */}
      <button
        type="button"
        onClick={handleTogglePatrol}
        aria-pressed={autoRotate}
        title={
          autoRotate
            ? '环绕巡检运行中 · 点击停止自动旋转'
            : '环绕巡检 · 相机绕拓扑自动旋转'
        }
        className={cn(
          'flex items-center gap-1.5 rounded px-2 py-1',
          'font-mono text-[9px] uppercase tracking-widest',
          'transition-colors duration-150',
          autoRotate
            ? 'bg-cyan-500/15 text-cyan-300 shadow-glow-inset-cyan'
            : 'text-slate-400 hover:bg-slate-800/60 hover:text-cyan-300',
        )}
      >
        {autoRotate ? (
          <Pause className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Play className="h-3.5 w-3.5" aria-hidden />
        )}
        环绕巡检
        {autoRotate ? (
          <span
            className="h-1 w-1 animate-pulse-glow rounded-full bg-cyan-400"
            aria-hidden
          />
        ) : null}
      </button>
    </div>
  );
}

export default CameraControls;