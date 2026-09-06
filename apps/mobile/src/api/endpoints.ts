import { api } from './client';
import type { ExchangeCode } from './exchanges';

// ===== 类型 =====
export type MeUser = {
  id: string;
  email: string;
  nickname?: string | null;
  role: 'ADMIN' | 'USER';
  status: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'DISABLED';
  inviteCode: string;
  followEnabled?: boolean;
  followStartedAt?: string | null;
  withdrawAddress?: string | null;
  withdrawChain?: string | null;
  hasWithdrawAddress?: boolean;
  pointCard?: { balance: string; frozen: string } | null;
};

export type LoginResp = {
  accessToken: string;
  user: {
    id: string;
    email: string;
    nickname?: string | null;
    role: MeUser['role'];
    status: MeUser['status'];
    inviteCode: string;
  };
};

export type PointCard = {
  balance: string;
  frozen: string;
  commissionBalance?: string;
  commissionFrozen?: string;
  withdrawable?: string;
};

export type PointTx = {
  id: string;
  type: string;
  amount: string;
  balanceAfter: string;
  remark?: string | null;
  createdAt: string;
};

export type WithdrawItem = {
  id: string;
  amount: string;
  fee: string;
  chain: string;
  toAddress: string;
  status: string;
  createdAt: string;
};

export type InviteMember = {
  id: string;
  email?: string;
  nickname?: string | null;
  userNo?: number | null;
  role?: string;
  status: string;
  createdAt: string;
  commission?: number;
};

export type InviteInfo = {
  inviteCode: string;
  inviteLink: string;
  todayCommission?: number;
  totalCommission?: number;
  memberCount?: number;
  members: InviteMember[];
};

export type CommissionItem = {
  id: string;
  level: string;
  rate: string;
  amount: string;
  createdAt: string;
  fromUser?: {
    id: string;
    userNo?: number | null;
    nickname?: string | null;
    email?: string | null;
  } | null;
};

export type CommissionListResp = {
  items: CommissionItem[];
  total: number;
  sum: number;
};

export type ExchangeKeyItem = {
  id: string;
  exchange: ExchangeCode;
  label?: string | null;
  apiKeyMasked: string;
  hasPassphrase: boolean;
  /** 凭证是否完整；OKX/Bitget 无 passphrase 时为 false */
  configured?: boolean;
  active: boolean;
  createdAt: string;
};

export type IpWhitelist = {
  ips: string[];
  comma: string;
  space: string;
  newline: string;
};

export type RechargeOrder = {
  id: string;
  chain: string;
  tokenSymbol: string;
  txHash: string;
  amount: string;
  confirmations: number;
  status: 'PENDING' | 'CONFIRMED' | 'CREDITED' | 'FAILED';
  createdAt: string;
  updatedAt: string;
};

// ===== auth =====
export const AuthApi = {
  register: (body: {
    account: string;
    password: string;
    confirmPassword: string;
    inviteCode?: string;
    nickname?: string;
  }) =>
    api<{
      id: string;
      email: string;
      nickname?: string | null;
      status: string;
      inviteCode: string;
      message: string;
      depositChain?: string;
      depositAddress?: string;
    }>('/auth/register', {
      method: 'POST',
      body,
      auth: false,
    }),
  login: (body: { email: string; password: string }) =>
    api<LoginResp>('/auth/login', { method: 'POST', body, auth: false }),
  me: () => api<MeUser>('/auth/me'),
  changePassword: (body: { currentPassword: string; newPassword: string; confirmPassword: string }) =>
    api<{ ok: boolean; message: string }>('/auth/change-password', { method: 'POST', body }),
};

