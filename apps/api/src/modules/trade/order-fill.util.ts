/** 查单增量入账 / 部成撤余：纯函数，供 TradeService 与单测共用 */

export const FILL_EPS = 1e-12;
export const FILL_COMPLETE_EPS = 1e-8;
export const REMAINDER_CANCEL_INTERVAL_MS = 30_000;
export const REMAINDER_CANCEL_GIVE_UP_MS = 10 * 60 * 1000;

export type FillSnapshot = {
  state: 'open' | 'partial' | 'filled' | 'cancelled' | 'unknown';
  filledAmt: number;
  priceAvg: number;
  tradeFee: number;
  errorMsg?: string;
};

/** 查单数字是否可用。99 / 空串 / unknown 一律作废。 */
export function isQueryFillUsable(fill: FillSnapshot): boolean {
  return (
    fill.state === 'open' ||
    fill.state === 'partial' ||
    fill.state === 'filled' ||
    fill.state === 'cancelled'
  );
}

export function orderAmtOf(log: {
  orderAmt?: any;
  requestBody?: string | null;
}): number {
  const n = Number(log.orderAmt ?? 0);
  if (Number.isFinite(n) && n > FILL_EPS) return n;
  try {
    const meta = log.requestBody ? JSON.parse(log.requestBody) : {};
    const a = Number(meta.amount ?? meta.followAmount ?? meta.sizedFromSignal ?? 0);
    return Number.isFinite(a) && a > FILL_EPS ? a : 0;
  } catch {
    return 0;
  }
}

/**
 * 已入账水位。开仓：可用 filledAmt 兜底（持仓由 filledAmt 汇总，避免重复加仓）。
 * 平仓：只用 recordedFilledAmt / profitRecordedAmt，避免「流水有量、仓没减」被跳过。
 */
export function fillWatermarkOf(
  log: {
    recordedFilledAmt?: any;
    profitRecordedAmt?: any;
    filledAmt?: any;
    isOpen?: boolean | null;
  },
  looksClose: boolean,
): number {
  const rec = Number(log.recordedFilledAmt ?? 0);
  if (Number.isFinite(rec) && rec > FILL_EPS) return rec;
  if (looksClose) {
    const pnl = Number(log.profitRecordedAmt ?? 0);
    return Number.isFinite(pnl) && pnl > FILL_EPS ? pnl : 0;
  }
  const filled = Number(log.filledAmt ?? 0);
  return Number.isFinite(filled) && filled > FILL_EPS ? filled : 0;
}

/** Δqty = 查单累计 − 水位；水位只增，回退视为 0。 */
export function fillDelta(filledAmt: number, watermark: number): number {
  const f = Number(filledAmt) || 0;
  const w = Number(watermark) || 0;
  if (!(f > FILL_EPS)) return 0;
  const d = f - w;
  return d > FILL_EPS ? d : 0;
}

/** 单次撮合价：(F×P − F_prev×P_prev) / Δqty */
export function sliceFillPrice(params: {
  totalFilled: number;
  totalAvg: number;
  prevFilled: number;
  prevAvg: number;
  delta: number;
}): number {
  const { totalFilled, totalAvg, prevFilled, prevAvg, delta } = params;
  if (!(delta > FILL_EPS)) return 0;
  if (prevFilled > FILL_EPS && prevAvg > 0 && totalFilled > prevFilled + FILL_EPS) {
    const marginal = (totalFilled * totalAvg - prevFilled * prevAvg) / delta;
    if (Number.isFinite(marginal) && marginal > 0) return marginal;
  }
  const avg = Number(totalAvg) || 0;
  return avg > 0 ? avg : 0;
}

export function sliceFillFee(totalFee: number, prevFee: number, delta: number, totalFilled: number): number {
  const fee = Number(totalFee) || 0;
  const prev = Number(prevFee) || 0;
  if (totalFilled > FILL_EPS && Math.abs(fee - prev) > FILL_EPS) return fee - prev;
  if (totalFilled > FILL_EPS && delta > FILL_EPS) return fee * (delta / totalFilled);
  return 0;
}

export function isOrderFillComplete(params: {
  fill: FillSnapshot;
  orderAmt: number;
  recordedFilled: number;
}): boolean {
  const { fill, orderAmt, recordedFilled } = params;
  if (fill.state === 'filled' || fill.state === 'cancelled') return true;
  const filled = Math.max(Number(fill.filledAmt) || 0, Number(recordedFilled) || 0);
  if (orderAmt > FILL_EPS && filled + FILL_COMPLETE_EPS >= orderAmt) return true;
  return false;
}

/** 还有剩余挂单需要撤：部成，或 status=0 但已有成交。 */
export function hasLiveRemainder(params: {
  fill: FillSnapshot;
  orderAmt: number;
  recordedFilled: number;
}): boolean {
  if (isOrderFillComplete(params)) return false;
  if (params.fill.state === 'unknown') return false;
  const filled = Number(params.fill.filledAmt) || 0;
  if (params.fill.state === 'partial') return true;
  if (params.fill.state === 'open' && filled > FILL_EPS) return true;
  return false;
}

export function canAttemptRemainderCancel(params: {
  now: number;
  startedAt?: Date | null;
  lastAttemptAt?: Date | null;
  intervalMs?: number;
  giveUpMs?: number;
}): { allowed: boolean; giveUp: boolean } {
  const interval = params.intervalMs ?? REMAINDER_CANCEL_INTERVAL_MS;
  const giveUpMs = params.giveUpMs ?? REMAINDER_CANCEL_GIVE_UP_MS;
  const started = params.startedAt ? params.startedAt.getTime() : 0;
  if (started > 0 && params.now - started >= giveUpMs) {
    return { allowed: false, giveUp: true };
  }
  const last = params.lastAttemptAt ? params.lastAttemptAt.getTime() : 0;
  if (last > 0 && params.now - last < interval) {
    return { allowed: false, giveUp: false };
  }
  return { allowed: true, giveUp: false };
}
