/** Probe exchange rate-limit headers + simulate ban detection (no intentional ban). */
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backoffPath = path.resolve(__dirname, '../src/common/poll-backoff.ts');

// Compile-free: duplicate minimal helpers matching src (then also dynamic-import dist if present)
function pickRateLimitHeaders(headers) {
  const out = {};
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (
      k === 'retry-after' ||
      k.startsWith('x-mbx-') ||
      k.startsWith('x-bapi-') ||
      k.startsWith('ok-access-') ||
      k.startsWith('x-bitget-') ||
      k.startsWith('x-gate-') ||
      k.includes('rate') ||
      k.includes('limit') ||
      k.includes('weight')
    ) {
      out[key] = value;
    }
  });
  return out;
}

function isAccessBlockedError(err) {
  const status = Number(err?.status ?? err?.statusCode ?? 0);
  if (status === 418 || status === 429) return true;
  const msg = String(err?.message || err || '').toLowerCase();
  const body = String(err?.bodySnippet || err?.raw?.body || err?.body || '').toLowerCase();
  const text = `${msg} ${body}`.trim();
  if (!text) return false;
  if (/\b418\b/.test(text) || /\b429\b/.test(text)) return true;
  return /rate.?limit|too many requests|too many visits|too_many_requests|ip.?ban|auto-?ban|\bbanned\b|temporarily banned|request weight|50011/.test(
    text,
  );
}

const SKIP_HDR = new Set([
  'date',
  'content-type',
  'content-length',
  'connection',
  'server',
  'cf-ray',
  'cf-cache-status',
  'set-cookie',
  'vary',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
  'x-xss-protection',
  'cache-control',
  'pragma',
  'expires',
  'transfer-encoding',
  'alt-svc',
  'nel',
  'report-to',
]);

const endpoints = [
  { ex: 'BINANCE', url: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT' },
  { ex: 'OKX', url: 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT' },
  { ex: 'BYBIT', url: 'https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT' },
  { ex: 'BITGET', url: 'https://api.bitget.com/api/v2/spot/market/tickers?symbol=BTCUSDT' },
  { ex: 'GATE', url: 'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT' },
];

const skipLive = process.env.SKIP_LIVE === '1';
const live = [];
if (!skipLive) {
for (const ep of endpoints) {
  const started = Date.now();
  try {
    const res = await fetch(ep.url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'FlowOrder-probe/1.0' },
    });
    const allHeaders = {};
    res.headers.forEach((v, k) => {
      allHeaders[k] = v;
    });
    const rateHeaders = pickRateLimitHeaders(res.headers);
    const body = (await res.text()).slice(0, 200);
    live.push({
      ex: ep.ex,
      status: res.status,
      ms: Date.now() - started,
      rateHeaders,
      otherInteresting: Object.fromEntries(
        Object.entries(allHeaders)
          .filter(([k]) => !SKIP_HDR.has(k.toLowerCase()))
          .slice(0, 25),
      ),
      bodyHead: body.replace(/\s+/g, ' '),
    });
  } catch (e) {
    live.push({ ex: ep.ex, error: e.message || String(e), ms: Date.now() - started });
  }
}
} // end live

const simulated = [
  {
    ex: 'BINANCE',
    status: 418,
    body: '{"code":-1003,"msg":"Way too many requests; IP banned until 1710000000000."}',
    headers: { 'Retry-After': '120', 'X-MBX-USED-WEIGHT-1M': '6000' },
  },
  {
    ex: 'BINANCE',
    status: 429,
    body: '{"code":-1003,"msg":"Too many requests; current limit is 6000 request weight per 1 MINUTE."}',
    headers: { 'Retry-After': '5', 'X-MBX-USED-WEIGHT-1M': '6001' },
  },
  {
    ex: 'OKX',
    status: 429,
    body: '{"code":"50011","msg":"Rate limit reached. Please try again later."}',
    headers: { 'OK-ACCESS-RATE-LIMIT-REMAINING': '0' },
  },
  {
    ex: 'BYBIT',
    status: 403,
    body: '{"retCode":10006,"retMsg":"Too many visits. Exceeded the API Rate Limit."}',
    headers: {
      'X-Bapi-Limit': '120',
      'X-Bapi-Limit-Status': '0',
      'X-Bapi-Limit-Reset-Timestamp': '1710000000000',
    },
  },
  {
    ex: 'BYBIT',
    status: 429,
    body: '{"retCode":10006,"retMsg":"Too many visits!"}',
    headers: { 'X-Bapi-Limit-Status': '0' },
  },
  {
    ex: 'BITGET',
    status: 429,
    body: '{"code":"429","msg":"Too Many Requests"}',
    headers: { 'X-Bitget-RateLimit-Remaining': '0' },
  },
  {
    ex: 'GATE',
    status: 429,
    body: '{"label":"TOO_MANY_REQUESTS","message":"Request rate limit exceeded"}',
    headers: { 'X-Gate-RateLimit-Requests-Remain': '0', 'X-Gate-RateLimit-Limit': '200' },
  },
  {
    ex: 'OKX_BODY_ONLY',
    status: 200,
    body: '{"code":"50011","msg":"Rate limit reached"}',
    headers: {},
    note: 'HTTP200 but body says rate limit — common OKX pitfall',
  },
];

const simResults = [];
for (const s of simulated) {
  const h = new Headers(s.headers);
  const rateHeaders = pickRateLimitHeaders(h);
  let bodyMsg = s.body;
  try {
    const j = JSON.parse(s.body);
    bodyMsg = j.msg || j.retMsg || j.message || j.label || s.body;
  } catch {
    /* keep */
  }
  const byHttp = isAccessBlockedError({
    message: `${s.ex} HTTP ${s.status}`,
    status: s.status,
  });
  const byBody = isAccessBlockedError({ message: bodyMsg, status: s.status, bodySnippet: s.body });
  const byCombined = isAccessBlockedError({
    message: `${s.ex} HTTP ${s.status}`,
    status: s.status,
    bodySnippet: s.body,
  });
  // 纯 403 无 body：不应退避
  const by403Only =
    s.status === 403
      ? isAccessBlockedError({ message: `${s.ex} HTTP 403`, status: 403 })
      : undefined;
  simResults.push({
    ex: s.ex,
    status: s.status,
    note: s.note,
    pickedHeaders: rateHeaders,
    bodyMsg,
    detect: { byHttpStatus: byHttp, byBodyMsg: byBody, byStatusPlusBody: byCombined, by403Only },
    sampleLogRaw: {
      status: s.status,
      rateHeaders,
      body: s.body.slice(0, 180),
    },
  });
}

console.log(JSON.stringify({ live, simResults }, null, 2));