// ===== account =====
export const AccountApi = {
  pointCard: () => api<PointCard>('/account/point-card'),
  txs: (
    skip = 0,
    take = 50,
    opts?: { type?: string; from?: string; to?: string },
  ) => {
    const p = new URLSearchParams();
    p.set('skip', String(skip));
    p.set('take', String(take));
    if (opts?.type) p.set('type', opts.type);
    if (opts?.from) p.set('from', opts.from);
    if (opts?.to) p.set('to', opts.to);
    return api<PointTx[]>(`/account/txs?${p.toString()}`);
  },
  depositNetworks: () =>
    api<{ networks: { chain: string; name: string; label: string; token: string }[]; minAmount: number }>(
      '/account/deposit-networks',
    ),
  depositAddress: (chain?: string) => {
    const qs = chain ? `?chain=${encodeURIComponent(chain)}` : '';
    return api<{
      chain: string;
      address: string;
      token?: string;
      networkName?: string;
      minAmount?: number;
    }>(`/account/deposit-address${qs}`);
  },
  recharges: (skip = 0, take = 50) =>
    api<RechargeOrder[]>(`/account/recharges?skip=${skip}&take=${take}`),
  createWithdraw: (body: { amount: number }) =>
    api<WithdrawItem>('/account/withdraw', { method: 'POST', body }),
  withdraws: () => api<WithdrawItem[]>('/account/withdraws'),
  withdrawAddress: () =>
    api<{
      address: string | null;
      chain: string;
      label: string | null;
      updatedAt: string | null;
      configured: boolean;
      minWithdrawAmount?: number;
    }>('/account/withdraw-address'),
  setWithdrawAddress: (body: { address: string; chain?: string; label?: string }) =>
    api('/account/withdraw-address', { method: 'POST', body }),
  invite: () => api<InviteInfo>('/account/invite'),
  inviteMembers: (skip = 0, take = 50) =>
    api<{ total: number; items: InviteMember[] }>(
      `/account/invite/members?skip=${skip}&take=${take}`,
    ),
  commissions: (
    skip = 0,
    take = 50,
    opts?: { from?: string; to?: string; q?: string },
  ) => {
    const p = new URLSearchParams();
    p.set('skip', String(skip));
    p.set('take', String(take));
    if (opts?.from) p.set('from', opts.from);
    if (opts?.to) p.set('to', opts.to);
    if (opts?.q) p.set('q', opts.q);
    return api<CommissionItem[] | CommissionListResp>(`/account/commissions?${p.toString()}`);
  },
};

// ===== 交易所 API Key =====
export const ExchangeKeyApi = {
  list: () => api<ExchangeKeyItem[]>('/exchange-keys'),
  upsert: (body: {
    exchange: ExchangeCode;
    apiKey: string;
    apiSecret: string;
    passphrase?: string;
    label?: string;
  }) => api<ExchangeKeyItem>('/exchange-keys', { method: 'POST', body }),
  remove: (id: string) => api<{ ok: boolean }>(`/exchange-keys/${id}`, { method: 'DELETE' }),
};

// ===== 下单服务器出口IP白名单 (只读) =====
export const IpWhitelistApi = {
  get: () => api<IpWhitelist>('/ip-whitelist'),
};

// ===== 交易 =====
export type TradePosition = {
  id: string;
  exchange: string;
  symbol: string;
  pair: string;
  coinName?: string | null;
  equalCoinName?: string | null;
  mode: string;
  side: 'long' | 'short' | string;
  amount: string;
  /** 开仓均价 / 开仓价格（交易所实时或本地流水） */
  entryPrice?: number | string | null;
  margin: string;
  pnl?: string;
  openTime?: string;
  holdDuration?: string;
  /** 开仓成交订单号（多笔加仓时为最近一笔） */
  orderId?: string | null;
  orderIds?: string[];
  /** local | exchange */
  source?: string;
  /** 异常仓（平不掉的本地残留）；App 持仓列表不展示 */
  abnormal?: boolean;
};

