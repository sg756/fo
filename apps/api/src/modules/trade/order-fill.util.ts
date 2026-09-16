/** 查单累计入账 / 部成撤余：纯函数，供 TradeService 与单测共用 */

export const FILL_EPS = 1e-12;
export const FILL_COMPLETE_EPS = 1e-8;
export const REMAINDER_CANCEL_INTERVAL_MS = 30_000;
export const REMAINDER_CANCEL_GIVE_UP_MS = 10 * 60 * 1000;
/** 撤余后本地已结束，仍查同一订单号补累计日志的窗口 */
export const FILL_CATCH_UP_MS = 15 * 60 * 1000;

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
 * 已入账水位：只用 recordedFilledAmt（平仓还可兜底 profitRecordedAmt）。
 * 部成只写 filledAmt 快照，不能把快照当成已入账，否则撤后再查会只记差额。
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
  return 0;
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

export type FillKindLabel = 'FULL' | 'PARTIAL' | 'NONE';

export type FillBookPlan = {
  qty: number;
  avg: number;
  /** 查单累计 TradeFee；仅首次入账整笔带上，避免同一单再拆 */
  fee: number;
};

export type FillApplyPlan = {
  complete: boolean;
  remainder: boolean;
  fillKind: FillKindLabel;
  book: FillBookPlan | null;
  reason: string;
};

export function isFillCatchUpActive(params: {
  now: number;
  lastCancelAttemptAt?: Date | null;
  catchUpMs?: number;
}): boolean {
  const last = params.lastCancelAttemptAt?.getTime() ?? 0;
  if (!(last > 0)) return false;
  return params.now - last <= (params.catchUpMs ?? FILL_CATCH_UP_MS);
}

/**
 * 查单汇总怎么写入原记录：部成等撤余；撤过或查单终态则按累计整笔覆盖，不切片。
 */
export function planFillFromQuery(params: {
  fill: FillSnapshot;
  finalFill?: boolean;
  forceSettle?: boolean;
  orderAmt: number;
  looksClose: boolean;
  watermark: number;
}): FillApplyPlan {
  const totalFilled = Number(params.fill.filledAmt) || 0;
  const totalAvg = Number(params.fill.priceAvg) || 0;
  const totalFee = Number(params.fill.tradeFee) || 0;
  const recordedGuess = Math.max(params.watermark, totalFilled);
  const complete =
    !!params.forceSettle ||
    !!params.finalFill ||
    isOrderFillComplete({
      fill: params.fill,
      orderAmt: params.orderAmt,
      recordedFilled: recordedGuess,
    });
  const remainder = hasLiveRemainder({
    fill: params.fill,
    orderAmt: params.orderAmt,
    recordedFilled: recordedGuess,
  });
  const fillKind: FillKindLabel = complete
    ? totalFilled > FILL_EPS
      ? 'FULL'
      : 'NONE'
    : totalFilled > FILL_EPS
      ? 'PARTIAL'
      : 'NONE';

  if (!complete) {
    return {
      complete: false,
      remainder,
      fillKind,
      book: null,
      reason: remainder ? 'partial-wait-cancel' : 'snapshot',
    };
  }

  return {
    complete: true,
    remainder: false,
    fillKind,
    book: {
      qty: totalFilled,
      avg: totalAvg,
      fee: totalFee,
    },
    reason: params.watermark > FILL_EPS ? 'log-overwrite' : params.looksClose ? 'close-cumulative' : 'open-cumulative',
  };
}

/** 持仓列表：按同一订单号终态，与仓位是否减完无关。 */
export function closeKindFromFillLog(log?: {
  fillKind?: string | null;
  status?: string | null;
  filledAmt?: unknown;
} | null): 'FULL' | 'PARTIAL' {
  if (!log) return 'FULL';
  if (String(log.fillKind || '').toUpperCase() === 'FULL') return 'FULL';
  const st = String(log.status || '').toUpperCase();
  if (st === 'FILLED' || st === 'CANCELLED') return 'FULL';
  if (st === 'PLACED' || st === 'CANCEL_FAILED') {
    return Number(log.filledAmt) > FILL_EPS ? 'PARTIAL' : 'FULL';
  }
  return String(log.fillKind || '').toUpperCase() === 'PARTIAL' ? 'PARTIAL' : 'FULL';
}
