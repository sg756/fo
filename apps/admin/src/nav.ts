export type NavChild = { to: string; label: string; menu: string; end?: boolean };
export type NavGroup = { key: string; label: string; icon: string; children: NavChild[] };

export const HOME_PATH = '/';
export const HOME_LABEL = '数据总览';
export const VISITED_TABS_KEY = 'admin.visitedTabs';

export const NAV_GROUPS: NavGroup[] = [
  {
    key: 'overview',
    label: '总览',
    icon: '🏠',
    children: [{ to: HOME_PATH, label: HOME_LABEL, menu: 'dashboard', end: true }],
  },
  {
    key: 'user',
    label: '用户管理',
    icon: '👥',
    children: [
      { to: '/user-list', label: '用户列表', menu: 'user_list' },
      { to: '/users', label: '用户审核', menu: 'users' },
      { to: '/distribution', label: '用户分销', menu: 'distribution' },
      { to: '/keys-audit', label: 'Key 监管 / 审计', menu: 'keys_audit' },
    ],
  },
  {
    key: 'fund',
    label: '资金管理',
    icon: '💰',
    children: [
      { to: '/pointcard', label: '点卡管理', menu: 'pointcard' },
      { to: '/recharges', label: '链上充值', menu: 'recharges' },
      { to: '/commission', label: '佣金分润', menu: 'commission' },
      { to: '/commission-records', label: '佣金记录', menu: 'commission_records' },
      { to: '/reconcile', label: '日对账', menu: 'reconcile' },
      { to: '/withdraws', label: '提现管理', menu: 'withdraws' },
      { to: '/wallet', label: '归集资金', menu: 'wallet' },
      { to: '/collection-addresses', label: '归集地址', menu: 'collection_addresses' },
      { to: '/gas-wallets', label: '平台钱包', menu: 'gas_wallets' },
      { to: '/collection-records', label: '归集/补Gas记录', menu: 'collection_records' },
    ],
  },
  {
    key: 'trade',
    label: '跟单管理',
    icon: '📈',
    children: [
      { to: '/trade/config', label: '跟单配置', menu: 'trade_config' },
      { to: '/trade/templates', label: '跟单模板', menu: 'trade_templates' },
      { to: '/trade/symbols', label: '交易对规范', menu: 'trade_symbols' },
      { to: '/trade/signals', label: '跟单信号', menu: 'trade_signals' },
      { to: '/trade/logs', label: '挂单列表', menu: 'trade_logs' },
      { to: '/trade/order-logs', label: '挂单日志', menu: 'trade_order_logs' },
      { to: '/trade/positions', label: '持仓列表', menu: 'trade_positions' },
      { to: '/trade/positions-compare', label: '持仓对比', menu: 'trade_positions' },
      { to: '/trade/followers', label: '跟单用户', menu: 'trade_followers' },
    ],
  },
  {
    key: 'proxy',
    label: '代理IP',
    icon: '🌐',
    children: [
      { to: '/proxy/config', label: '代理配置', menu: 'proxy_config' },
      { to: '/ip-pool', label: '代理列表', menu: 'ip_pool' },
    ],
  },
  {
    key: 'system',
    label: '系统配置',
    icon: '⚙️',
    children: [
      { to: '/admins', label: '管理员', menu: 'admins' },
      { to: '/roles', label: '角色权限', menu: 'roles' },
      { to: '/middleware-logs', label: '中间件日志', menu: 'middleware_post_logs' },
    ],
  },
];

export function matchChild(pathname: string, c: NavChild) {
  return c.end ? pathname === c.to : pathname === c.to || pathname.startsWith(c.to + '/');
}

/** 将路径解析为页签用的规范 path + 标题；无法识别则返回 null */
export function resolveVisitedTab(pathname: string): { path: string; label: string } | null {
  if (pathname.startsWith('/distribution/rebate/')) {
    return { path: pathname, label: '返利汇总' };
  }
  for (const g of NAV_GROUPS) {
    for (const c of g.children) {
      if (matchChild(pathname, c)) {
        return { path: c.to, label: c.label };
      }
    }
  }
  return null;
}

export type VisitedTab = { path: string; label: string };

export function defaultVisitedTabs(): VisitedTab[] {
  return [{ path: HOME_PATH, label: HOME_LABEL }];
}

export function loadVisitedTabs(): VisitedTab[] {
  try {
    const raw = sessionStorage.getItem(VISITED_TABS_KEY);
    if (!raw) return defaultVisitedTabs();
    const parsed = JSON.parse(raw) as VisitedTab[];
    if (!Array.isArray(parsed) || parsed.length === 0) return defaultVisitedTabs();
    const cleaned = parsed.filter(
      (t) => t && typeof t.path === 'string' && typeof t.label === 'string',
    );
    if (!cleaned.some((t) => t.path === HOME_PATH)) {
      return [{ path: HOME_PATH, label: HOME_LABEL }, ...cleaned];
    }
    return cleaned.map((t) =>
      t.path === HOME_PATH ? { path: HOME_PATH, label: HOME_LABEL } : t,
    );
  } catch {
    return defaultVisitedTabs();
  }
}

export function saveVisitedTabs(tabs: VisitedTab[]) {
  sessionStorage.setItem(VISITED_TABS_KEY, JSON.stringify(tabs));
}

export function clearVisitedTabs() {
  sessionStorage.removeItem(VISITED_TABS_KEY);
}

export const NAV_OPEN_KEY = 'admin.navOpen';

export function loadNavOpen(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(NAV_OPEN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'boolean') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveNavOpen(open: Record<string, boolean>) {
  localStorage.setItem(NAV_OPEN_KEY, JSON.stringify(open));
}
