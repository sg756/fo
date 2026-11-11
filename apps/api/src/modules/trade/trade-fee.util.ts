/**
 * 手续费：读不到用户个人费率时，用各所公开 Regular / VIP0 默认档自算。
 * 不读中间件 QueryOrder.tradeFee，也不请求交易所费率接口。负数为支付。
 *
 * 选档只看我们下的单类型，不看成交时是否真吃单、也不看开平/买卖：
 *   市价（含市价开和平、现价追入、对账/手动市价平）→ 官方市价档（taker 列）
 *   委托/限价 → 官方委托档（maker 列）
 *
 * 前五所核对日期 2026-09-14；后七所 2026-10-13。来源为各所官方 Regular / VIP0 / Tier0，
 * 不含 VIP、平台币抵扣、质押折扣、TradFi / RWA、活动档。
 *   Binance      合约 0.020% / 0.050%；现货 0.100% / 0.100%
 *   OKX          合约 0.020% / 0.050%；现货 0.080% / 0.100%
 *   Bybit        合约 0.020% / 0.055%；现货 0.100% / 0.100%
 *   Bitget       合约 0.020% / 0.060%；现货 0.100% / 0.100%
 *   Gate         合约 0.020% / 0.050%；现货 0.100% / 0.100%
 *   火必 HTX     Prime0，不吃 HTX 抵扣。现货 0.200% / 0.200%；U 本位合约 0.020% / 0.060%
 *   KuCoin       VIP0。现货 Class A 0.100% / 0.100%；合约 0.020% / 0.060%
 *   HyperLiquid  Tier 0，不吃质押折扣。合约 0.015% / 0.045%；现货 0.040% / 0.070%
 *   Backpack     Tier 1（0 质押、0 成交额）。合约 0.020% / 0.050%；现货 0.080% / 0.100%
 *   Aster        普通加密。合约挂单 0、市价 0.040%；现货 0.005% / 0.040%
 *   Lighter      Standard 账户，合约和现货都是 0 / 0（Plus、Premium 不采用）
 *   HashKey      香港站 2026-08-01 的 VIP0 表只在公告图片里，正文没有数字，附件读不到。
 *                下面两行仍是占位，不是官方档，也不要用百慕大 Global 的 0.120% / 0.025% / 0.060%。
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
  HUOBI: { maker: 0.0002, taker: 0.0006 },
  KUCOIN: { maker: 0.0002, taker: 0.0006 },
  HYPERLIQUID: { maker: 0.00015, taker: 0.00045 },
  // 香港站没有合约；官方 VIP0 表读不到，此行只为补齐类型
  HASHKEY: { maker: 0.0002, taker: 0.0005 },
  BACKPACK: { maker: 0.0002, taker: 0.0005 },
  ASTER: { maker: 0, taker: 0.0004 },
  LIGHTER: { maker: 0, taker: 0 },
};

/** 现货 Regular / VIP0（与合约分表，不能混用） */
export const DEFAULT_SPOT_FEE: Record<Exchange, UserFeeRates> = {
  BINANCE: { maker: 0.001, taker: 0.001 },
  OKX: { maker: 0.0008, taker: 0.001 },
  BYBIT: { maker: 0.001, taker: 0.001 },
  BITGET: { maker: 0.001, taker: 0.001 },
  GATE: { maker: 0.001, taker: 0.001 },
  HUOBI: { maker: 0.002, taker: 0.002 },
  KUCOIN: { maker: 0.001, taker: 0.001 },
  HYPERLIQUID: { maker: 0.0004, taker: 0.0007 },
  // 香港站现货 VIP0 官方表读不到，此行仍是占位
  HASHKEY: { maker: 0.001, taker: 0.001 },
  BACKPACK: { maker: 0.0008, taker: 0.001 },
  ASTER: { maker: 0.00005, taker: 0.0004 },
  LIGHTER: { maker: 0, taker: 0 },
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
