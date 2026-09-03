const TOKEN_KEY = 'fo_admin_token';
const ME_KEY = 'fo_admin_me';
const CRED_KEY = 'fo_admin_remember';

export type AdminMe = {
  id: string;
  email: string;
  nickname?: string | null;
  role: string;
  menus?: string[];
  adminRole?: { id: string; code: string; name: string } | null;
  adminRoleId?: string | null;
  totpEnabled?: boolean;
};

export type RememberedCredentials = { email: string; password: string };

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ME_KEY);
  }
}

export function getAdminMe(): AdminMe | null {
  try {
    const raw = localStorage.getItem(ME_KEY);
    return raw ? (JSON.parse(raw) as AdminMe) : null;
  } catch {
    return null;
  }
}

export function setAdminMe(me: AdminMe | null) {
  if (me) localStorage.setItem(ME_KEY, JSON.stringify(me));
  else localStorage.removeItem(ME_KEY);
}

export function getAdminMenus(): string[] {
  return getAdminMe()?.menus || [];
}

export function getRememberedCredentials(): RememberedCredentials | null {
  try {
    const raw = localStorage.getItem(CRED_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as RememberedCredentials;
    if (!o?.email || !o?.password) return null;
    return { email: String(o.email), password: String(o.password) };
  } catch {
    return null;
  }
}

export function setRememberedCredentials(email: string, password: string) {
  localStorage.setItem(CRED_KEY, JSON.stringify({ email: email.trim(), password }));
}

export function clearRememberedCredentials() {
  localStorage.removeItem(CRED_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** 登录失效弹窗状态 */
export type SessionExpiredState = {
  open: boolean;
  hasRemembered: boolean;
  busy: boolean;
  error: string;
};

type SessionListener = (s: SessionExpiredState) => void;

const sessionListeners = new Set<SessionListener>();
let sessionState: SessionExpiredState = {
  open: false,
  hasRemembered: false,
  busy: false,
  error: '',
};
let sessionWaiters: { resolve: (recovered: boolean) => void }[] = [];
let recovering = false;

function emitSession() {
  for (const l of sessionListeners) l({ ...sessionState });
}

export function subscribeSessionExpired(listener: SessionListener) {
  sessionListeners.add(listener);
  listener({ ...sessionState });
  return () => {
    sessionListeners.delete(listener);
  };
}

function openSessionExpiredDialog(): Promise<boolean> {
  if (!sessionState.open) {
    sessionState = {
      open: true,
      hasRemembered: !!getRememberedCredentials(),
      busy: false,
      error: '',
    };
    emitSession();
  }
  return new Promise<boolean>((resolve) => {
    sessionWaiters.push({ resolve });
  });
}

function finishSession(recovered: boolean) {
  const waiters = sessionWaiters;
  sessionWaiters = [];
  sessionState = { open: false, hasRemembered: false, busy: false, error: '' };
  emitSession();
  for (const w of waiters) w.resolve(recovered);
}

/** 弹窗点「确定」：有记住凭据则带验证码重登，否则去登录页 */
export async function confirmSessionExpired(captcha?: {
  captchaId: string;
  captchaCode: string;
}) {
  if (sessionState.busy) return;
  const cred = getRememberedCredentials();
  if (cred) {
    if (!captcha?.captchaId || !captcha?.captchaCode?.trim()) {
      sessionState = { ...sessionState, busy: false, error: '请填写图形验证码' };
      emitSession();
      return;
    }
    sessionState = { ...sessionState, busy: true, error: '' };
    emitSession();
    try {
      const res = await AuthApi.login(cred.email, cred.password, captcha.captchaId, captcha.captchaCode);
      if (res.user?.role !== 'ADMIN') {
        throw new Error('该账号不是管理员');
      }
      setToken(res.accessToken);
      setAdminMe(res.user);
      finishSession(true);
    } catch (e: any) {
      sessionState = {
        ...sessionState,
        busy: false,
        error: e?.message || '自动登录失败，请前往登录页',
      };
      emitSession();
    }
    return;
  }
  setToken(null);
  finishSession(false);
  if (!window.location.pathname.startsWith('/login')) {
    window.location.assign('/login');
  }
}

/** 自动登录失败后，强制去登录页 */
export function goLoginAfterSessionExpired() {
  setToken(null);
  finishSession(false);
  window.location.assign('/login');
}

async function recoverSessionOnce(): Promise<boolean> {
  if (recovering) return openSessionExpiredDialog();
  recovering = true;
  try {
    return await openSessionExpiredDialog();
  } finally {
    recovering = false;
  }
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: any; auth?: boolean; _retried?: boolean } = {},
): Promise<T> {
  const { method = 'GET', body, auth = true, _retried = false } = opts;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) {
    const t = getToken();
    if (t) headers.Authorization = `Bearer ${t}`;
  }
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && auth && !_retried && path !== '/admin/auth/login') {
      const recovered = await recoverSessionOnce();
      if (recovered) {
        return api(path, { method, body, auth, _retried: true });
      }
    }
    const msg = data?.message || data?.error || `HTTP ${res.status}`;
    throw new ApiError(Array.isArray(msg) ? msg.join(', ') : String(msg), res.status);
  }
  return data as T;
}

export const AuthApi = {
  captcha: () =>
    api<{ id: string; image: string; expiresInSec: number }>('/admin/auth/captcha', {
      auth: false,
    }),
  login: (email: string, password: string, captchaId: string, captchaCode: string) =>
    api<{ accessToken: string; user: AdminMe }>('/admin/auth/login', {
      method: 'POST',
      body: { email, password, captchaId, captchaCode },
      auth: false,
    }),
  me: () => api<AdminMe>('/admin/auth/me'),
  totpStatus: () => api<{ enabled: boolean; boundAt?: string | null }>('/admin/auth/totp/status'),
  totpSetup: () =>
    api<{
      secret: string;
      otpauthUrl: string;
      issuer: string;
      account: string;
      expiresInSec: number;
    }>('/admin/auth/totp/setup', { method: 'POST', body: {} }),
  totpConfirm: (code: string) =>
    api<{ ok: boolean; enabled: boolean }>('/admin/auth/totp/confirm', {
      method: 'POST',
      body: { code },
    }),
  totpDisable: (code: string) =>
    api<{ ok: boolean; enabled: boolean }>('/admin/auth/totp/disable', {
      method: 'POST',
      body: { code },
    }),
};

