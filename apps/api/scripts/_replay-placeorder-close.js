/**
 * 同一笔 MOVE 195 平多，市价 + GetDepth 标记价，打一次 PlaceOrder。
 */
require('dotenv').config({ path: '.env.dev' });
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { decrypt } = require('../dist/common/crypto.util');

const USER_ID = 'cmsrdx0as00072vfrtv6bkg7s';
const COIN = 'MOVE';
const EQUAL = 'PC';
const AMOUNT = 195;
const DEPTH_KEY = 'MOVE_PC_BAC';

const p = new PrismaClient();

function mask(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

function snapCoinAmt(amount, spec) {
  const step = Number(spec.minAmt || 0);
  const lot = Number(spec.boardLotSize || 0);
  const face = lot > 0 ? lot : step > 0 ? step : 0;
  let qty = Number(amount) || 0;
  const align = (v, s) => {
    if (!(s > 0)) return v;
    const n = Math.floor(v / s + 1e-12);
    return n <= 0 ? 0 : Number((n * s).toFixed(12));
  };
  if (step > 0) qty = align(qty, step);
  else if (face > 0) qty = align(qty, face);
  if (face > 0 && face - step > 1e-12) qty = align(qty, face);
  return qty;
}

function parseFirstLevelMid(value) {
  if (typeof value === 'number') return value > 0 ? value : null;
  if (!Array.isArray(value) || value.length < 5) return null;
  const rest = value.length - 1;
  if (rest % 4 !== 0) return null;
  const n = rest / 4;
  const ask = Number(value[1]);
  const bid = Number(value[1 + 2 * n]);
  if (ask > 0 && bid > 0) return (ask + bid) / 2;
  if (ask > 0) return ask;
  if (bid > 0) return bid;
  return null;
}

async function mapiHeaders(serviceKey) {
  const language = process.env.TRADE_LANGUAGE || 'zh-Hans';
  const nonce = crypto.randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const versionCode = process.env.TRADE_VERSION_CODE || '20260012';
  const clientType = process.env.TRADE_CLIENT_TYPE || 'win';
  const raw = `${language}:${nonce}:${timestamp}:${versionCode}:${clientType}:${serviceKey}`;
  const signature = crypto.createHash('md5').update(raw).digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-Client-Language': language,
    'X-Client-Nonce': nonce,
    'X-Client-Timestamp': timestamp,
    'X-Client-VersionCode': versionCode,
    'X-Client-ClientType': clientType,
    'X-Client-Signature': signature,
  };
}