export type TradeOrder = {
  id: string;
  orderId?: string | null;
  exchange: string;
  pair: string;
  coinName?: string | null;
  mode: string;
  side: string;
  type: string;
  price: string;
  amount: string;
  filled: string;
  status: string;
  time: string;
  isOpen?: boolean | null;
  accountType?: string | null;
  coinName?: string | null;
  equalCoinName?: string | null;
  cancelReason?: string | null;
  cancelMsg?: string | null;
  errorMsg?: string | null;
  /** 开仓/挂单/撤单失败的具体原因 */
  failReason?: string | null;
  canCancel?: boolean;
};

export type TradeChecklist = {
  approved: boolean;
  status: string;
  apiKey: boolean;
  apiKeyCount: number;
  ipWhitelist: boolean;
  ipCount: number;
  followEnabled: boolean;
  followStartedAt: string | null;
  canStart: boolean;
  proxyAssigned: boolean;
  proxyEgress: string | null;
  /** 当前点卡余额 */
  pointBalance?: number;
  /** 开仓最低点卡 (后台配置) */
  openMinPointBalance?: number;
  /** 点卡是否达到开仓门槛 (后台接开仓信号用) */
  pointEnough?: boolean;
  /** 同 pointEnough */
  canOpenFollow?: boolean;
  pointGateMessage?: string | null;
  /** 是否已配置至少一所：模板 + 声明本金 */
  followConfigReady?: boolean;
  followConfigCount?: number;
  followConfigHint?: string;
};

export type FollowTemplateOption = {
  id: string;
  name: string;
  exchange: ExchangeCode;
  unitAmount: number;
  maxPrincipal: number;
  minInvestAmount?: number;
  accountName?: string | null;
  remark?: string | null;
};

export type UserFollowConfigItem = {
  exchange: ExchangeCode;
  hasKey: boolean;
  templateId: string | null;
  investAmount: number | null;
  ratio: number | null;
  template: (FollowTemplateOption & { active?: boolean }) | null;
  templates: FollowTemplateOption[];
};

export type HomeSummary = {
  user: {
    name: string;
    email?: string;
    role?: string;
    status?: string;
    followEnabled: boolean;
    followStartedAt?: string | null;
  };
  today: string;
  week: string;
  totalIncome: string;
  totalAssets: string;
  pointCard: string;
  /** 点卡数值 (可负) */
  pointBalance?: number;
  /** 开仓最低点卡 */
  openMinPointBalance?: number;
  /** 是否达到开仓门槛 */
  pointEnough?: boolean;
  earnings: string;
  commission: string;
  /** 可领/可提佣金 */
  commissionClaimable?: string;
  /** 待审佣金（提现冻结） */
  commissionPending?: string;
  /** 已领佣金（累计入账 − 可领 − 待审，即已提现结算） */
  commissionClaimed?: string;
  assets: {
    symbol: string;
    name: string;
    amount: string;
    usdt: string;
    color: string;
  }[];
  balanceErrors?: { exchange: string; message: string }[];
  apiKeyCount?: number;
  hasApiKey?: boolean;
};

export type BalanceSummary = {
  totalAssets: string;
  totalAssetsNum: number;
  assets: {
    symbol: string;
    name: string;
    amount: string;
    usdt: string;
    usdtNum: number;
    color: string;
    exchanges: string[];
  }[];
  errors?: { exchange: string; message: string }[];
};

export type ProfitItem = {
  id: string;
  pair: string;
  exchange: string;
  pnl: string;
  pnlNum: number;
  positive: boolean;
  amount: string;
  openTime: string;
  closeTime: string;
  closedAt?: string;
  success?: boolean;
  signalKey?: string;
  /** 信号仓位 GUID，区分同币同方向多次开/平仓 */
  orderGid?: string | null;
  orderId?: string | null;
  kind?: 'open' | 'close' | 'cancel' | 'other';
  kindLabel?: string;
  positionSide?: string | null;
  coinName?: string | null;
  equalCoinName?: string | null;
  signalAmount?: string | null;
  filledAmt?: string | null;
  avgPrice?: string | null;
  status?: string;
  statusLabel?: string;
  isOpen?: boolean | null;
  errorMsg?: string | null;
  cancelMsg?: string | null;
  cancelReason?: string | null;
  failReason?: string | null;
};

