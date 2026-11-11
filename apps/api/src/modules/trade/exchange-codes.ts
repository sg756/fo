import { Exchange } from '@prisma/client';

/** 中间件交易对规范里的市场类型。股票现货仍按现货账户查仓。 */
export type ApiMarketKind =
  | 'spot'
  | 'stock-spot'
  | 'usdt-perp'
  | 'usdc-perp'
  | 'coin-perp'
  | 'usdt-delivery'
  | 'coin-delivery';

type ApiCodeDef = { code: string; kind: ApiMarketKind; name: string };

/**
 * 与 Prisma Exchange 一致。没有现货或没有 USDT 永续时，对应默认码留空，
 * 运行时改用该所仅有的那个市场码。
 */
type VenueCatalog = {
  id: Exchange;
  name: string;
  enabled: boolean;
  /** 现货默认码。该所没有现货时为空 */
  spotCode: string;
  /** 没带信号原码时的合约默认码，取该所 USDT 永续。没有则为空 */
  usdtPerpCode: string;
  codes: ApiCodeDef[];
};

export const MIDDLEWARE_EXCHANGES: VenueCatalog[] = [
  {
    id: 'BINANCE',
    name: '币安',
    enabled: true,
    spotCode: 'ba',
    usdtPerpCode: 'bac',
    codes: [
      { code: 'ba', kind: 'spot', name: '币安现货' },
      { code: 'bac', kind: 'usdt-perp', name: '币安USDT永续' },
      { code: 'bab', kind: 'usdc-perp', name: '币安USDC永续' },
      { code: 'bap', kind: 'coin-perp', name: '币安币本位永续' },
      { code: 'bas', kind: 'coin-delivery', name: '币安币本位交割' },
    ],
  },
  {
    id: 'OKX',
    name: '欧易',
    enabled: true,
    spotCode: 'ok',
    usdtPerpCode: 'okp',
    codes: [
      { code: 'ok', kind: 'spot', name: '欧易现货' },
      { code: 'okp', kind: 'usdt-perp', name: '欧易USDT永续' },
      { code: 'oks', kind: 'coin-perp', name: '欧易币本位永续' },
      { code: 'oku', kind: 'usdt-delivery', name: '欧易USDT交割' },
      { code: 'okc', kind: 'coin-delivery', name: '欧易币本位交割' },
    ],
  },
  {
    id: 'BITGET',
    name: 'Bitget',
    enabled: true,
    spotCode: 'bg',
    usdtPerpCode: 'bgu',
    codes: [
      { code: 'bg', kind: 'spot', name: 'Bitget现货' },
      { code: 'bgu', kind: 'usdt-perp', name: 'Bitget永续USDT' },
      { code: 'bgc', kind: 'usdc-perp', name: 'Bitget永续USDC' },
    ],
  },
  {
    id: 'BYBIT',
    name: 'Bybit',
    enabled: true,
    spotCode: 'by',
    usdtPerpCode: 'byu',
    codes: [
      { code: 'by', kind: 'spot', name: 'Bybit现货' },
      { code: 'byu', kind: 'usdt-perp', name: 'Bybit永续USDT' },
      { code: 'byp', kind: 'usdc-perp', name: 'Bybit永续USDC' },
    ],
  },
  {
    id: 'GATE',
    name: 'Gate',
    enabled: true,
    spotCode: 'gt',
    usdtPerpCode: 'gtc',
    codes: [
      { code: 'gt', kind: 'spot', name: 'Gate现货' },
      { code: 'gs', kind: 'stock-spot', name: 'Gate股票现货' },
      { code: 'gtc', kind: 'usdt-perp', name: 'Gate永续USDT' },
    ],
  },
  {
    id: 'HUOBI',
    name: '火必',
    enabled: true,
    spotCode: 'hb',
    usdtPerpCode: 'hbp',
    codes: [
      { code: 'hb', kind: 'spot', name: '火必现货' },
      { code: 'hbp', kind: 'usdt-perp', name: '火必USDT永续' },
    ],
  },
  {
    id: 'KUCOIN',
    name: 'KuCoin',
    enabled: true,
    spotCode: 'kc',
    usdtPerpCode: 'kcp',
    codes: [
      { code: 'kc', kind: 'spot', name: 'KuCoin现货' },
      { code: 'kcp', kind: 'usdt-perp', name: 'KuCoin永续USDT' },
      { code: 'kcc', kind: 'usdc-perp', name: 'KuCoin永续USDC' },
    ],
  },
  {
    id: 'HYPERLIQUID',
    name: 'HyperLiquid',
    enabled: true,
    spotCode: '',
    usdtPerpCode: '',
    codes: [{ code: 'hpc', kind: 'usdc-perp', name: 'HyperLiquid永续USDC' }],
  },
  {
    id: 'HASHKEY',
    name: 'HashKey',
    enabled: true,
    spotCode: 'hk',
    usdtPerpCode: '',
    codes: [{ code: 'hk', kind: 'spot', name: 'HashKey现货香港' }],
  },
  {
    id: 'BACKPACK',
    name: 'Backpack',
    enabled: true,
    spotCode: 'bp',
    usdtPerpCode: '',
    codes: [
      { code: 'bp', kind: 'spot', name: 'Backpack现货' },
      { code: 'bpc', kind: 'usdc-perp', name: 'Backpack永续USDC' },
    ],
  },
  {
    id: 'ASTER',
    name: 'Aster',
    enabled: true,
    spotCode: 'at',
    usdtPerpCode: 'atc',
    codes: [
      { code: 'at', kind: 'spot', name: 'Aster现货' },
      { code: 'atc', kind: 'usdt-perp', name: 'Aster永续USDT' },
    ],
  },
  {
    id: 'LIGHTER',
    name: 'Lighter',
    enabled: true,
    spotCode: '',
    usdtPerpCode: '',
    codes: [{ code: 'ltc', kind: 'usdc-perp', name: 'Lighter永续USDC' }],
  },
];