(async () => {
  const baseRow = await p.systemConfig.findUnique({ where: { key: 'trade_middleware_base' } });
  const keyRow = await p.systemConfig.findUnique({
    where: { key: 'trade_middleware_service_key' },
  });
  const base = String(baseRow?.value || process.env.TRADE_MIDDLEWARE_BASE || '')
    .trim()
    .replace(/\/$/, '');
  const serviceKey = String(keyRow?.value || process.env.TRADE_SERVICE_KEY || '').trim();
  if (!base || !serviceKey) throw new Error('middleware base/key missing');

  const listHeaders = await mapiHeaders(serviceKey);
  const listRes = await fetch(`${base}/mapi/CryptoSymbolList`, { headers: listHeaders });
  const listJson = await listRes.json();
  const list = Array.isArray(listJson) ? listJson : listJson?.data || [];
  const symbolSpec = list.find(
    (s) =>
      String(s.apiCode || '').toLowerCase() === 'bac' &&
      String(s.coinName || '').toUpperCase() === COIN &&
      String(s.equalCoinName || '').toUpperCase() === EQUAL,
  );
  if (!symbolSpec) throw new Error('symbol spec miss bac/MOVE/PC');

  const depthHeaders = await mapiHeaders(serviceKey);
  const depthStarted = Date.now();
  const depthRes = await fetch(`${base}/mapi/GetDepth`, { headers: depthHeaders });
  const depthText = await depthRes.text();
  const depthMs = Date.now() - depthStarted;
  let depthJson;
  try {
    depthJson = JSON.parse(depthText);
  } catch {
    console.log('=== GetDepth parse fail ===', { status: depthRes.status, bytes: depthText.length });
    throw new Error('GetDepth JSON parse fail');
  }
  const depthMap =
    depthJson && typeof depthJson === 'object' && depthJson.data && !Array.isArray(depthJson.data)
      ? depthJson.data
      : depthJson;
  const rawDepth = depthMap?.[DEPTH_KEY] ?? depthMap?.[DEPTH_KEY.toLowerCase()];
  const mid = parseFirstLevelMid(rawDepth);
  const prec = Number(symbolSpec.pricePrecision);
  const markPrice =
    mid && Number.isFinite(prec) && prec >= 0 && prec <= 12 ? Number(mid.toFixed(prec)) : mid;
  console.log('=== GetDepth mark ===');
  console.log(
    JSON.stringify({
      http: depthRes.status,
      latencyMs: depthMs,
      bytes: depthText.length,
      key: DEPTH_KEY,
      rawHead: Array.isArray(rawDepth) ? rawDepth.slice(0, 5) : rawDepth,
      mid,
      markPrice,
      specPriceStep: symbolSpec.priceStep,
      specPricePrecision: symbolSpec.pricePrecision,
    }),
  );
  if (!(markPrice > 0)) throw new Error('GetDepth 未取到 MOVE_PC_BAC 标记价');

  const keyRowEx = await p.exchangeKey.findFirst({
    where: { userId: USER_ID, exchange: 'BINANCE', active: true },
  });
  if (!keyRowEx) throw new Error('no BINANCE key');
  const user = await p.user.findUnique({
    where: { id: USER_ID },
    select: { nickname: true, email: true },
  });
  const apiKey = decrypt(keyRowEx.encApiKey);
  const apiSecret = decrypt(keyRowEx.encApiSecret);
  const passphrase = keyRowEx.encPassphrase ? decrypt(keyRowEx.encPassphrase) : '';
  const accountName =
    user?.nickname?.trim() || user?.email?.split('@')[0]?.trim() || USER_ID;

  const assign = await p.ipAssignment.findUnique({
    where: { userId: USER_ID },
    include: { proxy: true },
  });
  let proxyIP = '';
  if (assign?.proxy?.active && assign.proxy.healthy) {
    const host = String(assign.proxy.host || '').trim();
    const port = Number(assign.proxy.port);
    proxyIP = Number.isFinite(port) && port > 0 ? `${host}:${port}` : host;
  }

  const coinAmt = snapCoinAmt(AMOUNT, symbolSpec);
  const body = {
    proxyIP,
    symbol: symbolSpec,
    account: {
      gid: keyRowEx.id,
      apiCode: symbolSpec.apiCode || 'bac',
      apiName: symbolSpec.apiName || '币安',
      accountName,
      apiKey,
      apiSecret,
      passphrase: passphrase || '',
      extendedAttr: '',
      extendedAttr2: '',
      innerExtendedAttr: '',
      createTime: new Date().toISOString(),
    },
    isOpen: false,
    accountType: 'future',
    leverage: 1,
    coinAmt,
    price: markPrice,
    tradeType: 1,
    orderType: 1,
    limitDepthOption: 0,
    baseQuoteLastPrice: markPrice,
  };

  const safeReq = JSON.parse(JSON.stringify(body));
  safeReq.account.apiKey = mask(safeReq.account.apiKey);
  safeReq.account.apiSecret = '***';
  if (safeReq.account.passphrase) safeReq.account.passphrase = '***';
  console.log('=== PlaceOrder request (redacted) ===');
  console.log(
    JSON.stringify(
      {
        proxyIP: safeReq.proxyIP,
        symbol: {
          apiCode: safeReq.symbol.apiCode,
          coinName: safeReq.symbol.coinName,
          equalCoinName: safeReq.symbol.equalCoinName,
          minAmt: safeReq.symbol.minAmt,
          minSize: safeReq.symbol.minSize,
          boardLotSize: safeReq.symbol.boardLotSize,
          priceStep: safeReq.symbol.priceStep,
          pricePrecision: safeReq.symbol.pricePrecision,
        },
        account: {
          gid: safeReq.account.gid,
          apiCode: safeReq.account.apiCode,
          accountName: safeReq.account.accountName,
          apiKey: safeReq.account.apiKey,
        },
        isOpen: safeReq.isOpen,
        accountType: safeReq.accountType,
        leverage: safeReq.leverage,
        coinAmt: safeReq.coinAmt,
        price: safeReq.price,
        tradeType: safeReq.tradeType,
        orderType: safeReq.orderType,
        baseQuoteLastPrice: safeReq.baseQuoteLastPrice,
      },
      null,
      2,
    ),
  );

  const placeHeaders = await mapiHeaders(serviceKey);
  const started = Date.now();
  const placeRes = await fetch(`${base}/mapi/PlaceOrder`, {
    method: 'POST',
    headers: placeHeaders,
    body: JSON.stringify(body),
  });
  const rawText = await placeRes.text();
  console.log('=== raw HTTP ===');
  console.log(JSON.stringify({ status: placeRes.status, latencyMs: Date.now() - started, bytes: rawText.length }));
  console.log('=== raw body ===');
  console.log(rawText);

  await p.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});
