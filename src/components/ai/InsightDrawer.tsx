'use client';

/**
 * Right-hand drawer chrome.
 *
 * Both views stay mounted. Hiding the copilot with the `hidden` attribute keeps
 * `useChat` and the quick-prompt effect alive, so an edge audit can hand a
 * sanitized line to the copilot and the session is still there when the tab
 * comes back.
 */

import { useState, type KeyboardEvent, type ReactElement } from 'react';
import { CopilotDrawer } from '@/components/ai/CopilotDrawer';
import { LocalAuditorPanel } from '@/components/ai/LocalAuditorPanel';
import { INSIGHT_DRAWER_TABS, type InsightDrawerTab } from '@/types/ai';

const TAB_LABEL: Record<InsightDrawerTab, string> = {
  copilot: 'AI SRE Copilot',
  auditor: 'Edge Log Auditor (Transformers.js)',
};

export function InsightDrawer(): ReactElement {
  const [tab, setTab] = useState<InsightDrawerTab>('copilot');

  const onTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') {
      return;
    }
    event.preventDefault();
    const last = INSIGHT_DRAWER_TABS.length - 1;
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowRight'
            ? (index + 1) % INSIGHT_DRAWER_TABS.length
            : (index - 1 + INSIGHT_DRAWER_TABS.length) % INSIGHT_DRAWER_TABS.length;
    const next = INSIGHT_DRAWER_TABS[nextIndex];
    if (next === undefined) {
      return;
    }
    setTab(next);
    const button = document.getElementById(`insight-tab-${next}`);
    if (button instanceof HTMLButtonElement) {
      button.focus();
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden" aria-label="右侧洞察抽屉">
      <div
        role="tablist"
        aria-label="洞察视图"
        className="grid shrink-0 grid-cols-2 gap-1 rounded-lg border border-slate-800 bg-slate-900/75 p-1 backdrop-blur-md"
      >
        {INSIGHT_DRAWER_TABS.map((id, index) => {
          const selected = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`insight-tab-${id}`}
              aria-selected={selected}
              aria-controls={`insight-panel-${id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                setTab(id);
              }}
              onKeyDown={(event) => {
                onTabKeyDown(event, index);
              }}
              className={`min-h-11 cursor-pointer rounded-md px-2 py-1.5 text-center text-xs font-medium leading-snug outline-none ring-cyan-400 focus-visible:ring-2 ${
                selected
                  ? 'bg-cyan-400/15 text-cyan-100'
                  : 'text-slate-400 hover:bg-slate-800/80 hover:text-slate-100'
              }`}
            >
              {TAB_LABEL[id]}
            </button>
          );
        })}
      </div>

      <div
        id="insight-panel-copilot"
        role="tabpanel"
        aria-labelledby="insight-tab-copilot"
        hidden={tab !== 'copilot'}
        className={
          tab === 'copilot'
            ? 'flex min-h-0 flex-1 flex-col overflow-hidden pt-2'
            : 'hidden'
        }
      >
        <CopilotDrawer />
      </div>

      <div
        id="insight-panel-auditor"
        role="tabpanel"
        aria-labelledby="insight-tab-auditor"
        hidden={tab !== 'auditor'}
        className={
          tab === 'auditor'
            ? 'flex min-h-0 flex-1 flex-col overflow-hidden pt-2'
            : 'hidden'
        }
      >
        <LocalAuditorPanel
          onOpenCopilot={() => {
            setTab('copilot');
          }}
        />
      </div>
    </section>
  );
}

export default InsightDrawer;
