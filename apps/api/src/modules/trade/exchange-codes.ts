import { Exchange } from '@prisma/client';

/** 我们内部 Exchange → :1820 现货 apiCode */
export const EXCHANGE_API_CODE: Record<Exchange, string> = {
  BINANCE: 'ba',
  OKX: 'ok',
  BITGET: 'bg',
  BYBIT: 'bb',
  GATE: 'gt',
};

/** apiCode → 交易所中文名 (下单请求 apiName 字段) */
export const EXCHANGE_API_NAME: Record<Exchange, string> = {
  BINANCE: '币安',
  OKX: '欧易',
  BITGET: 'Bitget',
  BYBIT: 'Bybit',
  GATE: 'Gate',
};

export const API_CODE_EXCHANGE: Record<string, Exchange> = {
  ba: 'BINANCE',
  binance: 'BINANCE',
  ok: 'OKX',
  okx: 'OKX',
  bg: 'BITGET',
  bitget: 'BITGET',
  bb: 'BYBIT',
  bybit: 'BYBIT',
  gt: 'GATE',
  gate: 'GATE',
};

/**
 * 内部 Exchange + 账户类型 → apiCode。
 * 文档中现货为 `ba`, 永续合约信号 apiCode 为 `bac` (现货代码 + 'c')。
 */
export function toApiCode(exchange: Exchange, accountType?: string): string {
  const base = EXCHANGE_API_CODE[exchange];
  if (accountType && isFuturesAccountType(accountType)) return `${base}c`;
  return base;
}

export function apiName(exchange: Exchange): string {
  return EXCHANGE_API_NAME[exchange] || exchange;
}

/**
 * apiCode → 内部 Exchange。
 * 兼容现货/合约变体: 先精确匹配, 再去掉末尾的合约后缀('c'/'f'), 最后按 2 字母前缀匹配。
 */
export function fromApiCode(code: string): Exchange | undefined {
  const c = String(code || '').toLowerCase();
  if (!c) return undefined;
  if (API_CODE_EXCHANGE[c]) return API_CODE_EXCHANGE[c];
  // 去掉合约后缀 (bac → ba, okc → ok)
  const stripped = c.replace(/[cf]$/, '');
  if (API_CODE_EXCHANGE[stripped]) return API_CODE_EXCHANGE[stripped];
  // 前缀匹配 (取前两位)
  const prefix = c.slice(0, 2);
  if (API_CODE_EXCHANGE[prefix]) return API_CODE_EXCHANGE[prefix];
  return undefined;
}

/** 账户类型是否为合约 */
export function isFuturesAccountType(accountType?: string): boolean {
  const t = String(accountType || '').toLowerCase();
  return t === 'future' || t === 'futures' || t === 'swap' || t === 'perp' || t === 'perpetual';
}

/**
 * 由信号 key 的计价币段判断账户类型。
 * 文档: equalCoinName 在合约中表示合约周期 (如 PC=永续合约); 现货则为计价币(U/USDT/USDC...)。
 */
export function accountTypeFromEqualCoin(equalCoin: string): string {
  const e = String(equalCoin || '').toUpperCase();
  const spotQuotes = ['U', 'USDT', 'USDC', 'USD', 'BTC', 'ETH', 'EUR', 'FDUSD', 'DAI', 'TUSD'];
  if (spotQuotes.includes(e)) return 'spot';
  // PC(永续)/其他周期码 → 合约
  return 'future';
}

/** 管理端资产查询：账户类型展示名 */
export type AccountTypeDef = { type: string; label: string };

/**
 * 各所尝试查询的账户类型（中间件 accountType）。
 * 不支持的类型由 QueryBalance 失败后标为「不支持/失败」，不影响其它账户。
 * 资金账户暂不查：币安用 ba 打 funding 时中间件仍回现货列表，易与现货重复展示。
 */
const DEFAULT_ACCOUNT_TYPES: AccountTypeDef[] = [
  { type: 'future', label: '合约' },
  { type: 'spot', label: '现货' },
];

const ACCOUNT_TYPES_BY_EXCHANGE: Partial<Record<Exchange, AccountTypeDef[]>> = {
  // 各所若后续有差异在此覆盖；默认三账户
};

export function accountTypesForExchange(exchange: Exchange): AccountTypeDef[] {
  return ACCOUNT_TYPES_BY_EXCHANGE[exchange] || DEFAULT_ACCOUNT_TYPES;
}

/**
 * 管理端「刷新资产」按所查合约 / 现货 / 资金。
 */
export function adminBalanceAccountTypes(exchange: Exchange): AccountTypeDef[] {
  return accountTypesForExchange(exchange);
}
