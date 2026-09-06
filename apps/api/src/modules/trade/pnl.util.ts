/**
 * 已实现盈亏公式 (基于 QueryOrder 成交字段 + 开仓均价配对)
 *
 * 输入 (平仓单 QueryOrder):
 *   Status=2 完全成交, FilledAmt, PriceAvg, TradeFee
 * 输入 (配对开仓单已落库):
 *   avgPrice, filledAmt, tradeFee, positionSide
 *
 * 毛利:
 *   多头: (平仓均价 − 开仓均价) × 数量 × 合约乘数
 *   空头: (开仓均价 − 平仓均价) × 数量 × 合约乘数
 *
 * 手续费 (文档: 负数为支付):
 *   净盈亏 = 毛利 + 开仓手续费份额 + 平仓手续费
 *   例: TradeFee=-0.5 → 净盈亏再减 0.5; TradeFee=+0.1(返佣) → 净盈亏加 0.1
 *
 * 合约乘数:
 *   filledAmt / qty 已是 coinAmt（币数量，如 0.001 BTC），不是张数。
 *   USDT 本位盈亏 = (close-open) × coinQty，乘数应为 1。
 *   仅当 qty 为张数且 boardLotSize>0 时才乘 boardLotSize。
 *   minAmt 是下单步进/最小量，不能当作利润乘数（否则 BTC minAmt=0.001 会把毛利缩小 1000 倍）。
 */

export type RealizedPnlInput = {
  /** long / short */
  positionSide: string;
  /** 开仓成交均价 (开仓单 QueryOrder.PriceAvg) */
  openAvg: number;
  /** 平仓成交均价 (平仓单 QueryOrder.PriceAvg) */
  closeAvg: number;
  /** 本次配对数量 (≤ 平仓 FilledAmt) */
  qty: number;
  /** 开仓手续费按数量分摊份额 (开仓 TradeFee × qty/openFilled) */
  openFeeShare: number;
  /** 平仓手续费份额 (平仓 TradeFee × qty/closeFilled) */
  closeFeeShare: number;
  /** 合约乘数, 默认 1 */
  multiplier?: number;
};

export type RealizedPnlBreakdown = {
  side: 'long' | 'short';
  gross: number;
  fee: number;
  profit: number;
  multiplier: number;
};

export function normalizePositionSide(side: string): 'long' | 'short' {
  return /short|空|2/i.test(side || '') ? 'short' : 'long';
}

/** 利润配对乘数：qty 为 coinAmt 时恒为 1；仅 boardLotSize>0 且 qty 为张数时用 boardLotSize */
export function contractMultiplier(spec?: {
  boardLotSize?: number | null;
  minAmt?: number | null;
  accountType?: string;
}): number {
  // filledAmt 跟单流水里是 coinAmt，不是张数；误用 minAmt 会把 BTC 毛利缩小 ~1000 倍只剩手续费
  void spec;
  return 1;
}

/**
 * 计算已实现盈亏
 * profit = (多 ? close-open : open-close) × qty × multiplier + openFeeShare + closeFeeShare
 */
export function calcRealizedPnl(input: RealizedPnlInput): RealizedPnlBreakdown {
  const side = normalizePositionSide(input.positionSide);
  const qty = Number(input.qty) || 0;
  const openAvg = Number(input.openAvg) || 0;
  const closeAvg = Number(input.closeAvg) || 0;
  const multiplier =
    Number.isFinite(input.multiplier) && (input.multiplier as number) > 0
      ? (input.multiplier as number)
      : 1;

  const priceDiff = side === 'short' ? openAvg - closeAvg : closeAvg - openAvg;
  const gross = priceDiff * qty * multiplier;
  // 文档: 负数为支付 → 直接加到毛利上 (支付为负, 返佣为正)
  const fee = (Number(input.openFeeShare) || 0) + (Number(input.closeFeeShare) || 0);
  const profit = Math.round((gross + fee) * 1e8) / 1e8;

  return { side, gross: Math.round(gross * 1e8) / 1e8, fee, profit, multiplier };
}
