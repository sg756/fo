/**
 * 手续费：读不到用户个人费率时，用各所公开 Regular / VIP0 默认档自算。
 * 不读中间件 QueryOrder.tradeFee，也不请求交易所费率接口。负数为支付。
 *
 * 选档只看我们下的单类型，不看成交时是否真吃单、也不看开平/买卖：
 *   市价（含市价开和平、现价追入、对账/手动市价平）→ 官方市价档（taker 列）
 *   委托/限价 → 官方委托档（maker 列）
 *
 * 核对日期 2026-09-14，来源为各所官方帮助/费率页 Regular·VIP0。
 * 只覆盖普通现货、普通 U 本位加密永续；不含 VIP、BNB/OKB 抵扣、TradFi Perps、活动档。
 *   Binance 合约 委托 0.020% / 市价 0.050%；现货 0.100% / 0.100%
 *   OKX     合约 委托 0.020% / 市价 0.050%；现货 0.080% / 0.100%
 *   Bybit   合约 委托 0.020% / 市价 0.055%；现货 0.100% / 0.100%
 *   Bitget  合约 委托 0.020% / 市价 0.060%；现货 0.100% / 0.100%
 *   Gate    合约 委托 0.020% / 市价 0.050%；现货 0.100% / 0.100%
 */

import { Exchange } from '@prisma/client';
import { isFuturesAccountType } from './exchange-codes';

export type UserFeeRates = {
  maker: number;
  taker: number;
};

/** U 本位合约 Regular / VIP0（普通加密永续，非 TradFi / 活动档） */
export const DEFAULT_FUTURES_FEE: Record<Exchange, UserFeeRates> = {
  BINANCE: { maker: 0.0002, taker: 0.0005 },
  OKX: { maker: 0.0002, taker: 0.0005 },
  BYBIT: { maker: 0.0002, taker: 0.00055 },
  BITGET: { maker: 0.0002, taker: 0.0006 },
  GATE: { maker: 0.0002, taker: 0.0005 },
};

/** 现货 Regular / VIP0（与合约分表，不能混用） */
export const DEFAULT_SPOT_FEE: Record<Exchange, UserFeeRates> = {
  BINANCE: { maker: 0.001, taker: 0.001 },
  OKX: { maker: 0.0008, taker: 0.001 },
  BYBIT: { maker: 0.001, taker: 0.001 },
  BITGET: { maker: 0.001, taker: 0.001 },
  GATE: { maker: 0.001, taker: 0.001 },
};

export function defaultFeeRates(
  exchange: Exchange,
  accountType?: string | null,
  equalCoinName?: string | null,
): UserFeeRates {
  const futures =
    isFuturesAccountType(accountType || '') ||
    !accountType ||
    String(equalCoinName || '').toUpperCase() === 'PC';
  const table = futures ? DEFAULT_FUTURES_FEE : DEFAULT_SPOT_FEE;
  return table[exchange] || DEFAULT_FUTURES_FEE.BINANCE;
}

/** 市价单（含追入/市价开平）用市价档；其余委托限价用委托档。 */
export function isMarketFeeOrder(orderType?: string | null, followMode?: string | null): boolean {
  const t = `${orderType || ''} ${followMode || ''}`;
  return /market|市价|^1$|ioc|fok|chase|market_open_close/i.test(t.trim());
}

export function isTakerOrderType(orderType?: string | null, followMode?: string | null): boolean {
  return isMarketFeeOrder(orderType, followMode);
}

export function pickFeeRate(rates: UserFeeRates, market: boolean): number {
  const n = market ? rates.taker : rates.maker;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** 成交额 × 费率，支付记负数 */
export function calcTradeFee(qty: number, price: number, rate: number): number {
  const q = Number(qty) || 0;
  const p = Number(price) || 0;
  const r = Number(rate) || 0;
  if (!(q > 0) || !(p > 0) || !(r >= 0) || !Number.isFinite(r)) return 0;
  const paid = q * p * r;
  if (!(paid > 0) || !Number.isFinite(paid)) return 0;
  return Math.round(-paid * 1e10) / 1e10;
}

export function defaultFeeForFill(params: {
  exchange: Exchange;
  filledAmt: number;
  priceAvg: number;
  accountType?: string | null;
  equalCoinName?: string | null;
  orderType?: string | null;
  followMode?: string | null;
}): number {
  const qty = Number(params.filledAmt) || 0;
  const px = Number(params.priceAvg) || 0;
  if (!(qty > 0) || !(px > 0)) return 0;
  const rates = defaultFeeRates(params.exchange, params.accountType, params.equalCoinName);
  const market = isMarketFeeOrder(params.orderType, params.followMode);
  return calcTradeFee(qty, px, pickFeeRate(rates, market));
}
