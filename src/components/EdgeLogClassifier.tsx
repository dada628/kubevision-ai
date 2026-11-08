'use client';

import { useEffect, type ReactElement } from 'react';

/**
 * Single owner of the edge log-classifier worker.
 *
 * Mounted once from `DashboardShell`. The constructor is inside `useEffect`
 * so it never runs during SSR or during render: `Worker` and `import.meta.url`
 * are browser-only, and a worker created in the render path would be leaked
 * on every Strict Mode double-render.
 *
 * The URL is a static `new URL(..., import.meta.url)` so webpack can see the
 * worker module and emit it as its own chunk. `{ type: 'module' }` is required
 * because the worker is an ES module (it `import`s Transformers.js).
 *
 * Cleanup calls `terminate()`. That covers route changes and the Strict Mode
 * remount, which would otherwise leave a second ONNX session alive.
 */
export function EdgeLogClassifier(): ReactElement | null {
  useEffect(() => {
    const worker = new Worker(
      new URL('../workers/logClassifier.worker.ts', import.meta.url),
      { type: 'module' },
    );

    return () => {
      worker.terminate();
    };
  }, []);

  return null;
}

export default EdgeLogClassifier;
