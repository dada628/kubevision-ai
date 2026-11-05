import type { Metadata } from 'next';
import type { ReactElement } from 'react';
import { DashboardShell } from '@/components/layout/DashboardShell';

export const metadata: Metadata = {
  title: 'Cluster Situational Awareness',
  description:
    'Live Kubernetes topology, telemetry HUD and AI copilot for the KubeVision AI command surface.',
};

/**
 * Root page - Server Component by design.
 *
 * It owns `metadata` (a server-only export) and renders the client shell as a
 * child. All interactive state lives inside `DashboardShell` and below, so this
 * file can never accidentally pull Zustand or three into the RSC graph.
 *
 * The shell itself locks the document to `100dvh` with `overflow-hidden`, so no
 * `min-h-screen` wrapper is needed here - adding one would reintroduce the
 * page-level scrollbar the layout is built to avoid.
 */
export default function HomePage(): ReactElement {
  return <DashboardShell />;
}