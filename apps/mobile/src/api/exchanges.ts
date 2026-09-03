export type ExchangeCode = 'BINANCE' | 'OKX' | 'BITGET' | 'BYBIT' | 'GATE';

export type ExchangeMeta = {
  exchange: ExchangeCode;
  name: string;
  needPass: boolean; // 是否需要 passphrase
};

// 与后端 Exchange 枚举一致; OKX/Bitget 需要 passphrase
export const EXCHANGES: ExchangeMeta[] = [
  { exchange: 'BINANCE', name: 'Binance', needPass: false },
  { exchange: 'OKX', name: 'OKX', needPass: true },
  { exchange: 'BITGET', name: 'Bitget', needPass: true },
  { exchange: 'BYBIT', name: 'Bybit', needPass: false },
  { exchange: 'GATE', name: 'Gate', needPass: false },
];
