'use client';

/**
 * KubeVision AI - chaos engineering drill modal.
 *
 * WHAT THIS IS
 * The command surface for injecting a fault into the demo cluster. Four tactical
 * drill cards, one per scenario, each stating the BLAST RADIUS before it is fired
 * (which worker, which workload, what the operator will see). Selecting a card
 * does three things atomically: it commits `activeChaos`, frames the damaged rack
 * with the camera, and broadcasts a `[CHAOS-MESH]` line into the terminal.
 *
 * WHY ONE COMPONENT OWNS ALL THREE EFFECTS
 * The three are a single user intent. If the modal only set `activeChaos` and left
 * the camera to a `useEffect` watching the store, then a chaos change triggered
 * from anywhere else (a URL param, a model tool call, a future automation) would
 * also yank the camera. Injecting a drill is what should move the camera; merely
 * having a fault active should not. Keeping the two together makes that
 * distinction structural instead of a convention.
 *
 * WHY IT READS `activeChaos` BUT NEVER WRITES IT DIRECTLY
 * `triggerChaos` is the store action that owns the side effects which must not be
 * forgotten: it applies the fault to the live telemetry pool, closes this modal,
 * writes the audit lines and force-syncs the HUD summary. Calling `set()` from here
 * would bypass every one of them and leave the 3D scene showing the OLD fault.
 *
 * ACCESSIBILITY
 * - `role="dialog"` + `aria-modal`, labelled by the title.
 * - Escape closes; the backdrop closes on click.
 * - Focus is moved into the dialog on open and restored on close, so a keyboard
 *   operator is not dropped back at the top of the document.
 * - The card list is a `radiogroup`: exactly one scenario is active, which is
 *   semantically what `activeChaos` models.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactElement,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Cpu,
  MemoryStick,
  Network,
  ShieldCheck,
  ShieldAlert,
  Skull,
  X,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import type { ChaosScenario } from '@/types/cluster';
import {
  CHAOS_TARGET_RACK,
  RACK_WORKER_LABEL,
} from '@/types/store';
import {
  useActiveChaos,
  useChaosModalOpen,
  useClusterStore,
} from '@/store/useClusterStore';
import { requestRackFocus } from '@/components/canvas/cameraCommandBus';

/* ==========================================================================
   Drill definitions
   ========================================================================== */

interface ChaosDrill {
  readonly scenario: ChaosScenario;
  /** Roman-ish index shown in the card's corner. */
  readonly code: string;
  readonly title: string;
  readonly subtitle: string;
  /** The fault mechanism, in the operator's own vocabulary. */
  readonly mechanism: string;
  /** What the operator should expect to SEE once it fires. */
  readonly expectation: string;
  readonly icon: ReactElement;
  /** `critical` for a fault, `healthy` for the recovery card. */
  readonly severity: 'critical' | 'healthy';
}

/**
 * The four drills, in damage order with the recovery last.
 *
 * The copy names the exact target rack for each fault, and those names are
 * cross-checked against `CHAOS_TARGET_RACK` at render time (`targetOf`) rather
 * than hardcoded twice - a scenario re-targeted in the engine would otherwise
 * leave this modal promising the wrong chassis.
 */
const DRILLS: readonly ChaosDrill[] = [
  {
    scenario: 'POD_OOM_SWARM',
    code: 'A',
    title: '内存溢出雪崩',
    subtitle: 'POD_OOM_SWARM',
    mechanism:
      '支付网关与缓存服务突发内存泄漏，cgroup 限额被击穿，容器进入 OOMKilled 崩溃循环。',
    expectation: '内存逼近 99%，restarts 递增，P0 告警刷屏。',
    icon: <MemoryStick className="h-5 w-5" aria-hidden />,
    severity: 'critical',
  },
  {
    scenario: 'NODE_CPU_SPIKE',
    code: 'B',
    title: '计算节点算力打满',
    subtitle: 'NODE_CPU_SPIKE',
    mechanism:
      '突发流量洪峰灌入，节点 CPU 飙升至 98%，调度器排队阻塞，上游调用开始超时。',
    expectation: '机架全量容器 92%–98%，节点状态转为 HighLoad。',
    icon: <Cpu className="h-5 w-5" aria-hidden />,
    severity: 'critical',
  },
  {
    scenario: 'NET_PACKET_LOSS',
    code: 'C',
    title: 'CNI 网络插件分区丢包',
    subtitle: 'NET_PACKET_LOSS',
    mechanism:
      '跨节点 VXLAN 隧道丢包，kubelet 失联，指标采集中断，部分容器被打回 Pending。',
    expectation: '节点标记 NetworkPartition，吞吐归零，Pod 卡在 Pending。',
    icon: <Network className="h-5 w-5" aria-hidden />,
    severity: 'critical',
  },
  {
    scenario: 'NONE',
    code: 'D',
    title: '一键恢复集群稳态',
    subtitle: 'NONE',
    mechanism:
      '清除全部混沌注入，故障容器重建，节点状态回落到健康基线。',
    expectation: '全集群回到初始健康画像，红色脉冲停止。',
    icon: <ShieldCheck className="h-5 w-5" aria-hidden />,
    severity: 'healthy',
  },
];

