import { useEffect, useRef, useState } from 'react';
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

export function VisitedTabs() {
  const location = useLocation();
  const navigate = useNavigate();
  const [tabs, setTabs] = useState<VisitedTab[]>(() => loadVisitedTabs());
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const hit = resolveVisitedTab(location.pathname);
    if (!hit) return;
    setTabs((prev) => {
      if (prev.some((t) => t.path === hit.path)) {
        const next = prev.map((t) => (t.path === hit.path ? hit : t));
        saveVisitedTabs(next);
        return next;
      }
      const next = [...prev, hit];
      saveVisitedTabs(next);
      return next;
    });
  }, [location.pathname]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const active = el.querySelector('.visited-tab.active') as HTMLElement | null;
    active?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
  }, [location.pathname, tabs]);

  function openTab(path: string) {
    if (path === location.pathname) return;
    navigate(path);
  }

  function closeTab(path: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (path === HOME_PATH) return;

    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === path);
      if (idx < 0) return prev;
      const next = prev.filter((t) => t.path !== path);
      saveVisitedTabs(next);

      if (isActivePath(location.pathname, path)) {
        const fallback = next[Math.max(0, idx - 1)] || next[0];
        navigate(fallback?.path || HOME_PATH);
      }
      return next;
    });
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
              onClick={() => openTab(t.path)}
              title={t.label}
            >
              <span className="visited-tab-label">{t.label}</span>
              {closable ? (
                <span
                  className="visited-tab-close"
                  role="button"
                  tabIndex={0}
                  aria-label={`关闭 ${t.label}`}
                  onClick={(e) => closeTab(t.path, e)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      closeTab(t.path, e as unknown as React.MouseEvent);
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
