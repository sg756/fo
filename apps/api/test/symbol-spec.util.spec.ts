import {
  formatDisplayPrice,
  isAtLeastOneContract,
  oneContractCoinAmt,
  snapCoinAmt,
  snapPrice,
} from '../src/modules/trade/symbol-spec.util';

describe('symbol-spec.util', () => {
  const bnb = { minAmt: 0.01, minSize: 1, boardLotSize: 0, priceStep: 0.01, pricePrecision: 2 };

  it('每手：BoardLotSize>0 用它，否则 MinAmt；不用 MinSize', () => {
    expect(oneContractCoinAmt(bnb)).toBeCloseTo(0.01, 8);
    expect(oneContractCoinAmt({ minAmt: 0.01, minSize: 1, boardLotSize: 0.05 })).toBeCloseTo(
      0.05,
      8,
    );
  });

  it('0.006 不够一手（面额 0.01）', () => {
    expect(isAtLeastOneContract(0.006, bnb)).toBe(false);
    expect(isAtLeastOneContract(0.03, bnb)).toBe(true);
  });

  it('coinAmt 按 minAmt 整数倍下取整', () => {
    expect(snapCoinAmt(0.006, bnb)).toBe(0);
    expect(snapCoinAmt(0.029, bnb)).toBe(0.02);
    expect(snapCoinAmt(0.03 - 0.024, bnb)).toBe(0);
  });

  it('BoardLotSize 大于 MinAmt 时按下整张', () => {
    const spec = { minAmt: 1, boardLotSize: 10 };
    expect(snapCoinAmt(12.400000000000006, spec)).toBe(10);
    expect(snapCoinAmt(9, spec)).toBe(0);
  });

  it('自己算价：先 Precision 再有效 tick', () => {
    expect(snapPrice(100.037, { priceStep: 0.01, pricePrecision: 4 })).toBeCloseTo(100.04, 8);
    expect(snapPrice(100.013, { priceStep: 0.01, pricePrecision: 4 })).toBeCloseTo(100.01, 8);
    expect(snapPrice(1.23456, { priceStep: 0.01, pricePrecision: 2 })).toBeCloseTo(1.23, 8);
    expect(snapPrice(100.5, { priceStep: 1, pricePrecision: 4 })).toBe(101);
    expect(snapPrice(0.5518, { priceStep: 1, pricePrecision: 4 })).toBeCloseTo(0.5518, 8);
    expect(snapPrice(0.06667, { priceStep: 1, pricePrecision: 5 })).toBeCloseTo(0.06667, 8);
  });

  it('展示价只按 PricePrecision，不把价收成 tick', () => {
    expect(formatDisplayPrice(123.4567, { priceStep: 0.01, pricePrecision: 4 })).toBe('123.4567');
    expect(formatDisplayPrice(2.7279999999999, { priceStep: 1, pricePrecision: 3 })).toBe('2.728');
  });

  it('兼容 PascalCase 字段', () => {
    const spec = { MinAmt: 10, MinSize: 1, BoardLotSize: 0, PriceStep: 0.01, PricePrecision: 2 };
    expect(oneContractCoinAmt(spec as any)).toBe(10);
    expect(isAtLeastOneContract(9, spec as any)).toBe(false);
    expect(snapCoinAmt(25, spec as any)).toBe(20);
  });
});
