import { createContext, useContext, useRef, type ReactNode } from 'react';
import {
  UNSAFE_LocationContext,
  UNSAFE_RouteContext,
  useLocation,
  useNavigationType,
  useOutlet,
  type Location,
} from 'react-router-dom';
import { resolveVisitedTab } from '../nav';

export const KeepAliveActiveContext = createContext(true);

export function useKeepAliveActive() {
  return useContext(KeepAliveActiveContext);
}

type CacheEntry = {
  node: ReactNode;
  location: Location;
  routeContext: unknown;
};

function tabKey(pathname: string) {
  return resolveVisitedTab(pathname)?.path || pathname;
}

/** 已打开页签保持挂载：切走只隐藏，关掉页签才卸载（筛选字、列表、滚动都还在）。 */
export function KeepAliveOutlet({ cacheKeys }: { cacheKeys: string[] }) {
  const outlet = useOutlet();
  const location = useLocation();
  const navType = useNavigationType();
  const routeContext = useContext(UNSAFE_RouteContext);
  const cacheRef = useRef(new Map<string, CacheEntry>());
  const cache = cacheRef.current;
  const allowed = new Set(cacheKeys);
  const activeKey = tabKey(location.pathname);

  if (outlet) {
    const prev = cache.get(activeKey);
    if (!prev) {
      cache.set(activeKey, {
        node: outlet,
        location,
        routeContext,
      });
    } else {
      prev.location = location;
      prev.routeContext = routeContext;
    }
  }
  for (const key of [...cache.keys()]) {
    if (key !== activeKey && !allowed.has(key)) cache.delete(key);
  }

  const entries = [...cache.entries()];
  if (!entries.length && outlet) {
    return <>{outlet}</>;
  }

  return (
    <div className="keep-alive-host">
      {entries.map(([key, entry]) => {
        const active = key === activeKey;
        return (
          <UNSAFE_LocationContext.Provider
            key={key}
            value={{
              location: active ? location : entry.location,
              navigationType: navType,
            }}
          >
            <UNSAFE_RouteContext.Provider
              value={
                (active ? routeContext : entry.routeContext) as typeof routeContext
              }
            >
              <KeepAliveActiveContext.Provider value={active}>
                <div
                  className={`keep-alive-pane${active ? ' active' : ''}`}
                  aria-hidden={!active}
                  {...(!active ? { inert: true } : {})}
                >
                  {entry.node}
                </div>
              </KeepAliveActiveContext.Provider>
            </UNSAFE_RouteContext.Provider>
          </UNSAFE_LocationContext.Provider>
        );
      })}
    </div>
  );
}
