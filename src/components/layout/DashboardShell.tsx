'use client';

import type { ReactElement, ReactNode } from 'react';
import { ShellLayout } from './ShellLayout';
import { TopologyViewport } from '@/components/canvas/TopologyViewport';
import { ChaosControlModal } from '@/components/hud/ChaosControlModal';
import { useHudSync } from '@/hooks/useHudSync';
import { useTelemetryStream } from '@/hooks/useTelemetryStream';

/**
 * Client entry for the dashboard shell.
 *
 * Exists so `app/page.tsx` can stay a Server Component (and keep exporting
 * `metadata`) while the shell - which reads Zustand state - is a client
 * boundary. `useHudSync` is mounted here, exactly once, above the shell, so the
 * 1 Hz summary ticker cannot be accidentally duplicated by a child.
 *
 * `useTelemetryStream` is mounted beside it for the same reason. It is the ONLY
 * writer of `telemetryTransientRef` on the client: mounting it in the page (or in
 * any per-rack component) would open a second transport and interleave two
 * timelines into one pool. `useHudSync` remains responsible for the steady 1 Hz
 * HUD commit; the stream additionally force-syncs on every frame so the HUD can
 * never lag the 3D scene by a full second.
 *
 * WHY THE DYNAMIC CANVAS MOUNT LIVES HERE AND NOT IN `page.tsx`
 * `next/dynamic({ ssr: false })` is only legal inside a Client Component in the
 * App Router; using it in `page.tsx` (a Server Component) is a build error. The
 * `ssr: false` boundary therefore sits in `TopologyViewport`, one level above
 * `<Canvas>`, and this file injects it as the shell's `viewportSlot`. The effect
 * is the one required by `.cursorrules` rule 4: `three` never enters the RSC or
 * server module graph, and the viewport still streams in with a skeleton.
 *
 * The right-hand copilot is passed in from `page.tsx` so the page owns which
 * drawer fills `copilotSlot`.
 */
export function DashboardShell({ copilotSlot }: { readonly copilotSlot?: ReactNode }): ReactElement {
  useHudSync();
  useTelemetryStream();

  return (
    <>
      <ShellLayout viewportSlot={<TopologyViewport />} copilotSlot={copilotSlot} />
      {/*
        The chaos drill modal is a SIBLING of the shell, not a child of the
        viewport or the top bar. It is `position: fixed` and needs to cover the
        whole window (including the header), so nesting it inside either region
        would put it at the mercy of that region's `overflow-hidden` and stacking
        context. Mounting it here also means the per-viewport components stay
        ignorant of it and cannot open a second copy.
      */}
      <ChaosControlModal />
    </>
  );
}

export default DashboardShell;