export type MarketTicker = {
  symbol: string;
  pair: string;
  price: string;
  priceNum: number;
  change: number;
  high: string;
  low: string;
  volume: string;
  spark: number[];
  updatedAt: number;
};

export const TradeApi = {
  checklist: () => api<TradeChecklist>('/trade/checklist'),
  followStatus: () =>
    api<{ status: string; followEnabled: boolean; followStartedAt?: string | null }>('/trade/follow-status'),
  start: () => api<{ followEnabled: boolean; followStartedAt: string }>('/trade/start', { method: 'POST' }),
  stop: () => api<{ followEnabled: boolean; followStoppedAt: string }>('/trade/stop', { method: 'POST' }),
  followConfigs: () =>
    api<{
      items: UserFollowConfigItem[];
      ready: boolean;
      configuredCount: number;
      hint: string;
    }>('/trade/follow-configs'),
  saveFollowConfig: (body: { exchange: ExchangeCode; templateId: string; investAmount: number }) =>
    api('/trade/follow-configs', { method: 'POST', body }),
  deleteFollowConfig: (exchange: ExchangeCode) =>
    api(`/trade/follow-configs/${exchange}`, { method: 'DELETE' }),
  followTemplates: (exchange?: ExchangeCode) =>
    api<{ items: FollowTemplateOption[]; total: number }>(
      `/trade/follow-templates${exchange ? `?exchange=${exchange}` : ''}`,
    ),
  positions: async () => {
    const res = await api<{ items: TradePosition[]; errors?: { exchange: string; message: string }[] }>(
      '/trade/positions',
    );
    const items = (res.items || []).filter((p) => p.abnormal !== true);
    return { ...res, items };
  },
  orders: () => api<{ items: TradeOrder[]; errors?: { exchange: string; message: string }[] }>('/trade/orders'),
  balance: (exchange: string) => api(`/trade/balance?exchange=${exchange}`),
  balances: () => api<BalanceSummary>('/trade/balances'),
  homeSummary: () => api<HomeSummary>('/trade/home-summary'),
  profits: (
    skip = 0,
    take = 50,
    filters?: { exchange?: string; coin?: string; from?: string; to?: string },
  ) => {
    const p = new URLSearchParams();
    p.set('skip', String(skip));
    p.set('take', String(take));
    if (filters?.exchange) p.set('exchange', filters.exchange);
    if (filters?.coin) p.set('coin', filters.coin);
    if (filters?.from) p.set('from', filters.from);
    if (filters?.to) p.set('to', filters.to);
    return api<ProfitItem[] | { items: ProfitItem[]; total: number; sum: number }>(
      `/trade/profits?${p.toString()}`,
    );
  },
  followHistory: (skip = 0, take = 50) =>
    api<ProfitItem[]>(`/trade/follow-history?skip=${skip}&take=${take}`),
  placeOrder: (body: any) => api('/trade/place-order', { method: 'POST', body }),
  depth: (symbol: string, exchange?: string) =>
    api(`/trade/depth?symbol=${encodeURIComponent(symbol)}${exchange ? `&exchange=${exchange}` : ''}`),
};

/** 行情 — 由 Node 采集后转发, App 不直连交易所 */
export const MarketApi = {
  tickers: (tab?: string, q?: string) => {
    const params = new URLSearchParams();
    if (tab) params.set('tab', tab);
    if (q) params.set('q', q);
    const qs = params.toString();
    return api<{ items: MarketTicker[]; updatedAt: number | null; error: string | null }>(
      `/market/tickers${qs ? `?${qs}` : ''}`,
      { auth: false },
    );
  },
};

