import { calcRealizedPnl, contractMultiplier } from '../src/modules/trade/pnl.util';

describe('pnl.util', () => {
  it('contractMultiplier 对 coinAmt  qty 恒为 1（minAmt 不是利润乘数）', () => {
    expect(
      contractMultiplier({ minAmt: 0.001, boardLotSize: 0, accountType: 'future' }),
    ).toBe(1);
  });

  it('BTC 多仓 coinAmt=0.001：价差为正则净利为正', () => {
    const lot = calcRealizedPnl({
      positionSide: 'long',
      openAvg: 71210.5,
      closeAvg: 78340.2,
      qty: 0.001,
      openFeeShare: -0.02136315,
      closeFeeShare: -0.02350206,
      multiplier: contractMultiplier({ minAmt: 0.001, accountType: 'future' }),
    });
    expect(lot.gross).toBeCloseTo(7.1297, 4);
    expect(lot.profit).toBeCloseTo(7.08483479, 4);
    expect(lot.profit).toBeGreaterThan(0);
  });

  it('误用 minAmt 作乘数会把毛利压成手续费级负数', () => {
    const wrong = calcRealizedPnl({
      positionSide: 'long',
      openAvg: 71210.5,
      closeAvg: 78340.2,
      qty: 0.001,
      openFeeShare: -0.02136315,
      closeFeeShare: -0.02350206,
      multiplier: 0.001,
    });
    expect(wrong.profit).toBeCloseTo(-0.03773551, 8);
    expect(wrong.profit).toBeLessThan(0);
  });
});
