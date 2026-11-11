/** 与后端 Exchange 枚举一致。界面先只放出原来支持的五家。 */
const EXCHANGE_CODES = [
  'BINANCE',
  'OKX',
  'BITGET',
  'BYBIT',
  'GATE',
  'HUOBI',
  'KUCOIN',
  'HYPERLIQUID',
  'HASHKEY',
  'BACKPACK',
  'ASTER',
  'LIGHTER',
] as const;

export type ExchangeCode = (typeof EXCHANGE_CODES)[number];

export const EXCHANGES = ['BINANCE', 'OKX', 'BITGET', 'BYBIT', 'GATE'] as const satisfies readonly ExchangeCode[];
