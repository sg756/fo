const SPOT_QUOTES = new Set([
  'U',
  'USDT',
  'USDC',
  'USD',
  'BTC',
  'ETH',
  'EUR',
  'FDUSD',
  'DAI',
  'TUSD',
]);

/** 与后台结算币一致。PC 是永续周期，不能当成 USDT。 */
const API_CODE_KIND: Record<string, string> = {
  ba: 'spot',
  bac: 'usdt-perp',
  bab: 'usdc-perp',
  bap: 'coin-perp',
  bas: 'coin-delivery',
  ok: 'spot',
  okp: 'usdt-perp',
  oks: 'coin-perp',
  oku: 'usdt-delivery',
  okc: 'coin-delivery',
  bg: 'spot',
  bgu: 'usdt-perp',
  bgc: 'usdc-perp',
  by: 'spot',
  byu: 'usdt-perp',
  byp: 'usdc-perp',
  gt: 'spot',
  gs: 'stock-spot',
  gtc: 'usdt-perp',
  hb: 'spot',
  hbp: 'usdt-perp',
  kc: 'spot',
  kcp: 'usdt-perp',
  kcc: 'usdc-perp',
  hpc: 'usdc-perp',
  hk: 'spot',
  bp: 'spot',
  bpc: 'usdc-perp',
  at: 'spot',
  atc: 'usdt-perp',
  ltc: 'usdc-perp',
};

type QuoteRow = {
  coinName?: string | null;
  pair?: string | null;
  symbol?: string | null;
  apiCode?: string | null;
  equalCoinName?: string | null;
  accountType?: string | null;
};

function kindOf(row: QuoteRow): string {
  return API_CODE_KIND[String(row.apiCode || '').trim().toLowerCase()] || '';
}

export function positionCoin(row: QuoteRow): string {
  const coin = String(row.coinName || '').trim().toUpperCase();
  if (coin) return coin;
  const raw = String(row.pair || row.symbol || '').trim();
  const head = raw.split('/')[0]?.trim();
  return head || raw || '—';
}

/** USDT永续 / USDC永续 / 币本位永续 / 现货。没有 apiCode 时不把 PC 猜成 USDT。 */
export function positionProductLabel(row: QuoteRow): string {
  const kind = kindOf(row);
  const eq = String(row.equalCoinName || '').trim().toUpperCase();
  const at = String(row.accountType || '').trim().toLowerCase();
  if (kind === 'usdt-perp') return 'USDT永续';
  if (kind === 'usdc-perp') return 'USDC永续';
  if (kind === 'coin-perp') return '币本位永续';
  if (kind === 'usdt-delivery') return eq && eq !== 'PC' ? `USDT交割(${eq})` : 'USDT交割';
  if (kind === 'coin-delivery') return eq && eq !== 'PC' ? `币本位交割(${eq})` : '币本位交割';
  if (kind === 'spot' || kind === 'stock-spot' || at === 'spot' || SPOT_QUOTES.has(eq)) {
    return eq ? `现货 ${eq}` : '现货';
  }
  if (eq === 'PC') return '永续';
  if (eq) return `交割(${eq})`;
  return '';
}