/** Resolves the victim label for a drill from the shared rack map. */
function targetOf(scenario: ChaosScenario): string {
  const rack = CHAOS_TARGET_RACK[scenario];
  if (rack === null) {
    return '全集群';
  }
  return RACK_WORKER_LABEL[rack];
}

/* ==========================================================================
   Visual constants
   ========================================================================== */

/**
 * The red/black hazard stripe used on the modal's top edge.
 *
 * A repeating linear gradient rather than an image: it must tile seamlessly at
 * any modal width, and an asset would need a second request behind the very
 * overlay that is supposed to feel instant. 45deg stripes at 10px read as
 * hazard tape without becoming a distraction from the card text.
 */
const HAZARD_STRIPE =
  'repeating-linear-gradient(45deg, rgba(244,63,94,0.55) 0px, rgba(244,63,94,0.55) 10px, rgba(2,6,23,0) 10px, rgba(2,6,23,0) 20px)';

/** Motion preset shared by the panel and the backdrop. */
const PANEL_TRANSITION = { duration: 0.22, ease: [0.16, 1, 0.3, 1] as const };

/* ==========================================================================
   Component
   ========================================================================== */

export function ChaosControlModal(): ReactElement {
  const isOpen = useChaosModalOpen();
  const activeChaos = useActiveChaos();
  const setChaosModalOpen = useClusterStore((state) => state.setChaosModalOpen);
  const triggerChaos = useClusterStore((state) => state.triggerChaos);

  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** Element that had focus when the dialog opened, restored on close. */
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setChaosModalOpen(false);
  }, [setChaosModalOpen]);

  /**
   * Fires a drill.
   *
   * ORDER IS THE CONTRACT, not a detail:
   * 1. `triggerChaos` first, so the store is already on the new scenario when the
   *    camera starts moving - otherwise a fast `useEffect` in a consumer could
   *    observe the old scenario alongside the new camera pose.
   * 2. Camera second, and only for a real fault. `NONE` has no blast radius, so
   *    flying somewhere to "show the recovery" would imply that rack was the only
   *    one affected.
   * 3. The `[CHAOS-MESH]` broadcast is written by `triggerChaos` itself, so this
   *    handler cannot forget it and a drill fired from any other surface still
   *    produces the same audit line.
   */
  const runDrill = useCallback(
    (scenario: ChaosScenario) => {
      triggerChaos(scenario);
      const rack = CHAOS_TARGET_RACK[scenario];
      if (rack !== null) {
        requestRackFocus(rack);
      }
    },
    [triggerChaos],
  );

  /* Escape to close + focus management. */
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    /* Move focus INTO the dialog so a keyboard operator is not left behind the
       overlay. The panel itself is the target: focusing the first card would
       imply a default choice before the operator has made one. */
    const panel = panelRef.current;
    if (panel !== null) {
      panel.focus();
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      close();
    };

    /* Capture phase: the canvas listens for pointer events and a bubbling Escape
       could be swallowed by a control that handles keys itself. */
    window.addEventListener('keydown', onKeyDown, true);

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      const restore = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restore !== null && document.contains(restore)) {
        restore.focus();
      }
    };
  }, [isOpen, close]);

  /** Backdrop click closes; a click that STARTED inside the panel does not. */
  const handleBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        close();
      }
    },
    [close],
  );

  return (
    <AnimatePresence>
      {isOpen ? (
        <motion.div
          key="chaos-drill-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onClick={handleBackdropClick}
          className="fixed inset-0 z-50 grid place-items-center bg-slate-950/80 p-4 backdrop-blur-sm"
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            tabIndex={-1}
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={PANEL_TRANSITION}
            className="relative w-full max-w-3xl overflow-hidden rounded-xl border border-rose-500/35 bg-slate-900/90 shadow-panel backdrop-blur-md focus:outline-none"
          >
            {/*
              HAZARD TAPE. Two stripes - top and bottom - frame the panel so the
              warning reads as containment rather than as a background texture. The
              panel is `overflow-hidden`, so they clip to the rounded corners.
            */}
            <div
              className="h-1.5 w-full"
              style={{ backgroundImage: HAZARD_STRIPE }}
              aria-hidden
            />

            {/* ------------------------------------------------------- header */}
            <header className="flex items-start gap-3 px-5 pb-3 pt-4">
              <span
                className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-400"
                aria-hidden
              >
                <Skull className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2
                  id={titleId}
                  className="flex items-center gap-2 text-sm font-semibold tracking-tight text-slate-100"
                >
                  混沌工程故障演练
                  <span className="rounded border border-rose-500/40 bg-rose-500/10 px-1.5 py-px font-mono text-[9px] font-medium uppercase tracking-widest text-rose-400">
                    chaos mesh
                  </span>
                </h2>
                <p
                  id={descriptionId}
                  className="mt-1 text-[11px] leading-relaxed text-slate-500"
                >
                  选择任意战术场景立即注入故障。演练会切换 SSE 遥测演进、推近受灾机架，
                  并在终端广播演练记录。
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close chaos drill"
                className="grid h-7 w-7 shrink-0 place-items-center rounded border border-slate-700 bg-slate-900/70 text-slate-500 transition-colors hover:border-rose-500/50 hover:text-rose-400"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </header>

            {/* -------------------------------------------------------- cards */}
            <div
              className="grid gap-2 px-5 pb-4 sm:grid-cols-2"
              role="radiogroup"
              aria-label="Chaos fault scenarios"
            >
              {DRILLS.map((drill) => {
                const isActive = activeChaos === drill.scenario;
                const isRecovery = drill.severity === 'healthy';
                return (
                  <button
                    key={drill.scenario}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    onClick={() => runDrill(drill.scenario)}
                    className={cn(
                      'group relative overflow-hidden rounded-lg border p-3 text-left transition-all duration-150',
                      'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500/70',
                      isRecovery
                        ? isActive
                          ? 'border-emerald-400/70 bg-emerald-500/10 shadow-glow-emerald'
                          : 'border-emerald-500/30 bg-slate-950/60 hover:border-emerald-400/60 hover:bg-emerald-500/10'
                        : isActive
                          ? 'border-rose-400/70 bg-rose-500/10 shadow-glow-rose'
                          : 'border-slate-800 bg-slate-950/60 hover:border-rose-500/50 hover:bg-rose-500/5',
                    )}
                  >
                    {/* Active cards keep the pulse; idle cards stay still so the
                        operator's eye is drawn to the CURRENT fault, not to four
                        blinking buttons. */}
                    {isActive ? (
                      <span
                        className={cn(
                          'absolute inset-x-0 top-0 h-0.5 animate-pulse-glow',
                          isRecovery ? 'bg-emerald-400' : 'bg-rose-500',
                        )}
                        aria-hidden
                      />
                    ) : null}

                    <div className="flex items-start gap-2.5">
                      <span
                        className={cn(
                          'grid h-8 w-8 shrink-0 place-items-center rounded-md border',
                          isRecovery
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                            : 'border-rose-500/40 bg-rose-500/10 text-rose-400',
                        )}
                        aria-hidden
                      >
                        {drill.icon}
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1.5">
                          <span className="font-mono text-[9px] uppercase tracking-widest text-slate-600">
                            sc-{drill.code}
                          </span>
                          <h3 className="truncate text-[12px] font-semibold text-slate-100">
                            {drill.title}
                          </h3>
                        </div>
                        <p className="mt-0.5 font-mono text-[9px] uppercase tracking-wider text-slate-500">
                          {drill.subtitle}
                        </p>
                      </div>

                      {isActive ? (
                        <span
                          className={cn(
                            'shrink-0 rounded border px-1.5 py-px font-mono text-[8px] uppercase tracking-widest',
                            isRecovery
                              ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                              : 'border-rose-500/50 bg-rose-500/10 text-rose-400',
                          )}
                        >
                          active
                        </span>
                      ) : null}
                    </div>

                    <p className="mt-2 text-[10.5px] leading-relaxed text-slate-400">
                      {drill.mechanism}
                    </p>

                    <dl className="mt-2 space-y-0.5 border-t border-slate-800/80 pt-1.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <dt className="shrink-0 font-mono text-[8px] uppercase tracking-widest text-slate-600">
                          受灾目标
                        </dt>
                        <dd
                          className={cn(
                            'truncate font-mono text-[9px]',
                            isRecovery ? 'text-emerald-400' : 'text-rose-400',
                          )}
                        >
                          {targetOf(drill.scenario)}
                        </dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-2">
                        <dt className="shrink-0 font-mono text-[8px] uppercase tracking-widest text-slate-600">
                          预期表现
                        </dt>
                        <dd className="truncate text-right text-[9px] text-slate-500">
                          {drill.expectation}
                        </dd>
                      </div>
                    </dl>
                  </button>
                );
              })}
            </div>

            {/* ------------------------------------------------------- footer */}
            <footer className="flex items-center justify-between gap-3 border-t border-slate-800/80 bg-slate-950/60 px-5 py-2.5">
              <p className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-widest text-slate-600">
                <ShieldAlert className="h-3 w-3 shrink-0 text-rose-500/70" aria-hidden />
                演练作用于演示快照，可随时回滚
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={close}
                  className="rounded border border-slate-700 px-2.5 py-1 font-mono text-[9px] uppercase tracking-widest text-slate-500 transition-colors hover:border-slate-600 hover:text-slate-300"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => runDrill('NONE')}
                  className="flex items-center gap-1.5 rounded border border-emerald-500/45 bg-emerald-500/10 px-2.5 py-1 font-mono text-[9px] uppercase tracking-widest text-emerald-300 transition-colors hover:border-emerald-400 hover:bg-emerald-500/20"
                >
                  <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden />
                  恢复稳态
                </button>
              </div>
            </footer>

            <div
              className="h-1.5 w-full"
              style={{ backgroundImage: HAZARD_STRIPE }}
              aria-hidden
            />
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export default ChaosControlModal;