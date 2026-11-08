'use client';

import { useEffect, type ReactElement } from 'react';
import { bindLogClassifierWorker } from '@/workers/edgeClassifierChannel';

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
 * Cleanup detaches the message bus and calls `terminate()`. That covers route
 * changes and the Strict Mode remount, which would otherwise leave a second
 * ONNX session alive. The auditor panel talks to this same worker through the
 * bus; it must not construct another one.
 */
export function EdgeLogClassifier(): ReactElement | null {
  useEffect(() => {
    const worker = new Worker(
      new URL('../workers/logClassifier.worker.ts', import.meta.url),
      { type: 'module' },
    );
    const detach = bindLogClassifierWorker(worker);

    return () => {
      detach();
      worker.terminate();
    };
  }, []);

  return null;
}

export default EdgeLogClassifier;