export const AdminApi = {
  summary: () => api('/admin/dashboard/summary'),
  users: (params?: {
    q?: string;
    status?: string;
    userNo?: string;
    account?: string;
    from?: string;
    to?: string;
    skip?: number;
    take?: number;
  }) => {
    const p = new URLSearchParams();
    if (params?.q) p.set('q', params.q);
    if (params?.status) p.set('status', params.status);
    if (params?.userNo) p.set('userNo', params.userNo);
    if (params?.account) p.set('account', params.account);
    if (params?.from) p.set('from', params.from);
    if (params?.to) p.set('to', params.to);
    if (params?.skip != null) p.set('skip', String(params.skip));
    if (params?.take != null) p.set('take', String(params.take));
    const qs = p.toString();
    return api<{ items: any[]; total: number }>(`/admin/users${qs ? `?${qs}` : ''}`);
  },
  distributionTree: (q?: string) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    const qs = p.toString();
    return api<{
      summary: { total: number; user: number; roots: number; noParent: number };
      roots: any[];
    }>(`/admin/users/distribution-tree${qs ? `?${qs}` : ''}`);
  },
  approveUser: (id: string) => api(`/admin/users/${id}/approve`, { method: 'POST', body: {} }),
  rejectUser: (id: string, reason?: string) =>
    api(`/admin/users/${id}/reject`, { method: 'POST', body: { reason } }),
  disableUser: (id: string) => api(`/admin/users/${id}/disable`, { method: 'POST', body: {} }),
  enableUser: (id: string) => api(`/admin/users/${id}/enable`, { method: 'POST', body: {} }),
  userDetail: (id: string) => api(`/admin/users/${id}`),
  /** 用户交易所资产（按需查中间件） */
  userExchangeBalances: (userId: string) => api(`/admin/trade/users/${userId}/balances`),
  rebindUser: (id: string, parentInviteCode: string) =>
    api(`/admin/users/${id}/rebind`, { method: 'POST', body: { parentInviteCode } }),
  /** 后台代改用户资料（账号名/密码/状态/直推/关跟单/点卡等） */
  updateUser: (
    id: string,
    body: {
      nickname?: string;
      password?: string;
      status?: 'ACTIVE' | 'DISABLED';
      parentInviteCode?: string;
      followEnabled?: boolean;
      clearTradePassword?: boolean;
      pointAdjustAmount?: number;
      pointAdjustRemark?: string;
    },
  ) => api(`/admin/users/${id}/update`, { method: 'POST', body }),
  /** 管理员单独列表（与普通用户分开） */
  admins: (q?: string) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    return api<{ items: any[]; total: number }>(`/admin/admins?${p}`);
  },
  createAdmin: (body: {
    account: string;
    password: string;
    nickname?: string;
    adminRoleId?: string;
  }) => api('/admin/admins', { method: 'POST', body }),
  setAdminRole: (id: string, adminRoleId: string) =>
    api(`/admin/admins/${id}/role`, { method: 'POST', body: { adminRoleId } }),
  disableAdmin: (id: string) => api(`/admin/admins/${id}/disable`, { method: 'POST', body: {} }),

  menuCatalog: () => api<{ items: { key: string; label: string }[] }>('/admin/roles/menu-catalog'),
  roles: () =>
    api<{ items: any[] }>('/admin/roles'),
  saveRole: (body: {
    id?: string;
    code: string;
    name: string;
    menus: string[];
    description?: string;
  }) => api('/admin/roles', { method: 'POST', body }),
  deleteRole: (id: string) => api(`/admin/roles/${id}`, { method: 'DELETE' }),

  followerConfig: () => api('/admin/trade/follower/config'),
  setSignalTimeout: (ms: number) =>
    api('/admin/trade/follower/signal-timeout', { method: 'POST', body: { ms } }),
  setPollMs: (ms: number) => api('/admin/trade/follower/poll-ms', { method: 'POST', body: { ms } }),
  setOrderExpire: (seconds: number) =>
    api('/admin/trade/follower/order-expire', { method: 'POST', body: { seconds } }),
  setChaseOnExpire: (enabled: boolean) =>
    api('/admin/trade/follower/chase-on-expire', { method: 'POST', body: { enabled } }),
  setFollowHalted: (halted: boolean) =>
    api('/admin/trade/follower/follow-halted', { method: 'POST', body: { halted } }),
  setOpenMinPoint: (amount: number) =>
    api('/admin/trade/follower/open-min-point', { method: 'POST', body: { amount } }),
  setQueryPositionInterval: (minutes: number) =>
    api('/admin/trade/follower/query-position-interval', {
      method: 'POST',
      body: { minutes },
    }),
  enqueueQueryPositionSync: (body?: { userId?: string; exchange?: string }) =>
    api<{
      ok: boolean;
      queued: number;
      alreadyQueued: number;
      cooldown: number;
      noOpen: number;
    }>('/admin/trade/positions/query-position-sync', {
      method: 'POST',
      body: body || {},
    }),
  followTemplates: () =>
    api<{ items: any[]; total: number }>('/admin/trade/follow-templates'),
  saveFollowTemplate: (body: {
    id?: string;
    name: string;
    exchange: string;
    accountGid: string;
    accountName?: string;
    unitAmount: number;
    maxPrincipal: number;
    minInvestAmount?: number;
    active?: boolean;
    remark?: string;
  }) => api('/admin/trade/follow-templates', { method: 'POST', body }),
  deleteFollowTemplate: (id: string) =>
    api(`/admin/trade/follow-templates/${id}`, { method: 'DELETE' }),
  followLogs: (params?: {
    status?: string;
    exchange?: string;
    symbol?: string;
    coinName?: string;
    period?: string;
    accountGid?: string;
    q?: string;
    userId?: string;
    recordId?: string;
    orderId?: string;
    cancelReason?: string;
    abnormalKind?: string;
    fillKind?: string;
    skip?: number;
    take?: number;
  }) => {
    const p = new URLSearchParams();
    if (params?.status) p.set('status', params.status);
    if (params?.exchange) p.set('exchange', params.exchange);
    if (params?.symbol) p.set('symbol', params.symbol);
    if (params?.coinName) p.set('coinName', params.coinName);
    if (params?.period) p.set('period', params.period);
    if (params?.accountGid) p.set('accountGid', params.accountGid);
    if (params?.q) p.set('q', params.q);
    if (params?.userId) p.set('userId', params.userId);
    if (params?.recordId) p.set('recordId', params.recordId);
    if (params?.orderId) p.set('orderId', params.orderId);
    if (params?.cancelReason) p.set('cancelReason', params.cancelReason);
    if (params?.abnormalKind) p.set('abnormalKind', params.abnormalKind);
    if (params?.fillKind) p.set('fillKind', params.fillKind);
    if (params?.skip != null) p.set('skip', String(params.skip));
    p.set('take', String(params?.take ?? 20));
    return api<{ items: any[]; total: number }>(`/admin/trade/follow-logs?${p}`);
  },
  followLogStats: () => api('/admin/trade/follow-logs/stats'),
  purgeFollowLogs: (body: {
    mode: 'all' | 'range' | 'ids';
    from?: string;
    to?: string;
    ids?: string[];
  }) =>
    api<{ ok: boolean; deleted: number }>('/admin/trade/follow-logs/purge', {
      method: 'POST',
      body,
    }),
  followers: (params?: {
    exchange?: string;
    q?: string;
    userId?: string;
    readyOnly?: boolean;
  }) => {
    const p = new URLSearchParams();
    if (params?.exchange) p.set('exchange', params.exchange);
    if (params?.q) p.set('q', params.q);
    if (params?.userId) p.set('userId', params.userId);
    if (params?.readyOnly != null) p.set('readyOnly', params.readyOnly ? '1' : '0');
    const qs = p.toString();
    return api<{
      items: any[];
      total: number;
      openMinPointBalance: number;
      readyOnly: boolean;
    }>(`/admin/trade/followers${qs ? `?${qs}` : ''}`);
  },
  /** 管理端持仓列表（本地 user_positions；status=OPEN|CLOSED；
   * OPEN: abnormal=true 仅异常仓；
   * CLOSED: closedKind=all|partial|full|discard） */
  positions: (params?: {
    userId?: string;
    q?: string;
    exchange?: string;
    coinName?: string;
    period?: string;
    accountGid?: string;
    status?: 'OPEN' | 'CLOSED';
    abnormal?: boolean | 'all';
    closedKind?: 'all' | 'partial' | 'full' | 'discard';
    recordId?: string;
    from?: string;
    to?: string;
  }) => {
    const p = new URLSearchParams();
    if (params?.userId) p.set('userId', params.userId);
    if (params?.q) p.set('q', params.q);
    if (params?.exchange) p.set('exchange', params.exchange);
    if (params?.coinName) p.set('coinName', params.coinName);
    if (params?.period) p.set('period', params.period);
    if (params?.accountGid) p.set('accountGid', params.accountGid);
    if (params?.status) p.set('status', params.status);
    if (params?.closedKind) p.set('closedKind', params.closedKind);
    if (params?.recordId) p.set('recordId', params.recordId);
    if (params?.abnormal === true) p.set('abnormal', 'true');
    else if (params?.abnormal === false) p.set('abnormal', 'false');
    else if (params?.abnormal === 'all') p.set('abnormal', 'all');
    if (params?.from) p.set('from', params.from);
    if (params?.to) p.set('to', params.to);
    const qs = p.toString();
    return api<{
      items: any[];
      errors: any[];
      scannedUsers: number;
      total: number;
      status?: string;
    }>(`/admin/trade/positions${qs ? `?${qs}` : ''}`);
  },
  /** 点币名按需：订单号 + 最近跟单摘要 */
  positionFollowDetail: (params: {
    userId: string;
    exchange: string;
    coinName: string;
    equalCoinName?: string;
    positionSide?: string;
  }) => {
    const p = new URLSearchParams();
    p.set('userId', params.userId);
    p.set('exchange', params.exchange);
    p.set('coinName', params.coinName);
    if (params.equalCoinName) p.set('equalCoinName', params.equalCoinName);
    if (params.positionSide) p.set('positionSide', params.positionSide);
    return api<{
      orderId: string | null;
      orderIds: string[];
      lastFollowSignal: any | null;
    }>(`/admin/trade/positions/follow-detail?${p}`);
  },
  /** 账户列表持仓 vs 本地 OPEN 只读对比 */
  positionsCompare: (params: {
    accountGid: string;
    match?: string;
    userId?: string;
    q?: string;
    exchange?: string;
    coinName?: string;
  }) => {
    const p = new URLSearchParams();
    p.set('accountGid', params.accountGid);
    if (params.match) p.set('match', params.match);
    if (params.userId) p.set('userId', params.userId);
    if (params.q) p.set('q', params.q);
    if (params.exchange) p.set('exchange', params.exchange);
    if (params.coinName) p.set('coinName', params.coinName);
    return api<{
      accountGid: string;
      signalError?: string | null;
      summary: {
        both: number;
        localOnly: number;
        liveOnly: number;
        signalRows: number;
        localRows: number;
      };
      items: any[];
      total: number;
    }>(`/admin/trade/positions/compare?${p}`);
  },
  /** 管理端手动市价平仓（运营兜底；日常靠信号自动平） */
  closePosition: (body: {
    userId: string;
    exchange: string;
    coinName: string;
    positionSide: string;
    amount: number | string;
    equalCoinName?: string;
    symbol?: string;
    accountType?: string;
    accountGid?: string;
    accountName?: string;
    leverage?: number | string;
  }) => api('/admin/trade/positions/close', { method: 'POST', body }),
  /** 仅清除本地 OPEN 持仓（不打交易所；用于脏数据） */
  discardLocalPositions: (ids: string[]) =>
    api<{
      ok: boolean;
      requested: number;
      discarded: number;
      skippedNonAbnormal?: number;
    }>('/admin/trade/positions/discard-local', {
      method: 'POST',
      body: { ids },
    }),
  followerSignals: () => api('/admin/trade/follower/signals'),
  runOnce: () => api('/admin/trade/follower/run-once', { method: 'POST', body: {} }),
  syncFills: () => api('/admin/trade/follower/sync-fills', { method: 'POST', body: {} }),
  cancelExpired: () => api('/admin/trade/follower/cancel-expired', { method: 'POST', body: {} }),
  /** 同步用户交易所挂单到本地挂单列表（需 userId；目前 BINANCE U 本位） */
  syncExchangeOpenOrders: (body: { userId: string; exchange?: string }) =>
    api<{
      exchange: string;
      market?: string;
      userId: string;
      exchangeOpen: number;
      created: number;
      updated: number;
      skipped: number;
      closed: number;
      imported: number;
    }>('/admin/trade/follower/sync-exchange-open-orders', { method: 'POST', body }),
  /** 单笔/勾选立即撤单（PLACED / CANCEL_FAILED） */
  cancelOrders: (ids: string[]) =>
    api<{
      total: number;
      cancelled: number;
      filled: number;
      failed: number;
      items: any[];
    }>('/admin/trade/follower/cancel-orders', { method: 'POST', body: { ids } }),
  /** 手动撤单测试：交易所 + 交易所订单号 → CancelOrder */
  cancelByOrderId: (body: {
    exchange: string;
    orderId: string;
    userId?: string;
    coinName?: string;
    equalCoinName?: string;
    accountType?: string;
  }) =>
    api<{
      ok: boolean;
      filled?: boolean;
      recorded?: boolean;
      message?: string;
      orderId: string;
      exchange: string;
      userId: string;
      coinName: string;
      equalCoinName: string;
      logId?: string | null;
    }>('/admin/trade/follower/cancel-by-order-id', { method: 'POST', body }),
  /** 拉取用户交易所当前挂单（币安 U 本位），拿订单号做撤单测试 */
  exchangeOpenOrders: (params: { userId: string; exchange?: string }) => {
    const q = new URLSearchParams();
    q.set('userId', params.userId);
    if (params.exchange) q.set('exchange', params.exchange);
    return api<{
      exchange: string;
      market: string;
      userId: string;
      total: number;
      items: Array<{
        orderId: string;
        clientOrderId?: string | null;
        symbol: string;
        coinName: string;
        side: string;
        positionSide: string;
        type: string;
        price: string;
        origQty: string;
        status: string;
        time?: string | null;
      }>;
    }>(`/admin/trade/exchange-open-orders?${q}`);
  },
  /** 批量重试 CANCEL_FAILED；ids 空则处理全部（服务端默认最多 50） */
  retryCancelFailed: (body?: { ids?: string[]; take?: number }) =>
    api<{
      total: number;
      cancelled: number;
      filled: number;
      failed: number;
      items: any[];
    }>('/admin/trade/follower/retry-cancel-failed', { method: 'POST', body: body || {} }),

  // :1820 中间件文档接口
  middlewareConfig: () =>
    api<{
      base: string;
      fromDb: boolean;
      envDefault: string;
      serviceKeyMasked: string;
      serviceKeyConfigured: boolean;
      serviceKeyFromDb: boolean;
      accountGid: string | null;
      accountName: string | null;
      accountGidFromDb: boolean;
    }>('/admin/trade/middleware/config'),
  setMiddlewareConfig: (body: {
    base: string;
    serviceKey?: string;
    accountGid?: string;
    accountName?: string;
  }) =>
    api<{
      base: string;
      fromDb: boolean;
      envDefault: string;
      serviceKeyMasked: string;
      serviceKeyConfigured: boolean;
      serviceKeyFromDb: boolean;
      accountGid: string | null;
      accountName: string | null;
      accountGidFromDb: boolean;
    }>('/admin/trade/middleware/config', { method: 'POST', body }),
  middlewareAccounts: (force?: boolean) =>
    api<{ items: any[] }>(`/admin/trade/middleware/accounts${force ? '?force=1' : ''}`),
  middlewareSymbols: (force?: boolean) =>
    api<{
      count: number;
      fetchedAt: string | null;
      ttlMs: number;
      refreshMs?: number;
      refreshed?: boolean;
      error?: string | null;
      items: any[];
    }>(`/admin/trade/middleware/symbols${force ? '?force=1' : ''}`),
  middlewareProxies: () =>
    api<{ items: { ip: string; name: string }[] }>('/admin/trade/middleware/proxies'),

  withdraws: (params?: {
    status?: string;
    userNo?: string;
    account?: string;
    from?: string;
    to?: string;
    skip?: number;
    take?: number;
  }) => {
    const p = new URLSearchParams();
    if (params?.status) p.set('status', params.status);
    if (params?.userNo) p.set('userNo', params.userNo);
    if (params?.account) p.set('account', params.account);
    if (params?.from) p.set('from', params.from);
    if (params?.to) p.set('to', params.to);
    if (params?.skip != null) p.set('skip', String(params.skip));
    if (params?.take != null) p.set('take', String(params.take));
    const qs = p.toString();
    return api<{ items: any[]; total: number }>(`/admin/withdraws${qs ? `?${qs}` : ''}`);
  },
  approveWithdraw: (id: string) => api(`/admin/withdraws/${id}/approve`, { method: 'POST', body: {} }),
  rejectWithdraw: (id: string, remark?: string) =>
    api(`/admin/withdraws/${id}/reject`, { method: 'POST', body: { remark } }),
  releaseWithdraw: (id: string, txHash: string) =>
    api(`/admin/withdraws/${id}/release`, { method: 'POST', body: { txHash } }),
  settleWithdraw: (id: string, txHash: string, remark?: string) =>
    api(`/admin/withdraws/${id}/settle`, { method: 'POST', body: { txHash, remark } }),
  payoutWithdraw: (id: string) => api(`/admin/withdraws/${id}/payout`, { method: 'POST', body: {} }),
  withdrawConfig: () => api<{ minWithdrawAmount: number }>('/admin/withdraws/config'),
  setWithdrawMinAmount: (amount: number) =>
    api<{ minWithdrawAmount: number }>('/admin/withdraws/config/min-amount', {
      method: 'POST',
      body: { amount },
    }),

  collectionConfigs: () => api('/admin/wallet/collection-config'),
  saveCollectionConfig: (body: any) =>
    api('/admin/wallet/collection-config', { method: 'POST', body }),
  collectionAddresses: (chain?: string, opts?: { withBalance?: boolean }) => {
    const p = new URLSearchParams();
    if (chain) p.set('chain', chain);
    if (opts?.withBalance) p.set('withBalance', '1');
    const qs = p.toString();
    return api<any[]>(`/admin/wallet/collection-addresses${qs ? `?${qs}` : ''}`);
  },
  addCollectionAddress: (body: { chain?: string; address: string; label?: string }) =>
    api('/admin/wallet/collection-addresses', { method: 'POST', body }),
  updateCollectionAddress: (id: string, body: { address?: string; label?: string }) =>
    api(`/admin/wallet/collection-addresses/${id}/update`, { method: 'POST', body }),
  deleteCollectionAddress: (id: string) =>
    api(`/admin/wallet/collection-addresses/${id}`, { method: 'DELETE', body: {} }),
  selectCollectionAddress: (id: string, body?: { threshold?: number }) =>
    api(`/admin/wallet/collection-addresses/${id}/select`, { method: 'POST', body: body || {} }),
  saveCollectionGasWallet: (body: { chain?: string; gasAddress: string; privateKey: string }) =>
    api('/admin/wallet/collection-gas-wallet', { method: 'POST', body }),
  collectionGasWallets: (chain?: string, opts?: { withBalance?: boolean; discarded?: boolean }) => {
    const p = new URLSearchParams();
    if (chain) p.set('chain', chain);
    if (opts?.withBalance) p.set('withBalance', '1');
    if (opts?.discarded) p.set('discarded', '1');
    const qs = p.toString();
    return api<any[]>(`/admin/wallet/collection-gas-wallets${qs ? `?${qs}` : ''}`);
  },
  addCollectionGasWallet: (body: {
    chain?: string;
    gasAddress: string;
    privateKey: string;
    label?: string;
    setActive?: boolean;
  }) => api('/admin/wallet/collection-gas-wallets', { method: 'POST', body }),
  createCollectionGasWallet: (body?: { chain?: string; label?: string; setActive?: boolean }) =>
    api<{
      id: string;
      chain: string;
      address: string;
      label?: string | null;
      privateKey: string;
    }>('/admin/wallet/collection-gas-wallets/create', { method: 'POST', body: body || {} }),
  revealCollectionGasWalletKey: (id: string) =>
    api<{ id: string; chain: string; address: string; label?: string | null; privateKey: string }>(
      `/admin/wallet/collection-gas-wallets/${id}/reveal-key`,
      { method: 'POST', body: {} },
    ),
  updateCollectionGasWallet: (
    id: string,
    body: { address?: string; label?: string; privateKey?: string },
  ) => api(`/admin/wallet/collection-gas-wallets/${id}/update`, { method: 'POST', body }),
  deleteCollectionGasWallet: (id: string) =>
    api(`/admin/wallet/collection-gas-wallets/${id}`, { method: 'DELETE', body: {} }),
  restoreCollectionGasWallet: (id: string) =>
    api(`/admin/wallet/collection-gas-wallets/${id}/restore`, { method: 'POST', body: {} }),
  purgeCollectionGasWallet: (id: string) =>
    api(`/admin/wallet/collection-gas-wallets/${id}/purge`, { method: 'POST', body: {} }),
  selectCollectionGasWallet: (id: string) =>
    api(`/admin/wallet/collection-gas-wallets/${id}/select`, { method: 'POST', body: {} }),
  selectCollectionGasWalletAsTarget: (id: string) =>
    api(`/admin/wallet/collection-gas-wallets/${id}/select-collection`, { method: 'POST', body: {} }),
  transferCollectionGasWallet: (
    id: string,
    body: { token: 'USDT' | 'ETH'; toAddress: string; amount: number; totpCode: string },
  ) => api(`/admin/wallet/collection-gas-wallets/${id}/transfer`, { method: 'POST', body }),
  fundCollectionGas: (body?: { chain?: string; walletIds?: string[] }) =>
    api('/admin/wallet/collection/fund-gas', { method: 'POST', body: body || {} }),
  collectionGasFeeTier: () =>
    api<{ gasFeeTier: 'standard' | 'fast' }>('/admin/wallet/collection/gas-fee-tier'),
  collectionGasFeePreview: (chain?: string) => {
    const qs = chain ? `?chain=${encodeURIComponent(chain)}` : '';
    return api<{
      chain: string;
      gasLimit: number;
      bufferPct: number;
      tiers: Record<'standard' | 'fast', { ethPerTx: number; gwei: number }>;
    }>(`/admin/wallet/collection/gas-fee-preview${qs}`);
  },
  saveCollectionGasFeeTier: (tier: 'standard' | 'fast') =>
    api<{ gasFeeTier: 'standard' | 'fast' }>('/admin/wallet/collection/gas-fee-tier', {
      method: 'POST',
      body: { tier },
    }),
  collectionRecords: (params?: {
    userNo?: string;
    account?: string;
    from?: string;
    to?: string;
    status?: string;
    token?: string;
    skip?: number;
    take?: number;
  }) => {
    const p = new URLSearchParams();
    if (params?.userNo) p.set('userNo', params.userNo);
    if (params?.account) p.set('account', params.account);
    if (params?.from) p.set('from', params.from);
    if (params?.to) p.set('to', params.to);
    if (params?.status) p.set('status', params.status);
    if (params?.token) p.set('token', params.token);
    if (params?.skip != null) p.set('skip', String(params.skip));
    if (params?.take != null) p.set('take', String(params.take));
    const qs = p.toString();
    return api<{ items: any[]; total: number }>(
      `/admin/wallet/collection-records${qs ? `?${qs}` : ''}`,
    );
  },
  collectionStatus: () => api('/admin/wallet/collection/status'),
  runCollection: (chain?: string) =>
    api('/admin/wallet/collection/run', { method: 'POST', body: { chain } }),
  walletsWithBalance: (
    chain?: string,
    q?: string,
    opts?: { skip?: number; take?: number; filter?: string },
  ) => {
    const p = new URLSearchParams();
    p.set('withBalance', '1');
    if (chain) p.set('chain', chain);
    if (q) p.set('q', q);
    if (opts?.filter) p.set('filter', opts.filter);
    if (opts?.skip != null) p.set('skip', String(opts.skip));
    if (opts?.take != null) p.set('take', String(opts.take));
    return api<{ items: any[]; total: number; summary?: any; targetAddress?: string }>(
      `/admin/wallet/wallets?${p}`,
    );
  },

  pointCards: (params?: {
    q?: string;
    userNo?: string;
    account?: string;
    from?: string;
    to?: string;
    skip?: number;
    take?: number;
  }) => {
    const p = new URLSearchParams();
    if (params?.q) p.set('q', params.q);
    if (params?.userNo) p.set('userNo', params.userNo);
    if (params?.account) p.set('account', params.account);
    if (params?.from) p.set('from', params.from);
    if (params?.to) p.set('to', params.to);
    if (params?.skip != null) p.set('skip', String(params.skip));
    p.set('take', String(params?.take ?? 20));
    return api<{ items: any[]; total: number }>(`/admin/pointcard/cards?${p}`);
  },
  pointTxs: (params?: {
    userId?: string;
    userNo?: string;
    account?: string;
    type?: string;
    from?: string;
    to?: string;
    skip?: number;
    take?: number;
  }) => {
    const p = new URLSearchParams();
    if (params?.userId) p.set('userId', params.userId);
    if (params?.userNo) p.set('userNo', params.userNo);
    if (params?.account) p.set('account', params.account);
    if (params?.type) p.set('type', params.type);
    if (params?.from) p.set('from', params.from);
    if (params?.to) p.set('to', params.to);
    if (params?.skip != null) p.set('skip', String(params.skip));
    p.set('take', String(params?.take ?? 20));
    return api<{
      items: any[];
      total: number;
      summary: { count: number; total: string; increase: string; decrease: string };
    }>(`/admin/pointcard/txs?${p}`);
  },
  adjustPointCard: (userId: string, amount: number, remark: string) =>
    api('/admin/pointcard/adjust', { method: 'POST', body: { userId, amount, remark } }),

  recharges: (params?: {
    status?: string;
    userId?: string;
    userNo?: string;
    account?: string;
    from?: string;
    to?: string;
    skip?: number;
    take?: number;
  }) => {
    const p = new URLSearchParams();
    if (params?.status) p.set('status', params.status);
    if (params?.userId) p.set('userId', params.userId);
    if (params?.userNo) p.set('userNo', params.userNo);
    if (params?.account) p.set('account', params.account);
    if (params?.from) p.set('from', params.from);
    if (params?.to) p.set('to', params.to);
    if (params?.skip != null) p.set('skip', String(params.skip));
    p.set('take', String(params?.take ?? 20));
    return api<{
      items: any[];
      total: number;
      summary: { count: number; total: string; creditedCount: number; creditedTotal: string };
    }>(`/admin/pointcard/recharges?${p}`);
  },
  creditRecharge: (id: string) =>
    api(`/admin/pointcard/recharges/${id}/credit`, { method: 'POST', body: {} }),

  /** 手动充值：写充值单 + RECHARGE 流水（与调账 ADJUST 不同） */
  manualRecharge: (body: {
    userId?: string;
    userNo?: string;
    account?: string;
    amount: number;
    remark: string;
    txHash?: string;
    chain?: string;
  }) => api('/admin/pointcard/recharges/manual', { method: 'POST', body }),

  depositScan: (chain?: string) => {
    const qs = chain ? `?chain=${chain}` : '';
    return api(`/admin/deposit/scan${qs}`, { method: 'POST', body: {} });
  },

  commissionRules: () => api<any[]>('/admin/commission/rules'),
  saveCommissionRule: (body: {
    id?: string;
    name?: string;
    extractRate: number;
    l1Rate: number;
    l2Rate: number;
    platformRate: number;
    active?: boolean;
  }) => api('/admin/commission/rules', { method: 'POST', body }),
  activateCommissionRule: (id: string) =>
    api(`/admin/commission/rules/${id}/activate`, { method: 'POST', body: {} }),
  deleteCommissionRule: (id: string) =>
    api(`/admin/commission/rules/${id}`, { method: 'DELETE' }),
  commissionRecords: (
    params?:
      | string
      | {
          earnerId?: string;
          earner?: string;
          fromUser?: string;
          from?: string;
          to?: string;
          skip?: number;
          take?: number;
        },
    take = 100,
  ) => {
    const p = new URLSearchParams();
    if (typeof params === 'string') {
      p.set('earnerId', params);
      p.set('take', String(take));
    } else {
      if (params?.earnerId) p.set('earnerId', params.earnerId);
      if (params?.earner) p.set('earner', params.earner);
      if (params?.fromUser) p.set('fromUser', params.fromUser);
      if (params?.from) p.set('from', params.from);
      if (params?.to) p.set('to', params.to);
      if (params?.skip != null) p.set('skip', String(params.skip));
      p.set('take', String(params?.take ?? take));
    }
    return api<{
      items: any[];
      total: number;
      summary: {
        count: number;
        amount: string;
        profitSum?: string;
        byLevel: Record<string, { count: number; amount: string }>;
      };
    }>(`/admin/commission/records?${p}`);
  },
  commissionRecordSource: (id: string) =>
    api<{
      commission: {
        id: string;
        level: string;
        rate: string;
        amount: string;
        createdAt: string;
        earner: { id: string; email: string; nickname?: string | null; userNo?: number | null };
        fromUser: { id: string; email: string; nickname?: string | null; userNo?: number | null };
      };
      profit: {
        id: string;
        userId: string;
        exchange: string;
        symbol: string;
        profit: string;
        closedAt: string;
        orderId: string | null;
        signalKey: string | null;
        source: string;
        settled: boolean;
        createdAt: string;
      };
      closeLog: {
        id: string;
        status: string;
        fillKind: string | null;
        orderId: string | null;
        orderGid: string | null;
        signalKey: string | null;
        coinName: string | null;
        equalCoinName: string | null;
        positionSide: string | null;
        filledAmt: string | null;
        consumedAmt: string | null;
        avgPrice: string | null;
        tradeFee: string | null;
        createdAt: string;
        accountGid: string | null;
        accountName: string | null;
      } | null;
      openLots: Array<{
        id: string;
        status: string;
        orderId: string | null;
        coinName: string | null;
        filledAmt: string | null;
        consumedAmt: string | null;
        avgPrice: string | null;
        profitConsumed: boolean;
        createdAt: string;
      }>;
      traceHint: string | null;
    }>(`/admin/commission/records/${id}/source`),
  commissionDailySummary: (earnerId: string, days = 90) => {
    const p = new URLSearchParams();
    p.set('earnerId', earnerId);
    p.set('days', String(days));
    return api<{
      earnerId: string;
      days: number;
      items: Array<{
        day: string;
        count: number;
        amount: number;
        direct: number;
        indirect: number;
        platform: number;
      }>;
      total: { count: number; amount: number };
    }>(`/admin/commission/daily-summary?${p}`);
  },
  settleCommission: () => api('/admin/commission/settle', { method: 'POST', body: {} }),
  /** 单日对账: 利润 ↔ SHARE_DEDUCT ↔ 佣金 */
  reconcileDay: (date?: string, user?: string) => {
    const p = new URLSearchParams();
    if (date) p.set('date', date);
    if (user) p.set('user', user);
    const qs = p.toString();
    return api<{ day: string; summary: any; issues: any[]; rows: any[] }>(
      `/admin/commission/reconcile${qs ? `?${qs}` : ''}`,
    );
  },
  reconcileRecent: (opts?: { days?: number; from?: string; to?: string; user?: string }) => {
    const p = new URLSearchParams();
    if (opts?.from) p.set('from', opts.from);
    if (opts?.to) p.set('to', opts.to);
    if (opts?.days != null && !opts?.from && !opts?.to) p.set('days', String(opts.days));
    if (opts?.user) p.set('user', opts.user);
    const qs = p.toString();
    return api<{ days: number; from?: string; to?: string; items: any[] }>(
      `/admin/commission/reconcile/recent${qs ? `?${qs}` : ''}`,
    );
  },
  manualProfit: (body: {
    userId: string;
    exchange: string;
    symbol: string;
    profit: number;
    orderId?: string;
    signalKey?: string;
  }) => api('/admin/trade/profit/manual', { method: 'POST', body }),
  previewPnl: (body: {
    positionSide: string;
    openAvg: number;
    closeAvg: number;
    qty: number;
    openFee?: number;
    closeFee?: number;
    multiplier?: number;
  }) =>
    api<{ side: string; gross: number; fee: number; profit: number; multiplier: number }>(
      '/admin/trade/profit/preview',
      { method: 'POST', body },
    ),

  ipPool: (opts?: { force?: boolean }) =>
    api<{
      items: any[];
      syncError?: string | null;
      syncErrorBody?: any;
      syncErrorStatus?: number | null;
    } | any[]>(`/admin/ip-pool${opts?.force ? '?force=1' : ''}`).then((r) => {
      if (Array.isArray(r)) {
        return {
          items: r,
          syncError: null as string | null,
          syncErrorBody: null as any,
          syncErrorStatus: null as number | null,
        };
      }
      return {
        items: Array.isArray(r?.items) ? r.items : [],
        syncError: r?.syncError ?? null,
        syncErrorBody: r?.syncErrorBody ?? null,
        syncErrorStatus: r?.syncErrorStatus ?? null,
      };
    }),
  ipPoolCapacity: () =>
    api<{
      healthyProxies: number;
      usersPerProxy: number;
      capacity: number;
      occupied: number;
      remaining: number;
      full: boolean;
      nearFull: boolean;
      message: string | null;
      syncError?: string | null;
      syncErrorBody?: any;
      syncErrorStatus?: number | null;
    }>('/admin/ip-pool/capacity'),
  ipPoolConfig: () =>
    api<{ usersPerProxy: number; idleNoFillDays: number; idleFollowOffDays: number }>(
      '/admin/ip-pool/config',
    ),
  setIpPoolConfig: (body: {
    usersPerProxy?: number;
    idleNoFillDays?: number;
    idleFollowOffDays?: number;
  }) => api('/admin/ip-pool/config', { method: 'POST', body }),
  reclaimIdleProxies: () =>
    api<{ reclaimed: number; details: any[] }>('/admin/ip-pool/reclaim-idle', {
      method: 'POST',
      body: {},
    }),
  ipPoolReclaims: (params?: {
    status?: string;
    userId?: string;
    userNo?: string;
    account?: string;
    from?: string;
    to?: string;
    skip?: number;
    take?: number;
  }) => {
    const p = new URLSearchParams();
    if (params?.status) p.set('status', params.status);
    if (params?.userId) p.set('userId', params.userId);
    if (params?.userNo) p.set('userNo', params.userNo);
    if (params?.account) p.set('account', params.account);
    if (params?.from) p.set('from', params.from);
    if (params?.to) p.set('to', params.to);
    if (params?.skip != null) p.set('skip', String(params.skip));
    p.set('take', String(params?.take ?? 50));
    return api<{ items: any[]; total: number }>(`/admin/ip-pool/reclaims?${p}`);
  },
  ipPoolReflowLogs: (params?: { result?: string; skip?: number; take?: number }) => {
    const p = new URLSearchParams();
    if (params?.result) p.set('result', params.result);
    if (params?.skip != null) p.set('skip', String(params.skip));
    p.set('take', String(params?.take ?? 50));
    return api<{ items: any[]; total: number }>(`/admin/ip-pool/reflow-logs?${p}`);
  },
  createProxy: (body: any) => api('/admin/ip-pool', { method: 'POST', body }),
  updateProxy: (id: string, body: any) => api(`/admin/ip-pool/${id}`, { method: 'PATCH', body }),
  removeProxy: (id: string) => api(`/admin/ip-pool/${id}`, { method: 'DELETE' }),
  previewProxy: (userId: string) => api(`/admin/ip-pool/preview?userId=${userId}`),
  assignProxy: (userId: string, proxyId: string, reason?: string) =>
    api('/admin/ip-pool/assign', { method: 'POST', body: { userId, proxyId, reason } }),
  clearProxyAssign: (userId: string) =>
    api(`/admin/ip-pool/assign/${userId}`, { method: 'DELETE' }),
  evacuateProxy: (id: string, toProxyId?: string) =>
    api(`/admin/ip-pool/${id}/evacuate`, { method: 'POST', body: { toProxyId } }),
  cleanupInactiveProxies: () =>
    api<{
      inactiveFound: number;
      deletedProxies: number;
      movedUsers: number;
      pausedUsers: number;
      details: any[];
    }>('/admin/ip-pool/cleanup-inactive', { method: 'POST' }),

  exchangeKeys: (params?: { userId?: string; q?: string; skip?: number; take?: number }) => {
    const p = new URLSearchParams();
    if (params?.userId) p.set('userId', params.userId);
    if (params?.q) p.set('q', params.q);
    if (params?.skip != null) p.set('skip', String(params.skip));
    p.set('take', String(params?.take ?? 20));
    return api<{ items: any[]; total: number }>(`/admin/exchange-keys?${p}`);
  },
  setExchangeKeyActive: (id: string, active: boolean) =>
    api(`/admin/exchange-keys/${id}/active`, { method: 'PATCH', body: { active } }),
  removeExchangeKey: (id: string) => api(`/admin/exchange-keys/${id}`, { method: 'DELETE' }),

  auditLogs: (params?: { action?: string; skip?: number; take?: number }) => {
    const p = new URLSearchParams();
    if (params?.action) p.set('action', params.action);
    if (params?.skip != null) p.set('skip', String(params.skip));
    p.set('take', String(params?.take ?? 20));
    return api<{ items: any[]; total: number }>(`/admin/audit-logs?${p}`);
  },
  auditActions: () => api<{ action: string; count: number }[]>('/admin/audit-logs/actions'),

  postLogs: (params?: {
    userId?: string;
    exchange?: string;
    success?: boolean;
    feature?: string;
    endpoint?: string;
    q?: string;
    searchBody?: boolean;
    skip?: number;
    take?: number;
  }) => {
    const p = new URLSearchParams();
    if (params?.userId) p.set('userId', params.userId);
    if (params?.exchange) p.set('exchange', params.exchange);
    if (params?.success != null) p.set('success', String(params.success));
    if (params?.feature) p.set('feature', params.feature);
    if (params?.endpoint) p.set('endpoint', params.endpoint);
    if (params?.q) p.set('q', params.q);
    if (params?.searchBody) p.set('searchBody', '1');
    if (params?.skip != null) p.set('skip', String(params.skip));
    p.set('take', String(params?.take ?? 50));
    return api<{ items: any[]; total: number }>(`/admin/post-logs?${p}`);
  },
  postLogDetail: (id: string) => api<any>(`/admin/post-logs/${id}`),
  postLogFeatures: () =>
    api<{ feature: string; count: number }[]>('/admin/post-logs/features'),
  postLogConfig: () => api<{ enabled: boolean }>('/admin/post-logs/config'),
  setPostLogEnabled: (enabled: boolean) =>
    api<{ enabled: boolean }>('/admin/post-logs/enabled', {
      method: 'POST',
      body: { enabled },
    }),
  purgePostLogs: (body: { mode: 'all' | 'range'; from?: string; to?: string }) =>
    api<{ ok: boolean; deleted: number }>('/admin/post-logs/purge', {
      method: 'POST',
      body,
    }),
};