export type ApiCodeInfo = {
  code: string;
  exchangeId: string;
  exchangeName: string;
  kind: ApiMarketKind;
  name: string;
  enabled: boolean;
};

const API_CODE_INFO = new Map<string, ApiCodeInfo>();
for (const venue of MIDDLEWARE_EXCHANGES) {
  for (const row of venue.codes) {
    const code = row.code.toLowerCase();
    if (API_CODE_INFO.has(code)) {
      throw new Error(`重复的 apiCode: ${code}`);
    }
    API_CODE_INFO.set(code, {
      code,
      exchangeId: venue.id,
      exchangeName: venue.name,
      kind: row.kind,
      name: row.name,
      enabled: venue.enabled,
    });
  }
}

function defaultSpotCode(venue: VenueCatalog): string {
  if (venue.spotCode) return venue.spotCode;
  const spot = venue.codes.find((c) => c.kind === 'spot' || c.kind === 'stock-spot');
  return spot?.code || venue.codes[0].code;
}

function defaultFutureCode(venue: VenueCatalog): string {
  if (venue.usdtPerpCode) return venue.usdtPerpCode;
  const perp = venue.codes.find(
    (c) => c.kind === 'usdt-perp' || c.kind === 'usdc-perp' || c.kind === 'coin-perp',
  );
  return perp?.code || venue.codes[0].code;
}

function codeMap(pick: (venue: VenueCatalog) => string): Record<Exchange, string> {
  const out = {} as Record<Exchange, string>;
  for (const venue of MIDDLEWARE_EXCHANGES) {
    if (!venue.enabled) continue;
    out[venue.id] = pick(venue);
  }
  for (const id of Object.values(Exchange)) {
    if (!out[id]) throw new Error(`交易所未归类: ${id}`);
  }
  return out;
}

/** 现货默认 apiCode。没有现货的所用它仅有的合约码。 */
export const EXCHANGE_API_CODE: Record<Exchange, string> = codeMap(defaultSpotCode);

/** 无信号原码时的合约 apiCode：优先 USDT 永续，否则该所仅有的合约码。 */
const FUTURES_USDT_API_CODE: Record<Exchange, string> = codeMap(defaultFutureCode);

/** 下单请求 apiName。具体市场名以交易对规范为准。 */
export const EXCHANGE_API_NAME: Record<Exchange, string> = {
  BINANCE: '币安',
  OKX: '欧易',
  BITGET: 'Bitget',
  BYBIT: 'Bybit',
  GATE: 'Gate',
  HUOBI: '火必',
  KUCOIN: 'KuCoin',
  HYPERLIQUID: 'HyperLiquid',
  HASHKEY: 'HashKey',
  BACKPACK: 'Backpack',
  ASTER: 'Aster',
  LIGHTER: 'Lighter',
};

