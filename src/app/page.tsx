import type { Metadata } from 'next';
import type { ReactElement } from 'react';
import { InsightDrawer } from '@/components/ai/InsightDrawer';
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
 * The insight drawer is created here and handed to the shell's right slot.
 * It keeps the copilot and the edge log auditor mounted, and switches them
 * with tabs. The page stays a Server Component: the drawer is a client module,
 * so Zustand and the chat hook never enter this file's own module graph.
 */
export default function HomePage(): ReactElement {
  return <DashboardShell copilotSlot={<InsightDrawer />} />;
}
