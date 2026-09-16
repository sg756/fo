import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  HOME_PATH,
  loadVisitedTabs,
  resolveVisitedTab,
  saveVisitedTabs,
  type VisitedTab,
} from '../nav';

function isActivePath(current: string, tabPath: string) {
  if (tabPath === HOME_PATH) return current === HOME_PATH;
  return current === tabPath;
}

function tabUrl(t: Pick<VisitedTab, 'path' | 'search'>) {
  return `${t.path}${t.search || ''}`;
}

const VisitedTabsContext = createContext<{
  tabs: VisitedTab[];
  cacheKeys: string[];
  closeTab: (path: string) => void;
} | null>(null);

export function useVisitedTabs() {
  const ctx = useContext(VisitedTabsContext);
  if (!ctx) throw new Error('VisitedTabsProvider 未包裹');
  return ctx;
}

export function VisitedTabsProvider({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [tabs, setTabs] = useState<VisitedTab[]>(() => loadVisitedTabs());

  useEffect(() => {
    const hit = resolveVisitedTab(location.pathname);
    if (!hit) return;
    const nextTab: VisitedTab = { ...hit, search: location.search || '' };
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === hit.path);
      let next: VisitedTab[];
      if (idx >= 0) {
        const cur = prev[idx];
        if (cur.search === nextTab.search && cur.label === nextTab.label) return prev;
        next = prev.map((t, i) => (i === idx ? nextTab : t));
      } else {
        next = [...prev, nextTab];
      }
      saveVisitedTabs(next);
      return next;
    });
  }, [location.pathname, location.search]);

  const closeTab = useCallback(
    (path: string) => {
      if (path === HOME_PATH) return;
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.path === path);
        if (idx < 0) return prev;
        const next = prev.filter((t) => t.path !== path);
        saveVisitedTabs(next);
        if (isActivePath(location.pathname, path)) {
          const fallback = next[Math.max(0, idx - 1)] || next[0];
          navigate(fallback ? tabUrl(fallback) : HOME_PATH);
        }
        return next;
      });
    },
    [location.pathname, navigate],
  );

  const value = useMemo(
    () => ({ tabs, cacheKeys: tabs.map((t) => t.path), closeTab }),
    [tabs, closeTab],
  );

  return <VisitedTabsContext.Provider value={value}>{children}</VisitedTabsContext.Provider>;
}

export function VisitedTabs() {
  const location = useLocation();
  const navigate = useNavigate();
  const { tabs, closeTab } = useVisitedTabs();
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const active = el.querySelector('.visited-tab.active') as HTMLElement | null;
    active?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
  }, [location.pathname, tabs]);

  function openTab(t: VisitedTab) {
    const url = tabUrl(t);
    if (location.pathname === t.path && (location.search || '') === (t.search || '')) return;
    navigate(url);
  }

  return (
    <div className="visited-tabs" aria-label="已打开页面">
      <div className="visited-tabs-scroll" ref={scrollerRef}>
        {tabs.map((t) => {
          const active = isActivePath(location.pathname, t.path);
          const closable = t.path !== HOME_PATH;
          return (
            <button
              key={t.path}
              type="button"
              className={`visited-tab${active ? ' active' : ''}`}
              onClick={() => openTab(t)}
              title={t.label}
            >
              <span className="visited-tab-label">{t.label}</span>
              {closable ? (
                <span
                  className="visited-tab-close"
                  role="button"
                  tabIndex={0}
                  aria-label={`关闭 ${t.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.path);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      closeTab(t.path);
                    }
                  }}
                >
                  ×
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
