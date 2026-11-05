'use client';

import type { ReactElement } from 'react';
import { ShellLayout } from './ShellLayout';
import { useHudSync } from '@/hooks/useHudSync';

/**
 * Client entry for the dashboard shell.
 *
 * Exists so `app/page.tsx` can stay a Server Component (and keep exporting
 * `metadata`) while the shell - which reads Zustand state - is a client
 * boundary. `useHudSync` is mounted here, exactly once, above the shell, so the
 * 1 Hz summary ticker cannot be accidentally duplicated by a child.
 */
export function DashboardShell(): ReactElement {
  useHudSync();

  return <ShellLayout />;
}

export default DashboardShell;