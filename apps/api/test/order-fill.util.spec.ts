import {
  canAttemptRemainderCancel,
  fillDelta,
  fillWatermarkOf,
  hasLiveRemainder,
  isOrderFillComplete,
  isQueryFillUsable,
  REMAINDER_CANCEL_GIVE_UP_MS,
  sliceFillPrice,
} from '../src/modules/trade/order-fill.util';

describe('order-fill.util', () => {
  it('查单 99/空串不可用', () => {
    expect(isQueryFillUsable({ state: 'unknown', filledAmt: 10, priceAvg: 1, tradeFee: 0 })).toBe(
      false,
    );
    expect(isQueryFillUsable({ state: 'partial', filledAmt: 10, priceAvg: 1, tradeFee: 0 })).toBe(
      true,
    );
  });

  it('水位只增：回退 filledAmt 得到 delta=0', () => {
    expect(fillDelta(60, 80)).toBe(0);
    expect(fillDelta(80, 60)).toBe(20);
  });

  it('平仓水位不用 filledAmt 兜底', () => {
    expect(
      fillWatermarkOf({ filledAmt: 60, recordedFilledAmt: 0, profitRecordedAmt: 0 }, true),
    ).toBe(0);
    expect(
      fillWatermarkOf({ filledAmt: 60, recordedFilledAmt: 0, profitRecordedAmt: 20 }, true),
    ).toBe(20);
  });

  it('开仓水位可用 filledAmt 兜底', () => {
    expect(fillWatermarkOf({ filledAmt: 60, recordedFilledAmt: 0, isOpen: true }, false)).toBe(60);
  });

  it('反算单次撮合价', () => {
    const px = sliceFillPrice({
      totalFilled: 80,
      totalAvg: 10.5,
      prevFilled: 60,
      prevAvg: 10,
      delta: 20,
    });
    expect(px).toBeCloseTo(12, 8);
  });

  it('status=0 且已成交视为仍有剩余', () => {
    expect(
      hasLiveRemainder({
        fill: { state: 'open', filledAmt: 60, priceAvg: 10, tradeFee: 0 },
        orderAmt: 100,
        recordedFilled: 60,
      }),
    ).toBe(true);
    expect(
      isOrderFillComplete({
        fill: { state: 'open', filledAmt: 60, priceAvg: 10, tradeFee: 0 },
        orderAmt: 100,
        recordedFilled: 60,
      }),
    ).toBe(false);
  });

  it('全成或已成>=委托量即完成', () => {
    expect(
      isOrderFillComplete({
        fill: { state: 'filled', filledAmt: 100, priceAvg: 1, tradeFee: 0 },
        orderAmt: 100,
        recordedFilled: 100,
      }),
    ).toBe(true);
    expect(
      isOrderFillComplete({
        fill: { state: 'partial', filledAmt: 100, priceAvg: 1, tradeFee: 0 },
        orderAmt: 100,
        recordedFilled: 100,
      }),
    ).toBe(true);
  });

  it('撤余 30s 间隔与 10 分钟放弃', () => {
    const t0 = 1_000_000;
    expect(
      canAttemptRemainderCancel({ now: t0, startedAt: null, lastAttemptAt: null }),
    ).toEqual({ allowed: true, giveUp: false });
    expect(
      canAttemptRemainderCancel({
        now: t0 + 10_000,
        startedAt: new Date(t0),
        lastAttemptAt: new Date(t0),
      }),
    ).toEqual({ allowed: false, giveUp: false });
    expect(
      canAttemptRemainderCancel({
        now: t0 + REMAINDER_CANCEL_GIVE_UP_MS,
        startedAt: new Date(t0),
        lastAttemptAt: new Date(t0),
      }),
    ).toEqual({ allowed: false, giveUp: true });
  });
});
