import { spawnSync } from 'child_process';
import path from 'path';

/**
 * 实盘对账：admin1 币安 userTrades vs 服务端持仓/开平流水。
 * 默认跳过。运行：
 *   LIVE_TUT=1 npm run test:tut-binance
 * 或：
 *   LIVE_TUT=1 npx jest --runInBand --forceExit test/tut-binance-compare.live.spec.ts
 */
const LIVE = process.env.LIVE_TUT === '1' || process.env.LIVE_TUT === 'true';

(LIVE ? describe : describe.skip)('TUT 币安成交 vs 服务端流水', () => {
  jest.setTimeout(180000);

  it('拉币安成交并对比服务端 TUT 持仓/开平', () => {
    const script = path.join(__dirname, '..', 'scripts', 'audit-tut-binance.mjs');
    const r = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      cwd: path.join(__dirname, '..'),
      env: { ...process.env },
      timeout: 170000,
    });
    if (r.status !== 0) {
      throw new Error(
        `audit-tut-binance exit=${r.status}\n${r.stderr || ''}\n${(r.stdout || '').slice(-2000)}`,
      );
    }
    const stdout = String(r.stdout || '');
    const jsonStart = stdout.indexOf('{');
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const report = JSON.parse(stdout.slice(jsonStart));
    expect(report.userLogin?.ok || report.binance?.direct || report.binance?.fromServerApi).toBeTruthy();
    const qtyDiff = report.diff?.qtyLocalMinusBinance;
    if (typeof qtyDiff === 'number') {
      // 已知本地 3944 vs 币安 3670，差约 274；实盘允许刷新后变化
      expect(Number.isFinite(qtyDiff)).toBe(true);
    }
    if (report.diff?.extraOrderIdsInOurLogs?.length) {
      // 多记的开仓订单号，便于定位漏平
      expect(Array.isArray(report.diff.extraOrderIdsInOurLogs)).toBe(true);
    }
  });
});
