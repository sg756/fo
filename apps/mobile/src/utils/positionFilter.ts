import { EXCHANGES } from '../api/exchanges';
import type { TradePosition } from '../api/endpoints';

export function exchangeLabel(code: string) {
  const c = String(code || '').trim().toUpperCase();
  return EXCHANGES.find((e) => e.exchange === c)?.name || c || '—';
}

export function exchangesInPositions(items: TradePosition[]) {
  const seen = new Set<string>();
  const out: { code: string; name: string }[] = [];
  for (const p of items) {
    const code = String(p.exchange || '').trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, name: exchangeLabel(code) });
  }
  return out;
}

export function matchPositionCoin(p: TradePosition, q: string) {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  const hay = [p.coinName, p.pair, p.symbol, p.equalCoinName]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(s);
}

export function filterPositions(
  items: TradePosition[],
  opts: { coinQ: string; exchange: string },
) {
  const ex = opts.exchange.trim().toUpperCase();
  return items.filter((p) => {
    if (ex && String(p.exchange || '').toUpperCase() !== ex) return false;
    return matchPositionCoin(p, opts.coinQ);
  });
}