/** 已接入交易所的 apiCode。未接入的码不在这里，避免被当成可跟单交易所。 */
export const API_CODE_EXCHANGE: Record<string, Exchange> = {};
for (const [code, info] of API_CODE_INFO) {
  if (!info.enabled) continue;
  API_CODE_EXCHANGE[code] = info.exchangeId as Exchange;
}

/** 列表上的产品名。USDT 永续和 USDC 永续分开，不再都叫永续合约。 */
export function apiCodeModeLabel(code: string | null | undefined): string {
  const info = lookupApiCode(String(code || ''));
  if (!info) return '';
  switch (info.kind) {
    case 'spot':
    case 'stock-spot':
      return '现货';
    case 'usdt-perp':
      return 'USDT永续';
    case 'usdc-perp':
      return 'USDC永续';
    case 'coin-perp':
      return '币本位永续';
    case 'usdt-delivery':
      return 'USDT交割';
    case 'coin-delivery':
      return '币本位交割';
    default:
      return '';
  }
}

/** 查任意已归类的 apiCode。未接入交易所也会返回，enabled 为 false。 */
export function lookupApiCode(code: string): ApiCodeInfo | undefined {
  const c = String(code || '').trim().toLowerCase();
  if (!c) return undefined;
  return API_CODE_INFO.get(c);
}

/**
 * 内部 Exchange + 账户类型 → 默认 apiCode。
 * 现货用该所现货码。合约在没有信号原码时用该所 USDT 永续。
 * USDC / 币本位必须沿用信号里的 apiCode。
 */
export function toApiCode(exchange: Exchange, accountType?: string): string {
  if (accountType && isFuturesAccountType(accountType)) return FUTURES_USDT_API_CODE[exchange];
  return EXCHANGE_API_CODE[exchange];
}

/** 现货、股票现货走 spot，其余走 future。 */
export function accountTypeForApiCode(_exchange: Exchange, apiCode: string): 'spot' | 'future' {
  const info = lookupApiCode(apiCode);
  if (info && (info.kind === 'spot' || info.kind === 'stock-spot')) return 'spot';
  return 'future';
}

export function apiName(exchange: Exchange): string {
  return EXCHANGE_API_NAME[exchange] || exchange;
}

/**
 * apiCode → 已接入的 Exchange。只认完整键。
 * 未接入交易所返回 undefined，信号不跟。
 */
export function fromApiCode(code: string): Exchange | undefined {
  const info = lookupApiCode(code);
  if (!info?.enabled) return undefined;
  return info.exchangeId as Exchange;
}

/** 账户类型是否为合约 */
export function isFuturesAccountType(accountType?: string): boolean {
  const t = String(accountType || '').toLowerCase();
  return t === 'future' || t === 'futures' || t === 'swap' || t === 'perp' || t === 'perpetual';
}

export type ParsedSignalKey = {
  apiCode: string;
  coinName: string;
  equalCoinName: string;
  positionSide: 'long' | 'short';
};

/**
 * LastOrderRecords 的 key：`apiCode_币名_计价_方向`。
 * 例：`bab_UNI_PC_long`（USDC 永续）、`ba_ETH_USDC_long`（USDC 现货）、`bac_WIF_PC_short`。
 * 开仓、平仓、撤单都用这里拆出的 apiCode 和计价，不再改写成默认 bac。
 */
export function parseSignalKey(key: string): ParsedSignalKey | null {
  const parts = String(key || '').split('_');
  if (parts.length < 4) return null;
  const apiCode = parts[0].toLowerCase();
  const side = parts[parts.length - 1].toLowerCase();
  if (side !== 'long' && side !== 'short') return null;
  const equalCoinName = parts[parts.length - 2].toUpperCase();
  const coinName = parts.slice(1, parts.length - 2).join('_').toUpperCase();
  if (!apiCode || !coinName || !equalCoinName) return null;
  if (!fromApiCode(apiCode)) return null;
  return {
    apiCode,
    coinName,
    equalCoinName,
    positionSide: side,
  };
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
