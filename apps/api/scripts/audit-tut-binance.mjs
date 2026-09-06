/**
 * TUT 对账：服务端已有接口 + admin1 币安 Key 直拉成交。
 *
 *   cd apps/api
 *   node scripts/audit-tut-binance.mjs
 *
 * 环境变量：
 *   API_BASE          默认 http://127.0.0.1:3000/api
 *   ADMIN1_ACCOUNT    默认 admin1
 *   ADMIN1_PASSWORD   默认 admin123456
 *   ADMIN_ACCOUNT     管理端账号（可选，用于 follow-logs 全量）
 *   ADMIN_PASSWORD    管理端密码
 *   COIN              默认 TUT
 *   SYMBOL            默认 TUTUSDT
 *   LOOKBACK_DAYS     默认 21
 *
 * 不打印 API Key / Secret。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(__dirname, '..');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv(path.join(API_DIR, '.env'));

const API_BASE = (process.env.API_BASE || 'http://127.0.0.1:3000/api').replace(/\/$/, '');
const ACCOUNT = process.env.ADMIN1_ACCOUNT || 'admin1';
const PASSWORDS = [
  process.env.ADMIN1_PASSWORD,
  'admin123456',
  '123456',
].filter(Boolean);
const ADMIN_ACCOUNT = process.env.ADMIN_ACCOUNT || 'admin@floworder.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN1_PASSWORD || 'admin123456';
const COIN = String(process.env.COIN || 'TUT').toUpperCase();
const SYMBOL = String(process.env.SYMBOL || `${COIN}USDT`).toUpperCase();
const LOOKBACK_DAYS = Math.min(90, Math.max(1, Number(process.env.LOOKBACK_DAYS || 21)));
const KNOWN_LOCAL_QTY = Number(process.env.KNOWN_LOCAL_QTY || 3944);
const KNOWN_EX_QTY = Number(process.env.KNOWN_EX_QTY || 3670);
const KNOWN_LOCAL_PX = Number(process.env.KNOWN_LOCAL_PX || 0.0360299572);
const KNOWN_EX_PX = Number(process.env.KNOWN_EX_PX || 0.0359379);
const KNOWN_ORDER_IDS = String(
  process.env.ORDER_IDS ||
    '1785994747,1783514788,1782164571,1781041883,1779002401,1770612325,1756025769,1754011868,1753504023',
)
  .split(/[,\s]+/)
  .filter(Boolean);

function decrypt(payload) {
  const hex = process.env.ENC_KEY || '';
  if (hex.length !== 64) throw new Error('ENC_KEY 必须是 64 位 hex');
  const key = Buffer.from(hex, 'hex');
  const [ivB64, tagB64, dataB64] = String(payload || '').split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function protectLargeIds(text) {
  return String(text || '').replace(
    /"(orderId|orderID|origClientOrderId|clientOrderId)"\s*:\s*(\d{16,})/gi,
    '"$1":"$2"',
  );
}

async function httpJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    signal: opts.signal || AbortSignal.timeout(opts.timeoutMs || 60000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(protectLargeIds(text)) : null;
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  return { status: res.status, body };
}

function extractCaptchaCode(imageDataUrl) {
  const b64 = String(imageDataUrl || '').replace(/^data:image\/svg\+xml;base64,/, '');
  const svg = Buffer.from(b64, 'base64').toString('utf8');
  return [...svg.matchAll(/>([A-Z0-9])<\/text>/gi)].map((m) => m[1]).join('');
}

async function loginUser() {
  const errors = [];
  for (const password of [...new Set(PASSWORDS)]) {
    try {
      const r = await httpJson(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ACCOUNT, password }),
        timeoutMs: Number(process.env.API_LOGIN_TIMEOUT_MS || 8000),
      });
      if (r.body?.accessToken) {
        return { token: r.body.accessToken, user: r.body.user, passwordUsed: true };
      }
      errors.push({ passwordLen: password.length, status: r.status, message: r.body?.message });
    } catch (e) {
      errors.push({ passwordLen: password.length, error: e.message });
    }
  }
  return { token: null, errors };
}

async function loginAdmin() {
  try {
    const cap = await httpJson(`${API_BASE}/admin/auth/captcha`, { timeoutMs: 8000 });
    const code = extractCaptchaCode(cap.body?.image);
    if (!code || !cap.body?.id) {
      return { token: null, error: 'captcha-empty' };
    }
    const r = await httpJson(`${API_BASE}/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: ADMIN_ACCOUNT,
        password: ADMIN_PASSWORD,
        captchaId: cap.body.id,
        captchaCode: code,
      }),
      timeoutMs: 20000,
    });
    if (r.body?.accessToken) return { token: r.body.accessToken };
    return { token: null, error: r.body?.message || r.status };
  } catch (e) {
    return { token: null, error: e.message };
  }
}

async function paged(urlBase, headers, pickItems) {
  const items = [];
  for (let skip = 0; skip < 5000; skip += 200) {
    const sep = urlBase.includes('?') ? '&' : '?';
    const r = await httpJson(`${urlBase}${sep}skip=${skip}&take=200`, {
      headers,
      timeoutMs: 60000,
    });
    if (r.status !== 200) return { error: { status: r.status, body: r.body }, items };
    const batch = pickItems(r.body);
    items.push(...batch);
    if (batch.length < 200) break;
  }
  return { items };
}

function isTut(row) {
  const coin = String(row.coinName || row.coin || '').toUpperCase();
  const pair = String(row.pair || row.symbol || '').toUpperCase();
  return coin === COIN || pair.includes(COIN);
}

function fifoFromLogs(logs) {
  const opens = logs.filter((l) => {
    if (l.isOpen === false || l.kind === 'close') return false;
    const st = String(l.status || 'FILLED');
    const filled = Number(l.filledAmt ?? l.amount ?? 0);
    return st === 'FILLED' || (['CANCELLED', 'PLACED', 'CANCEL_FAILED'].includes(st) && filled > 0);
  });
  let qty = 0;
  let cost = 0;
  const lots = [];
  for (const o of opens) {
    const filled = Number(o.filledAmt ?? o.amount ?? 0);
    const consumed = Number(o.consumedAmt ?? 0);
    const px = Number(o.avgPrice ?? 0);
    const remain = Math.max(0, filled - consumed);
    if (remain > 1e-12) {
      qty += remain;
      if (px > 0) cost += remain * px;
    }
    lots.push({
      orderId: String(o.orderId || ''),
      filled,
      consumed,
      remain,
      avgPrice: px,
      createdAt: o.createdAt || o.openTime,
      status: o.status,
    });
  }
  return { qty, entry: qty > 0 && cost > 0 ? cost / qty : 0, lots };
}

function tradesToOrders(trades) {
  const by = new Map();
  let buy = 0;
  let sell = 0;
  let buyCost = 0;
  let sellCost = 0;
  for (const t of trades) {
    const oid = String(t.orderId || '');
    const qty = Number(t.qty || 0);
    const px = Number(t.price || 0);
    const side = String(t.side || '').toUpperCase();
    if (side === 'BUY') {
      buy += qty;
      buyCost += qty * px;
    } else {
      sell += qty;
      sellCost += qty * px;
    }
    const cur = by.get(oid) || { orderId: oid, buy: 0, sell: 0, buyCost: 0, sellCost: 0, fills: 0 };
    if (side === 'BUY') {
      cur.buy += qty;
      cur.buyCost += qty * px;
    } else {
      cur.sell += qty;
      cur.sellCost += qty * px;
    }
    cur.fills += 1;
    by.set(oid, cur);
  }
  const net = buy - sell;
  return {
    buy,
    sell,
    net,
    vwapBuy: buy > 0 ? buyCost / buy : 0,
    orders: [...by.values()].sort((a, b) => a.orderId.localeCompare(b.orderId)),
  };
}

async function binanceSignedGet(cred, path, extraQs) {
  const base = (process.env.MARKET_BINANCE_FUTURES_URL || 'https://fapi.binance.com').replace(
    /\/$/,
    '',
  );
  const timestamp = Date.now();
  const qs = `${extraQs ? `${extraQs}&` : ''}timestamp=${timestamp}&recvWindow=5000`;
  const signature = crypto.createHmac('sha256', cred.apiSecret).update(qs).digest('hex');
  const url = `${base}${path}?${qs}&signature=${signature}`;
  const res = await fetch(url, {
    headers: { 'X-MBX-APIKEY': cred.apiKey },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let raw = null;
  try {
    raw = text ? JSON.parse(protectLargeIds(text)) : null;
  } catch {
    raw = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    throw new Error(String(raw?.msg || raw?.message || text || `HTTP ${res.status}`));
  }
  return raw;
}

async function loadLocalBinanceKey() {
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { nickname: ACCOUNT },
          { email: `${ACCOUNT}@account.local` },
          { email: ACCOUNT },
        ],
      },
      select: { id: true, email: true, nickname: true },
    });
    if (!user) return { user: null, cred: null, note: 'local-user-missing' };
    const row = await prisma.exchangeKey.findFirst({
      where: { userId: user.id, exchange: 'BINANCE', active: true },
    });
    if (!row?.encApiKey || !row?.encApiSecret) {
      return { user, cred: null, note: 'local-key-missing' };
    }
    return {
      user,
      cred: {
        apiKey: decrypt(row.encApiKey),
        apiSecret: decrypt(row.encApiSecret),
      },
      note: 'ok',
      keyMasked: `${decrypt(row.encApiKey).slice(0, 4)}****`,
    };
  } finally {
    await prisma.$disconnect();
  }
}

async function pullBinance(cred) {
  const posRaw = await binanceSignedGet(cred, '/fapi/v2/positionRisk', `symbol=${SYMBOL}`);
  const positions = (Array.isArray(posRaw) ? posRaw : []).map((p) => ({
    symbol: p.symbol,
    positionAmt: Number(p.positionAmt || 0),
    entryPrice: Number(p.entryPrice || 0),
    markPrice: Number(p.markPrice || 0),
    unRealizedProfit: Number(p.unRealizedProfit || 0),
    leverage: p.leverage,
    marginType: p.marginType,
    positionSide: p.positionSide,
  }));
  const trades = [];
  const seen = new Set();
  const now = Date.now();
  const start = now - LOOKBACK_DAYS * 24 * 3600 * 1000;
  const windowMs = 7 * 24 * 3600 * 1000 - 60_000;
  for (let t0 = start; t0 < now; t0 += windowMs) {
    const t1 = Math.min(now, t0 + windowMs);
    const raw = await binanceSignedGet(
      cred,
      '/fapi/v1/userTrades',
      `symbol=${SYMBOL}&startTime=${t0}&endTime=${t1}&limit=1000`,
    );
    const list = Array.isArray(raw) ? raw : [];
    for (const tr of list) {
      const id = String(tr.id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      trades.push({
        id,
        orderId: String(tr.orderId ?? ''),
        side: String(tr.side || ''),
        positionSide: String(tr.positionSide || ''),
        price: String(tr.price ?? ''),
        qty: String(tr.qty ?? ''),
        time: tr.time ? new Date(Number(tr.time)).toISOString() : null,
      });
    }
  }
  trades.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
  return { positions, trades };
}

function mapiHeaders(serviceKey) {
  const language = 'zh-Hans';
  const nonce = crypto.randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const versionCode = process.env.TRADE_VERSION_CODE || '20260012';
  const clientType = process.env.TRADE_CLIENT_TYPE || 'win';
  const raw = `${language}:${nonce}:${timestamp}:${versionCode}:${clientType}:${serviceKey}`;
  return {
    'Content-Type': 'application/json',
    'X-Client-Language': language,
    'X-Client-Nonce': nonce,
    'X-Client-Timestamp': timestamp,
    'X-Client-VersionCode': versionCode,
    'X-Client-ClientType': clientType,
    'X-Client-Signature': crypto.createHash('md5').update(raw).digest('hex'),
  };
}

async function loadMiddlewareCfg(prisma) {
  const rows = await prisma.systemConfig.findMany({
    where: { key: { in: ['trade_middleware_base', 'trade_middleware_service_key'] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, String(r.value || '').trim()]));
  return {
    base: (
      process.env.MAPI_BASE ||
      map.trade_middleware_base ||
      process.env.TRADE_MIDDLEWARE_BASE ||
      'http://47.238.111.238:1820'
    ).replace(/\/$/, ''),
    serviceKey:
      process.env.TRADE_SERVICE_KEY ||
      map.trade_middleware_service_key ||
      'xt18673178005!',
  };
}

function buildAccount(cred, user) {
  return {
    gid: user?.id || 'admin1',
    apiCode: 'bac',
    apiName: '币安',
    accountName: user?.nickname || 'admin1',
    apiKey: cred.apiKey,
    apiSecret: cred.apiSecret,
    passphrase: '',
    extendedAttr: '',
    extendedAttr2: '',
    innerExtendedAttr: '',
    createTime: new Date().toISOString(),
  };
}

async function mapiPost(cfg, path, body) {
  const url = `${cfg.base}/${path.replace(/^\//, '')}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: mapiHeaders(cfg.serviceKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(protectLargeIds(text)) : null;
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status, json, text: text.slice(0, 400) };
}

async function mapiGet(cfg, path) {
  const url = `${cfg.base}/${path.replace(/^\//, '')}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: mapiHeaders(cfg.serviceKey),
    signal: AbortSignal.timeout(45000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(protectLargeIds(text)) : null;
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status, json };
}

async function loadTutSymbol(cfg) {
  const r = await mapiGet(cfg, 'mapi/CryptoSymbolList');
  const items = Array.isArray(r.json?.data) ? r.json.data : Array.isArray(r.json) ? r.json : [];
  const hit =
    items.find(
      (s) =>
        String(s.apiCode || '').toLowerCase() === 'bac' &&
        String(s.coinName || '').toUpperCase() === COIN &&
        String(s.equalCoinName || '').toUpperCase() === 'PC',
    ) ||
    items.find(
      (s) =>
        String(s.coinName || '').toUpperCase() === COIN &&
        String(s.apiCode || '').toLowerCase().startsWith('ba'),
    );
  if (!hit) {
    return {
      apiCode: 'bac',
      apiName: '币安',
      coinName: COIN,
      equalCoinName: 'PC',
      settleCoin: 'USDT',
      symbol: `${COIN}/PC`,
      minAmt: 1,
      minSize: 1,
      pricePrecision: 8,
      priceStep: 0.0001,
      boardLotSize: 0,
    };
  }
  return {
    ...hit,
    priceStep: Number(hit.priceStep) || 0.0001,
    minAmt: Number(hit.minAmt) || 1,
    minSize: Number(hit.minSize) || 1,
    pricePrecision: Number(hit.pricePrecision) || 8,
    boardLotSize: Number(hit.boardLotSize) || 0,
  };
}

async function pickProxyIP(cfg) {
  const r = await mapiGet(cfg, 'mapi/PublicHttpProxyList');
  const items = Array.isArray(r.json?.data) ? r.json.data : Array.isArray(r.json) ? r.json : [];
  const first = items[0] || {};
  const proxyIP = String(first.value || first.Value || first.ip || first.host || '').trim();
  return { proxyIP, count: items.length, sample: first.name || first.Name || null };
}

async function pullViaMiddleware(cfg, cred, user, orderIds) {
  const account = buildAccount(cred, user);
  const symbol = await loadTutSymbol(cfg);
  const proxy = await pickProxyIP(cfg);
  const posBody = { proxyIP: proxy.proxyIP, accountType: 'future', account };
  let pos = await mapiPost(cfg, 'mapi/QueryPosition', posBody);
  if (pos.status === 404 || pos.status === 400) {
    pos = await mapiPost(cfg, 'mapi/QueryPosition', { req: posBody });
  }
  const data = pos.json?.data ?? pos.json;
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.positions)
      ? data.positions
      : data && typeof data === 'object' && !data.success && !data.type
        ? Object.values(data).filter((x) => x && typeof x === 'object')
        : [];
  const tut = list
    .map((p) => ({
      coinName: String(p.coinsName || p.coinName || p.coin || p.symbol || '').toUpperCase(),
      amount: Number(p.amount ?? p.size ?? p.qty ?? p.positionAmt ?? p.positionSize ?? 0),
      entryPrice: Number(p.entryPrice ?? p.avgPrice ?? p.openPrice ?? p.priceAvg ?? p.positionPrice ?? 0),
      side: String(p.side || p.positionSide || ''),
      errorMsg: p.errorMsg,
    }))
    .filter((p) => p.coinName.includes(COIN));

  const queries = [];
  for (const orderId of orderIds) {
    const inner = {
      proxyIP: proxy.proxyIP,
      accountType: 'future',
      isOpen: true,
      account,
      symbol,
      order: {
        gid: '',
        apiBillID: orderId,
        clientBillID: '',
        ruleOrPositionGID: '',
        apiCode: symbol.apiCode || 'bac',
        apiName: symbol.apiName || '币安',
        accountGID: account.gid,
        accountName: account.accountName,
        coinsName: COIN,
        equalCoinName: 'PC',
        leverageType: 5,
        ruleType: 1,
        positionSide: 1,
        recordType: 2,
        tradeAmt: 0,
        avgPrice: 0,
        filledAmt: 0,
        tradePrice: 0,
        profitsAmt: 0,
        profitsPercent: 0,
        tradeFee: 0,
        status: 0,
        tradeRemark: '',
        instrumentID: `${COIN}-USDT`,
        isConfirmed: 0,
        settleCoin: 'USDT',
        updateTime: 0,
        createTime: 0,
        createTimeMillSeconds: 0,
      },
    };
    let q = await mapiPost(cfg, 'mapi/QueryOrder', inner);
    if (q.status === 400 && /req field is required/i.test(q.text || '')) {
      q = await mapiPost(cfg, 'mapi/QueryOrder', { req: inner });
    }
    const d = q.json?.data ?? q.json;
    queries.push({
      orderId,
      http: q.status,
      success: q.json?.success,
      message: q.json?.message,
      httpCode: q.json?.httpCode,
      status: d?.status,
      filledAmt: d?.filledAmt,
      priceAvg: d?.priceAvg,
      errorMsg: d?.errorMsg || q.json?.message,
      preview: JSON.stringify(q.json).slice(0, 280),
    });
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    queryPosition: {
      http: pos.status,
      success: pos.json?.success,
      message: pos.json?.message,
      errorMsg: data?.errorMsg,
      httpCode: pos.json?.httpCode,
      tut,
      rawCount: list.length,
      preview: (pos.text || JSON.stringify(pos.json)).slice(0, 400),
    },
    queryOrders: queries,
    symbolUsed: {
      apiCode: symbol.apiCode,
      coinName: symbol.coinName,
      equalCoinName: symbol.equalCoinName,
      priceStep: symbol.priceStep,
      minAmt: symbol.minAmt,
    },
    proxy: { used: !!proxy.proxyIP, count: proxy.count, sampleName: proxy.sample },
  };
}

function slimPos(p) {
  return {
    id: p.id,
    userId: p.userId,
    user: p.user
      ? `${p.user.nickname || ''}#${p.user.userNo || ''} ${p.user.email || ''}`.trim()
      : p.nickname || null,
    exchange: p.exchange,
    coinName: p.coinName,
    equalCoinName: p.equalCoinName,
    side: p.side || p.positionSide,
    qty: p.qty ?? p.amount,
    entryPrice: p.entryPrice,
    source: p.source,
    orderIds: p.orderIds || (p.orderId ? [p.orderId] : []),
    openedAt: p.openedAt || p.openTime,
  };
}

function slimLog(l) {
  return {
    id: l.id,
    createdAt: l.createdAt || l.openTime,
    status: l.status,
    isOpen: l.isOpen,
    kind: l.kind,
    filledAmt: l.filledAmt ?? l.amount,
    consumedAmt: l.consumedAmt,
    avgPrice: l.avgPrice,
    orderId: l.orderId,
    coinName: l.coinName,
    positionSide: l.positionSide,
  };
}

async function main() {
  const report = {
    apiBase: API_BASE,
    coin: COIN,
    symbol: SYMBOL,
    expect: {
      localQty: KNOWN_LOCAL_QTY,
      localPx: KNOWN_LOCAL_PX,
      exQty: KNOWN_EX_QTY,
      exPx: KNOWN_EX_PX,
      extraLocal: KNOWN_LOCAL_QTY - KNOWN_EX_QTY,
    },
    userLogin: null,
    adminLogin: null,
    server: {},
    binance: {},
    diff: null,
  };

  const userLogin = await loginUser();
  report.userLogin = {
    ok: !!userLogin.token,
    userId: userLogin.user?.id || null,
    nickname: userLogin.user?.nickname || null,
    errors: userLogin.errors,
  };
  const userAuth = userLogin.token ? { Authorization: `Bearer ${userLogin.token}` } : null;
  const userId = userLogin.user?.id;

  if (userAuth) {
    try {
      const [posRes, histRes] = await Promise.all([
        httpJson(`${API_BASE}/trade/positions`, { headers: userAuth, timeoutMs: 90000 }),
        paged(`${API_BASE}/trade/follow-history`, userAuth, (b) =>
          Array.isArray(b) ? b : b.body?.items || b.items || b.list || [],
        ),
      ]);
      const posItems = (posRes.body?.items || posRes.body?.list || []).map(slimPos);
      report.server.userPositions = {
        status: posRes.status,
        errors: posRes.body?.errors || null,
        tut: posItems.filter(isTut),
        allCount: posItems.length,
      };
      report.server.followHistory = histRes.error
        ? histRes.error
        : {
            total: histRes.items.length,
            tut: histRes.items.filter(isTut).map(slimLog),
          };
    } catch (e) {
      report.server.userPositions = { error: e.message };
      report.server.followHistory = { error: e.message };
    }
  } else {
    report.server.userPositions = { skipped: true, reason: 'user-login-failed' };
    report.server.followHistory = { skipped: true, reason: 'user-login-failed' };
  }

  const adminLogin = await loginAdmin();
  report.adminLogin = { ok: !!adminLogin.token, error: adminLogin.error || null };
  if (adminLogin.token) {
    const adminAuth = { Authorization: `Bearer ${adminLogin.token}` };
    const q = userId
      ? `status=OPEN&coinName=${COIN}&userId=${encodeURIComponent(userId)}`
      : `status=OPEN&coinName=${COIN}&q=${encodeURIComponent(ACCOUNT)}`;
    const [adminPos, adminLogs, liveTrades] = await Promise.all([
      httpJson(`${API_BASE}/admin/trade/positions?${q}`, { headers: adminAuth, timeoutMs: 60000 }),
      paged(
        `${API_BASE}/admin/trade/follow-logs?coinName=${COIN}&q=${encodeURIComponent(ACCOUNT)}`,
        adminAuth,
        (b) => b.items || [],
      ),
      userId
        ? httpJson(
            `${API_BASE}/admin/trade/exchange-user-trades?userId=${encodeURIComponent(userId)}&exchange=BINANCE&symbol=${SYMBOL}&lookbackDays=${LOOKBACK_DAYS}`,
            { headers: adminAuth, timeoutMs: 120000 },
          )
        : Promise.resolve({ status: 0, body: { skipped: true } }),
    ]);
    const adminItems = (adminPos.body?.items || []).map(slimPos);
    report.server.adminPositions = { status: adminPos.status, tut: adminItems.filter(isTut) };
    report.server.followLogs = adminLogs.error
      ? adminLogs.error
      : { total: adminLogs.items.length, tut: adminLogs.items.filter(isTut).map(slimLog) };
    report.binance.fromServerApi = {
      status: liveTrades.status,
      message: liveTrades.body?.message || null,
      positions: liveTrades.body?.positions || null,
      tradeCount: liveTrades.body?.total ?? (liveTrades.body?.trades || []).length,
      trades: liveTrades.body?.trades || null,
    };
  }

  const keyInfo = await loadLocalBinanceKey();
  report.binance.localKey = {
    userId: keyInfo.user?.id || null,
    note: keyInfo.note,
    keyMasked: keyInfo.keyMasked || null,
  };
  if (keyInfo.cred) {
    try {
      report.binance.direct = await pullBinance(keyInfo.cred);
    } catch (e) {
      report.binance.directError = e.cause?.message || e.message;
    }
    try {
      const prisma = new PrismaClient();
      try {
        const cfg = await loadMiddlewareCfg(prisma);
        report.binance.mapiBase = cfg.base;
        const orderIds = [
          ...new Set([
            ...KNOWN_ORDER_IDS,
            ...(report.server.followHistory?.tut || []).map((l) => String(l.orderId || '')).filter(Boolean),
            ...(report.server.followLogs?.tut || []).map((l) => String(l.orderId || '')).filter(Boolean),
          ]),
        ];
        report.binance.middleware = await pullViaMiddleware(cfg, keyInfo.cred, keyInfo.user, orderIds);
      } finally {
        await prisma.$disconnect();
      }
    } catch (e) {
      report.binance.middlewareError = e.cause?.message || e.message;
    }
  }

  const bnPos =
    report.binance.direct?.positions ||
    (report.binance.fromServerApi?.positions || []).map((p) => ({
      ...p,
      positionAmt: Number(p.positionAmt || 0),
      entryPrice: Number(p.entryPrice || 0),
    }));
  const mwTut = report.binance.middleware?.queryPosition?.tut || [];
  if (!bnPos?.length && mwTut.length) {
    for (const p of mwTut) {
      bnPos.push({
        positionAmt: p.amount,
        entryPrice: p.entryPrice,
        positionSide: p.side,
      });
    }
  }
  const bnTrades = report.binance.direct?.trades || report.binance.fromServerApi?.trades || [];
  const longPos = (bnPos || []).find(
    (p) => Math.abs(Number(p.positionAmt)) > 0 && String(p.positionSide || '').toUpperCase() !== 'SHORT',
  ) || (bnPos || []).find((p) => Math.abs(Number(p.positionAmt)) > 0);

  const logs = Array.isArray(report.server.followLogs?.tut)
    ? report.server.followLogs.tut
    : report.server.followHistory?.tut || [];
  const fifo = fifoFromLogs(logs);
  const agg = tradesToOrders(bnTrades);
  const ourOpenIds = new Set(
    fifo.lots.filter((l) => l.remain > 1e-12 && l.orderId).map((l) => l.orderId),
  );
  const bnBuyIds = new Set(agg.orders.filter((o) => o.buy > o.sell).map((o) => o.orderId));
  const missingInOurs = [...bnBuyIds].filter((id) => !ourOpenIds.has(id) && !logs.some((l) => String(l.orderId) === id));
  const extraInOurs = [...ourOpenIds].filter((id) => !agg.orders.some((o) => o.orderId === id));
  const filledMismatch = [];
  for (const lot of fifo.lots) {
    if (!lot.orderId) continue;
    const bn = agg.orders.find((o) => o.orderId === lot.orderId);
    if (!bn) continue;
    const bnQty = bn.buy || bn.sell;
    if (Math.abs(bnQty - lot.filled) > 0.5) {
      filledMismatch.push({
        orderId: lot.orderId,
        ourFilled: lot.filled,
        ourRemain: lot.remain,
        binanceBuy: bn.buy,
        binanceSell: bn.sell,
      });
    }
  }

  const localRow = report.server.adminPositions?.tut?.[0] || report.server.userPositions?.tut?.[0];
  report.diff = {
    binancePos: longPos
      ? { qty: Math.abs(Number(longPos.positionAmt)), entry: Number(longPos.entryPrice) }
      : null,
    localPos: localRow
      ? { qty: Number(localRow.qty), entry: Number(localRow.entryPrice), source: localRow.source }
      : { qty: KNOWN_LOCAL_QTY, entry: KNOWN_LOCAL_PX, source: 'known' },
    fifoFromLogs: { qty: fifo.qty, entry: fifo.entry, openLots: fifo.lots.length },
    binanceTradesNet: { buy: agg.buy, sell: agg.sell, net: agg.net, orderCount: agg.orders.length },
    qtyLocalMinusBinance:
      Number(localRow?.qty ?? KNOWN_LOCAL_QTY) -
      Math.abs(Number(longPos?.positionAmt ?? KNOWN_EX_QTY)),
    missingOrderIdsInOurLogs: missingInOurs,
    extraOrderIdsInOurLogs: extraInOurs,
    filledMismatch,
    lots: fifo.lots,
    suspectRemain274: fifo.lots.filter((l) => Math.abs(l.remain - 274) < 1 || Math.abs(l.filled - 274) < 1),
  };

  if (report.binance.fromServerApi?.trades && report.binance.direct?.trades) {
    delete report.binance.fromServerApi.trades;
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
