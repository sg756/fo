/** 管理后台菜单权限 key（与前端 NAV 对齐） */
export const ADMIN_MENU_KEYS = [
  'dashboard',
  'user_list',
  'users',
  'distribution',
  'keys_audit',
  'pointcard',
  'recharges',
  'commission',
  'commission_records',
  'reconcile',
  'withdraws',
  'wallet',
  'collection_addresses',
  'gas_wallets',
  'collection_records',
  'trade_config',
  'trade_templates',
  'trade_symbols',
  'trade_signals',
  'trade_logs',
  'trade_order_logs',
  'trade_positions',
  'trade_followers',
  'admins',
  'roles',
  'proxy_config',
  'ip_pool',
  'middleware_post_logs',
] as const;

export type AdminMenuKey = (typeof ADMIN_MENU_KEYS)[number];

export const ADMIN_MENU_LABELS: Record<AdminMenuKey, string> = {
  dashboard: '数据总览',
  user_list: '用户列表',
  users: '用户审核',
  distribution: '用户分销',
  keys_audit: 'Key 监管 / 审计',
  pointcard: '点卡管理',
  recharges: '链上充值',
  commission: '佣金分润',
  commission_records: '佣金记录',
  reconcile: '日对账',
  withdraws: '提现管理',
  wallet: '归集资金',
  collection_addresses: '归集地址',
  gas_wallets: '平台钱包',
  collection_records: '归集记录',
  trade_config: '跟单配置',
  trade_templates: '跟单模板',
  trade_symbols: '交易对规范',
  trade_signals: '跟单信号',
  trade_logs: '挂单列表',
  trade_order_logs: '挂单日志',
  trade_positions: '持仓列表',
  trade_followers: '跟单用户',
  admins: '管理员',
  roles: '角色权限',
  proxy_config: '代理配置',
  ip_pool: '代理列表',
  middleware_post_logs: '中间件日志',
};

export const ALL_ADMIN_MENUS: AdminMenuKey[] = [...ADMIN_MENU_KEYS];

export function normalizeMenus(raw: unknown): AdminMenuKey[] {
  if (!Array.isArray(raw)) return [];
  const set = new Set(ADMIN_MENU_KEYS);
  return raw.filter((m): m is AdminMenuKey => typeof m === 'string' && set.has(m as AdminMenuKey));
}
