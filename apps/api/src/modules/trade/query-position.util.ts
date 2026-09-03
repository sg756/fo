/**
 * 解析 mapi/QueryPosition 整户快照，并与本地 user_positions 对齐用的键。
 * 跟单主路径只打 accountType=future；永续计价 USDT/USDC 视作 PC。
 */

export type QueryPositionParsed = {
  coinName: string;
  equalCoinName: string;
  positionSide: 'long' | 'short';
  positionAmt: number;
  openPrice: number;
  /** >0 才覆盖；0 / 缺省为 null */
  margin: number | null;
  leverage: number | null;
  /** QueryPosition LiquidationPrice；0 / 缺省为 null */
  liqPrice: number | null;
  /** QueryPosition Risk；0 / 缺省为 null */
  risk: number | null;
  symbol: string;
};

export function queryPositionMatchKey(
  coinName: string,
  equalCoinName: string,
  positionSide: string,
): string {
  return [
    String(coinName || '').toUpperCase(),
    normalizeFutureEqualCoin(equalCoinName),
    String(positionSide || 'long').toLowerCase().includes('short') ? 'short' : 'long',
  ].join('|');
}

/** 合约永续：USDT / USDC / USD / U → PC，与本地 equalCoinName 对齐 */
export function normalizeFutureEqualCoin(raw: string | null | undefined): string {
  const e = String(raw || '').toUpperCase().trim();
  if (!e || e === 'USDT' || e === 'USDC' || e === 'USD' || e === 'U' || e === 'PERP') {
    return 'PC';
  }
  return e;
}

export function parseHoldSide(row: {
  holdType?: unknown;
  holdTypeName?: unknown;
  positionSide?: unknown;
  positionAmt?: unknown;
}): 'long' | 'short' {
  const name = String(row.holdTypeName || '').trim();
  if (/空|short/i.test(name)) return 'short';
  if (/多|long/i.test(name)) return 'long';
  const side = String(row.positionSide || '').toLowerCase();
  if (side.includes('short') || side === '2') return 'short';
  if (side.includes('long') || side === '1') return 'long';
  const ht = row.holdType;
  if (ht === 2 || ht === '2' || String(ht).toLowerCase() === 'short') return 'short';
  if (ht === 1 || ht === '1' || String(ht).toLowerCase() === 'long') return 'long';
  const amt = Number(row.positionAmt);
  if (Number.isFinite(amt) && amt < 0) return 'short';
  return 'long';
}

function parseSymbolParts(symbol: string): { coin: string; equalCoin: string } {
  const s = String(symbol || '').toUpperCase().trim();
  const m = s.match(/^([A-Z0-9]+)[/\-_]([A-Z0-9]+)$/);
  if (m) return { coin: m[1], equalCoin: m[2] };
  const quotes = ['USDT', 'USDC', 'FDUSD', 'USD', 'BTC', 'ETH', 'EUR'];
  for (const q of quotes) {
    if (s.endsWith(q) && s.length > q.length) {
      return { coin: s.slice(0, s.length - q.length), equalCoin: q };
    }
  }
  return { coin: s, equalCoin: 'PC' };
}

function pickPositiveNum(row: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const n = Number(row[k]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function pickPositiveMargin(row: Record<string, unknown>): number | null {
  return pickPositiveNum(row, [
    'margin',
    'isolatedMargin',
    'initialMargin',
    'positionInitialMargin',
    'isolated_margin',
    'initial_margin',
  ]);
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** 从 QueryPosition data 抽出持仓行；errorMsg 非空时由调用方当失败，不要拿空表去废弃本地仓 */
export function parseQueryPositionPayload(data: unknown): QueryPositionParsed[] {
  const root = asRecord(data);
  const nested = asRecord(root.data);
  const rawList =
    (Array.isArray(root.positions) && root.positions) ||
    (Array.isArray(nested.positions) && nested.positions) ||
    (Array.isArray(data) && data) ||
    [];
  const out: QueryPositionParsed[] = [];
  for (const item of rawList) {
    const row = asRecord(item);
    const symbol = String(row.symbol || row.instrumentID || '').trim();
    const parsed = parseSymbolParts(symbol);
    const coinName = String(row.coinName || parsed.coin || '')
      .toUpperCase()
      .trim();
    if (!coinName) continue;
    const equalCoinName = normalizeFutureEqualCoin(
      String(row.equalCoinName || parsed.equalCoin || 'PC'),
    );
    const amtRaw = Number(row.positionAmt ?? row.positionSize ?? row.size ?? 0);
    if (!Number.isFinite(amtRaw) || amtRaw === 0) continue;
    const positionAmt = Math.abs(amtRaw);
    const openPrice = Number(row.openPrice ?? row.entryPrice ?? row.avgPrice ?? 0);
    const lev = Number(row.leverage);
    out.push({
      coinName,
      equalCoinName,
      positionSide: parseHoldSide({
        holdType: row.holdType,
        holdTypeName: row.holdTypeName,
        positionSide: row.positionSide,
        positionAmt: amtRaw,
      }),
      positionAmt,
      openPrice: Number.isFinite(openPrice) && openPrice > 0 ? openPrice : 0,
      margin: pickPositiveMargin(row),
      leverage: Number.isFinite(lev) && lev > 0 ? lev : null,
      liqPrice: pickPositiveNum(row, ['liquidationPrice', 'LiquidationPrice', 'liqPrice']),
      risk: pickPositiveNum(row, ['risk', 'Risk']),
      symbol: symbol || `${coinName}/${equalCoinName}`,
    });
  }
  return out;
}

export function numbersDiffer(a: number, b: number, eps = 1e-8): boolean {
  if (!Number.isFinite(a) && !Number.isFinite(b)) return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return Math.abs(a - b) > eps;
}

/**
 * 预估强平价（爆仓价）：
 * 1) QueryPosition LiquidationPrice>0 用回包；
 * 2) 否则 标记价*(风险率/1.1)；
 * 3) 再没有则按开仓价与杠杆估算：多 entry*(1-1/lev)，空 entry*(1+1/lev)。
 */
export function estimateLiquidationPrice(opts: {
  liqPrice?: number | null;
  risk?: number | null;
  markPrice?: number | null;
  entryPrice?: number | null;
  leverage?: number | null;
  side?: string | null;
}): number | null {
  const liq = Number(opts.liqPrice);
  if (Number.isFinite(liq) && liq > 0) return liq;
  const risk = Number(opts.risk);
  const mark = Number(opts.markPrice);
  if (Number.isFinite(risk) && risk > 0 && Number.isFinite(mark) && mark > 0) {
    const n = mark * (risk / 1.1);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const entry = Number(opts.entryPrice);
  const lev = Number(opts.leverage);
  if (Number.isFinite(entry) && entry > 0 && Number.isFinite(lev) && lev > 1) {
    const dist = 1 / lev;
    const short = String(opts.side || '').toLowerCase().includes('short');
    const n = short ? entry * (1 + dist) : entry * (1 - dist);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
