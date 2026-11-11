export type ExchangeCode =
  | 'BINANCE'
  | 'OKX'
  | 'BITGET'
  | 'BYBIT'
  | 'GATE'
  | 'HUOBI'
  | 'KUCOIN'
  | 'HYPERLIQUID'
  | 'HASHKEY'
  | 'BACKPACK'
  | 'ASTER'
  | 'LIGHTER';

export type ExchangeMeta = {
  exchange: ExchangeCode;
  name: string;
  needPass: boolean; // 是否需要 passphrase
};

const EXCHANGE_NAMES: Record<ExchangeCode, string> = {
  BINANCE: 'Binance',
  OKX: 'OKX',
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

export function exchangeName(code: string) {
  return EXCHANGE_NAMES[code as ExchangeCode] || code;
}

/** 界面先只放出原来支持的五家；后加的所先不展示 */
export const EXCHANGES: ExchangeMeta[] = [
  { exchange: 'BINANCE', name: 'Binance', needPass: false },
  { exchange: 'OKX', name: 'OKX', needPass: true },
  { exchange: 'BITGET', name: 'Bitget', needPass: true },
  { exchange: 'BYBIT', name: 'Bybit', needPass: false },
  { exchange: 'GATE', name: 'Gate', needPass: false },
];
