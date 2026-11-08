'use client';

import type { ReactElement, ReactNode } from 'react';
import { Boxes, Layers, Sparkles } from 'lucide-react';
import { cn } from '@/utils/cn';
import TopBar from './TopBar';
import TerminalEcho from './TerminalEcho';

/* ==========================================================================
   Placeholder slots
   ========================================================================== */

interface SlotPlaceholderProps {
  readonly title: string;
  readonly subtitle: string;
  readonly icon: ReactElement;
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * A reserved mount point for a component that lands in a later milestone.
 *
 * Rendered as a dashed, low-contrast frame rather than an empty div: during
 * development it makes the layout contract visible, and it cannot be mistaken
 * for a rendering bug.
 */
function SlotPlaceholder({
  title,
  subtitle,
  icon,
  className,
  children,
}: SlotPlaceholderProps): ReactElement {
  return (
    <div
      className={cn(
        'relative grid min-h-0 flex-1 place-items-center overflow-hidden rounded-xl border border-dashed border-slate-800 bg-slate-950/40',
        className,
      )}
    >
      <div className="kv-grid-overlay" aria-hidden />
      <div className="relative flex flex-col items-center gap-3 px-6 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-xl border border-slate-800 bg-slate-900/70 text-slate-600">
          {icon}
        </span>
        <div className="space-y-1">
          <p className="font-mono text-[10px] uppercase tracking-ultra-wide text-slate-500">
            {title}
          </p>
          <p className="max-w-xs text-xs leading-relaxed text-slate-600">
            {subtitle}
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ==========================================================================
   ShellLayout
   ========================================================================== */

/**
 * 运维中控台布局外壳。
 *
 * Structure (viewport-locked, zero document scroll):
 *
 *   ┌──────────────────────────────────────────────┐  h-14  TopBar
 *   ├───────────────────────────┬──────────────────┤
 *   │  left  65%                │  right 35%       │  h-[calc(100vh-3.5rem)]
 *   │  ┌─────────────────────┐  │  ┌────────────┐  │
 *   │  │ 3D viewport slot    │  │  │ AI drawer  │  │
 *   │  ├─────────────────────┤  │  │ slot       │  │
 *   │  │ TerminalEcho h-32   │  │  │            │  │
 *   │  └─────────────────────┘  │  └────────────┘  │
 *   └───────────────────────────┴──────────────────┘
 *
 * Scroll containment rules:
 * - `html`/`body` get `overflow-hidden` via the root layout's `h-full`, and this
 *   shell adds `h-[100dvh] overflow-hidden` so mobile browser chrome cannot
 *   produce a rubber-band scroll.
 * - `100dvh` rather than `100vh`: on iOS Safari `100vh` overflows behind the
 *   toolbar, which is exactly the scrollbar this shell must not have.
 * - Internal panes opt into `overflow-y-auto` individually (the AI drawer), so
 *   the document itself never scrolls.
 *
 * Responsive contract:
 * - `lg+`: the fixed 65/35 two-column split.
 * - `<lg`: single column, 3D viewport first, AI drawer becomes a bottom sheet
 *   region stacked under it with its own scroll. The terminal stays attached to
 *   the viewport in both modes.
 */
export interface ShellLayoutProps {
  /** Mount point for the R3F canvas. Injected by the page. */
  readonly viewportSlot?: ReactNode;
  /** Mount point for the AI copilot drawer. Injected by the page. */
  readonly copilotSlot?: ReactNode;
  /** Performance HUD overlay; rendered above everything when present. */
  readonly perfHudSlot?: ReactNode;
}

export function ShellLayout({
  viewportSlot,
  copilotSlot,
  perfHudSlot,
}: ShellLayoutProps): ReactElement {
  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-slate-950 text-slate-100 antialiased">
      <TopBar />

      {/* ---------------------------------------------------------------- body */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        {/* --------------------------- left 65% --------------------------- */}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden lg:basis-[65%] lg:grow-0">
          <div
            className="pointer-events-none absolute inset-0 bg-void-bloom"
            aria-hidden
          />
          <div className="kv-grid-overlay" aria-hidden />

          {/* 3D viewport slot - the only region the canvas is allowed to fill. */}
          <div className="relative flex min-h-0 flex-1 flex-col p-2 lg:p-3">
            {viewportSlot ?? (
              <SlotPlaceholder
                title="3d topology viewport"
                subtitle="React Three Fiber canvas mount. Instanced pods, rack rails and the control-plane beacon render here at 60 FPS."
                icon={<Boxes className="h-6 w-6" />}
              >
                <span className="rounded border border-slate-800 bg-slate-900/70 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-slate-600">
                  slot: viewportSlot
                </span>
              </SlotPlaceholder>
            )}
          </div>

          {/* Terminal dock - always the last child of the left column. */}
          <TerminalEcho />
        </div>

        {/* --------------------------- right 35% -------------------------- */}
        <aside className="flex min-h-0 shrink-0 flex-col overflow-hidden border-t border-slate-800/80 bg-slate-950/60 lg:h-auto lg:w-[35%] lg:border-l lg:border-t-0">
          <div className="flex h-8 shrink-0 items-center justify-between border-b border-slate-800/60 px-3">
            <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-ultra-wide text-slate-400">
              <Sparkles className="h-3.5 w-3.5 text-cyan-400" aria-hidden />
              insight
            </span>
            <span className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-widest text-slate-600">
              <Layers className="h-3 w-3" aria-hidden />
              edge wasm
            </span>
          </div>

          {/* Height is fixed here. The transcript inside the drawer is the only scroller,
              so a growing card cannot chain into this column or the document. */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden overscroll-contain p-2 lg:p-3">
            {copilotSlot ?? (
              <SlotPlaceholder
                title="ai copilot drawer"
                subtitle="Generative UI cards, root-cause evidence chains and the on-device log audit stream mount here."
                icon={<Sparkles className="h-6 w-6" />}
                className="h-full"
              >
                <span className="rounded border border-slate-800 bg-slate-900/70 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-slate-600">
                  slot: copilotSlot
                </span>
              </SlotPlaceholder>
            )}
          </div>
        </aside>
      </div>

      {perfHudSlot}
    </div>
  );
}

export default ShellLayout;