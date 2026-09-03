import { useEffect, useMemo, useState } from 'react';
import {
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { AuthApi, getAdminMe, getAdminMenus, getToken, setAdminMe, setToken } from './api';
import { applyTheme, getTheme, THEMES, type ThemeId } from './theme';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { UsersPage } from './pages/UsersPage';
import { DistributionPage } from './pages/DistributionPage';
import { UserListPage } from './pages/UserListPage';
import { UserRebatePage } from './pages/UserRebatePage';
import { AdminsPage } from './pages/AdminsPage';
import { RolesPage } from './pages/RolesPage';
import { TradeConfigPage } from './pages/TradeConfigPage';
import { FollowTemplatesPage } from './pages/FollowTemplatesPage';
import { SymbolListPage } from './pages/SymbolListPage';
import { TradeSignalsPage } from './pages/TradeSignalsPage';
import { TradeLogsPage } from './pages/TradeLogsPage';
import { TradeOrderLogsPage } from './pages/TradeOrderLogsPage';
import { PositionsPage } from './pages/PositionsPage';
import { PositionsComparePage } from './pages/PositionsComparePage';
import { FollowersPage } from './pages/FollowersPage';
import { PointCardPage } from './pages/PointCardPage';
import { RechargesPage } from './pages/RechargesPage';
import { CommissionPage } from './pages/CommissionPage';
import { CommissionRecordsPage } from './pages/CommissionRecordsPage';
import { ReconcilePage } from './pages/ReconcilePage';
import { IpPoolPage } from './pages/IpPoolPage';
import { ProxyConfigPage } from './pages/ProxyConfigPage';
import { KeysAuditPage } from './pages/KeysAuditPage';
import { MiddlewarePostLogsPage } from './pages/MiddlewarePostLogsPage';
import { WithdrawsPage } from './pages/WithdrawsPage';
import { WalletPage } from './pages/WalletPage';
import { CollectionAddressesPage } from './pages/CollectionAddressesPage';
import { GasWalletsPage } from './pages/GasWalletsPage';
import { TotpSecurityModal } from './components/TotpSecurityModal';
import { CollectionRecordsPage } from './pages/CollectionRecordsPage';
import { ConfirmHost } from './components/ConfirmDialog';
import { ToastHost } from './components/Toast';
import { SessionExpiredHost } from './components/SessionExpiredHost';
import { VisitedTabs } from './components/VisitedTabs';
import {
  clearVisitedTabs,
  loadNavOpen,
  matchChild,
  NAV_GROUPS,
  saveNavOpen,
  type NavChild,
  type NavGroup,
} from './nav';
import './styles.css';

function useAllowedMenus() {
  const [menus, setMenus] = useState<string[]>(() => getAdminMenus());
  useEffect(() => {
    if (!getToken()) return;
    AuthApi.me()
      .then((me) => {
        setAdminMe(me);
        setMenus(me.menus || []);
      })
      .catch(() => undefined);
  }, []);
  return menus;
}

function filterNav(menus: string[]) {
  const allow = new Set(menus);
  // 无 menus（旧会话）时展示全部，避免锁死
  const openAll = allow.size === 0;
  return NAV_GROUPS.map((g) => ({
    ...g,
    children: g.children.filter((c) => openAll || allow.has(c.menu)),
  })).filter((g) => g.children.length > 0);
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RequireMenu({ menu, children }: { menu: string; children: React.ReactNode }) {
  const menus = useAllowedMenus();
  if (menus.length > 0 && !menus.includes(menu)) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

function Sidebar() {
  const location = useLocation();
  const menus = useAllowedMenus();
  const groups = useMemo(() => filterNav(menus), [menus]);

  const activeGroupKey = useMemo(() => {
    const g = groups.find((grp) => grp.children.some((c) => matchChild(location.pathname, c)));
    return g?.key ?? groups[0]?.key ?? 'overview';
  }, [location.pathname, groups]);

  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const saved = loadNavOpen();
    if (Object.keys(saved).length > 0) return saved;
    // 首次：仅总览展开
    return { overview: true };
  });

  useEffect(() => {
    setOpen((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const g of groups) {
        if (next[g.key] === undefined) {
          next[g.key] = g.key === 'overview';
          changed = true;
        }
      }
      // 当前路由所在分组始终展开，避免进了页面却看不到子菜单
      if (next[activeGroupKey] !== true) {
        next[activeGroupKey] = true;
        changed = true;
      }
      if (changed) saveNavOpen(next);
      return changed ? next : prev;
    });
  }, [activeGroupKey, groups]);

  function toggleGroup(key: string, currentlyOpen: boolean) {
    setOpen((p) => {
      const next = { ...p, [key]: !currentlyOpen };
      saveNavOpen(next);
      return next;
    });
  }

  return (
    <aside className="sidebar">
      <h1>多用户管理系统</h1>
      <nav className="nav-groups">
        {groups.map((g) => {
          const isOpen = open[g.key] === true;
          const hasActive = g.children.some((c) => matchChild(location.pathname, c));
          return (
            <div key={g.key} className={`nav-group ${hasActive ? 'has-active' : ''}`}>
              <button
                type="button"
                className="nav-group-title"
                onClick={() => toggleGroup(g.key, isOpen)}
              >
                <span className="nav-group-icon">{g.icon}</span>
                <span className="nav-group-label">{g.label}</span>
                <span className={`nav-caret ${isOpen ? 'open' : ''}`}>›</span>
              </button>
              {isOpen ? (
                <div className="nav-children">
                  {g.children.map((c) => (
                    <NavLink
                      key={c.to}
                      to={c.to}
                      end={c.end}
                      className={({ isActive }) => (isActive ? 'active' : '')}
                    >
                      {c.label}
                    </NavLink>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

function AccountMenu() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [totpOpen, setTotpOpen] = useState(false);
  const [theme, setThemeState] = useState<ThemeId>(() => getTheme());
  const me = getAdminMe();
  const accountName =
    me?.nickname || me?.email?.split('@')[0] || me?.email || '管理员';

  useEffect(() => {
    if (!open) return;
    const onDoc = () => setOpen(false);
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [open]);

  function pickTheme(id: ThemeId) {
    applyTheme(id);
    setThemeState(id);
  }

  return (
    <div className="account-menu-wrap topbar-account" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`account-menu-trigger${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="account-menu-name" title={accountName}>
          {accountName}
        </span>
        <span className="account-menu-caret">{open ? '▴' : '▾'}</span>
      </button>
      {open ? (
        <div className="account-menu">
          <div className="account-menu-label">主题</div>
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`account-menu-item${theme === t.id ? ' active' : ''}`}
              onClick={() => pickTheme(t.id)}
            >
              <span>{t.label}</span>
              {theme === t.id ? <span className="check">✓</span> : null}
            </button>
          ))}
          <div className="account-menu-divider" />
          <button
            type="button"
            className="account-menu-item"
            onClick={() => {
              setOpen(false);
              setTotpOpen(true);
            }}
          >
            安全设置
            {me?.totpEnabled ? (
              <span className="hint" style={{ margin: 0, fontSize: 11 }}>
                已绑验证器
              </span>
            ) : (
              <span className="hint" style={{ margin: 0, fontSize: 11, color: 'var(--danger)' }}>
                未绑定
              </span>
            )}
          </button>
          <div className="account-menu-divider" />
          <button
            type="button"
            className="account-menu-item logout"
            onClick={() => {
              setToken(null);
              clearVisitedTabs();
              nav('/login');
            }}
          >
            退出
          </button>
        </div>
      ) : null}
      <TotpSecurityModal open={totpOpen} onClose={() => setTotpOpen(false)} />
    </div>
  );
}

function Topbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const menus = getAdminMenus();
  const groups = useMemo(() => filterNav(menus), [menus]);
  const [groupOpen, setGroupOpen] = useState(false);

  const crumb = useMemo(() => {
    const homeTo = groups.find((x) => x.key === 'overview')?.children[0]?.to || '/';
    const isRebate = location.pathname.startsWith('/distribution/rebate/');

    for (const g of groups) {
      const item = g.children.find((c) => matchChild(location.pathname, c));
      if (item) {
        return {
          group: g,
          page: item,
          siblings: g.children,
          homeTo,
          extra: isRebate ? '返利汇总' : '',
          parentPage: isRebate ? item : null,
        };
      }
    }
    return {
      group: null as NavGroup | null,
      page: null as NavChild | null,
      siblings: [] as NavChild[],
      homeTo,
      extra: '',
      parentPage: null as NavChild | null,
    };
  }, [location.pathname, groups]);

  useEffect(() => {
    setGroupOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!groupOpen) return;
    const onDoc = () => setGroupOpen(false);
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [groupOpen]);

  return (
    <header className="topbar">
      <nav className="breadcrumb" aria-label="面包屑">
        <NavLink to={crumb.homeTo} end className="crumb home link">
          首页
        </NavLink>
        {crumb.group ? (
          <>
            <span className="crumb-sep">/</span>
            <div className="crumb-group" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className={`crumb link crumb-group-btn${groupOpen ? ' open' : ''}`}
                onClick={() => setGroupOpen((v) => !v)}
                title="切换同组页面"
              >
                {crumb.group.label}
                <span className="crumb-caret">▾</span>
              </button>
              {groupOpen ? (
                <div className="crumb-menu">
                  {crumb.siblings.map((c) => (
                    <button
                      key={c.to}
                      type="button"
                      className={`crumb-menu-item${matchChild(location.pathname, c) ? ' active' : ''}`}
                      onClick={() => {
                        setGroupOpen(false);
                        navigate(c.to);
                      }}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </>
        ) : null}
        {crumb.page ? (
          <>
            <span className="crumb-sep">/</span>
            {crumb.extra ? (
              <NavLink to={crumb.page.to} className="crumb link">
                {crumb.page.label}
              </NavLink>
            ) : (
              <span className="crumb current">{crumb.page.label}</span>
            )}
          </>
        ) : null}
        {crumb.extra ? (
          <>
            <span className="crumb-sep">/</span>
            <span className="crumb current">{crumb.extra}</span>
          </>
        ) : null}
      </nav>
      <AccountMenu />
    </header>
  );
}

function Shell() {
  return (
    <div className="layout">
      <Sidebar />
      <div className="main-wrap">
        <Topbar />
        <VisitedTabs />
        <main className="main">
          <Outlet />
        </main>
      </div>
      <ToastHost />
      <ConfirmHost />
    </div>
  );
}

function MenuRoute({ menu, element }: { menu: string; element: React.ReactNode }) {
  return <RequireMenu menu={menu}>{element}</RequireMenu>;
}

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <Shell />
            </RequireAuth>
          }
        >
          <Route index element={<MenuRoute menu="dashboard" element={<DashboardPage />} />} />
          <Route path="user-list" element={<MenuRoute menu="user_list" element={<UserListPage />} />} />
          <Route path="users" element={<MenuRoute menu="users" element={<UsersPage />} />} />
          <Route
            path="distribution"
            element={<MenuRoute menu="distribution" element={<DistributionPage />} />}
          />
          <Route
            path="distribution/rebate/:userId"
            element={<MenuRoute menu="distribution" element={<UserRebatePage />} />}
          />
          <Route path="trade" element={<Navigate to="/trade/config" replace />} />
          <Route
            path="trade/config"
            element={<MenuRoute menu="trade_config" element={<TradeConfigPage />} />}
          />
          <Route
            path="trade/templates"
            element={<MenuRoute menu="trade_templates" element={<FollowTemplatesPage />} />}
          />
          <Route
            path="trade/symbols"
            element={<MenuRoute menu="trade_symbols" element={<SymbolListPage />} />}
          />
          <Route
            path="trade/signals"
            element={<MenuRoute menu="trade_signals" element={<TradeSignalsPage />} />}
          />
          <Route
            path="trade/logs"
            element={<MenuRoute menu="trade_logs" element={<TradeLogsPage />} />}
          />
          <Route
            path="trade/order-logs"
            element={<MenuRoute menu="trade_order_logs" element={<TradeOrderLogsPage />} />}
          />
          <Route
            path="trade/positions"
            element={<MenuRoute menu="trade_positions" element={<PositionsPage />} />}
          />
          <Route
            path="trade/positions-compare"
            element={<MenuRoute menu="trade_positions" element={<PositionsComparePage />} />}
          />
          <Route
            path="trade/followers"
            element={<MenuRoute menu="trade_followers" element={<FollowersPage />} />}
          />
          <Route path="pointcard" element={<MenuRoute menu="pointcard" element={<PointCardPage />} />} />
          <Route path="recharges" element={<MenuRoute menu="recharges" element={<RechargesPage />} />} />
          <Route
            path="commission"
            element={<MenuRoute menu="commission" element={<CommissionPage />} />}
          />
          <Route
            path="commission-records"
            element={<MenuRoute menu="commission_records" element={<CommissionRecordsPage />} />}
          />
          <Route path="reconcile" element={<MenuRoute menu="reconcile" element={<ReconcilePage />} />} />
          <Route path="withdraws" element={<MenuRoute menu="withdraws" element={<WithdrawsPage />} />} />
          <Route path="wallet" element={<MenuRoute menu="wallet" element={<WalletPage />} />} />
          <Route
            path="collection-addresses"
            element={<MenuRoute menu="collection_addresses" element={<CollectionAddressesPage />} />}
          />
          <Route
            path="gas-wallets"
            element={<MenuRoute menu="gas_wallets" element={<GasWalletsPage />} />}
          />
          <Route
            path="collection-records"
            element={<MenuRoute menu="collection_records" element={<CollectionRecordsPage />} />}
          />
          <Route path="admins" element={<MenuRoute menu="admins" element={<AdminsPage />} />} />
          <Route path="roles" element={<MenuRoute menu="roles" element={<RolesPage />} />} />
          <Route
            path="proxy/config"
            element={<MenuRoute menu="proxy_config" element={<ProxyConfigPage />} />}
          />
          <Route path="ip-pool" element={<MenuRoute menu="ip_pool" element={<IpPoolPage />} />} />
          <Route
            path="middleware-logs"
            element={<MenuRoute menu="middleware_post_logs" element={<MiddlewarePostLogsPage />} />}
          />
          <Route
            path="keys-audit"
            element={<MenuRoute menu="keys_audit" element={<KeysAuditPage />} />}
          />
        </Route>
      </Routes>
      <SessionExpiredHost />
    </>
  );
}
