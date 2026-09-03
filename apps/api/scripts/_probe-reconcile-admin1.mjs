import crypto from 'crypto';
import fs from 'fs';
import { execFileSync } from 'child_process';

const BASE = 'http://47.238.111.238:1820';
const SERVICE_KEY = 'xt18673178005!';
const GID = '1ba11b92-192f-4d65-a749-6955b8b11b0e';
const RATIO = 1.5;
const TOL = 0.1;

function headers() {
  const language = 'zh-Hans';
  const nonce = crypto.randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const versionCode = '20260012';
  const clientType = 'win';
  const raw = `${language}:${nonce}:${timestamp}:${versionCode}:${clientType}:${SERVICE_KEY}`;
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

function parsePositions(data) {
  const root =
    data?.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data;
  const map = new Map();
  for (const key of Object.keys(root || {})) {
    const parts = key.split('_');
    if (parts.length < 4) continue;
    const side = parts[parts.length - 1].toLowerCase();
    if (side !== 'long' && side !== 'short') continue;
    const eq = parts[parts.length - 2].toUpperCase();
    const coin = parts.slice(1, parts.length - 2).join('_').toUpperCase();
    const size = Number(root[key]?.PositionSize ?? root[key]?.positionSize ?? root[key]?.size ?? 0) || 0;
    map.set(`${coin}|${side}|${eq}`, size);
  }
  return map;
}

const env = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
const dbUrl = env
  .split(/\r?\n/)
  .find((l) => l.startsWith('DATABASE_URL='))
  ?.replace(/^DATABASE_URL=/, '')
  .replace(/^["']|["']$/g, '');
const m = dbUrl.match(/mysql:\/\/([^:]+):([^@]+)@([^:/]+):?(\d+)?\/([^?]+)/);
if (!m) throw new Error('bad DATABASE_URL');
const [, user, pass, host, port, db] = m;

const sql = `SELECT up.coin_name, up.equal_coin_name, up.position_side, up.qty
FROM user_positions up
JOIN users u ON u.id=up.user_id
WHERE u.nickname='admin1' AND up.exchange='BINANCE' AND up.status='OPEN' AND up.qty>0
  AND up.account_gid='${GID}'
ORDER BY up.coin_name;`;

const raw = execFileSync(
  'mysql',
  [`-h${host}`, `-P${port || '3306'}`, `-u${user}`, `-p${pass}`, db, '-N', '-B', '-e', sql],
  { encoding: 'utf8' },
);
const locals = raw
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const [coin_name, equal_coin_name, position_side, qty] = line.split('\t');
    return { coin_name, equal_coin_name, position_side, qty };
  });

const res = await fetch(`${BASE}/mapi/Positions?AccountGID=${encodeURIComponent(GID)}`, {
  headers: headers(),
  signal: AbortSignal.timeout(30000),
});
const json = await res.json();
const signal = parsePositions(json);

const orphans = [];
const excess = [];
const under = [];
const ok = [];
const allLocal = [];

for (const r of locals) {
  const coin = String(r.coin_name).toUpperCase();
  const eq = String(r.equal_coin_name || 'PC').toUpperCase();
  const side = String(r.position_side || 'long').toLowerCase().includes('short') ? 'short' : 'long';
  const local = Number(r.qty);
  const sig = signal.get(`${coin}|${side}|${eq}`) ?? 0;
  const expected = sig * RATIO;
  const maxOk = expected * (1 + TOL);
  const actualRatio = sig > 0 ? local / sig : null;
  let status;
  if (sig <= 1e-8) {
    status = 'ORPHAN';
    orphans.push({ coin, side, eq, local, sig: 0, expected: 0 });
  } else if (local > maxOk + 1e-8) {
    status = 'EXCESS';
    excess.push({
      coin,
      side,
      local,
      sig,
      expected: +expected.toFixed(4),
      actualRatio: +actualRatio.toFixed(4),
    });
  } else if (local + 1e-8 < expected) {
    status = local < expected * 0.5 ? 'UNDER_HALF' : 'UNDER';
    under.push({
      coin,
      side,
      local,
      sig,
      expected: +expected.toFixed(4),
      actualRatio: +actualRatio.toFixed(4),
      status,
    });
  } else {
    status = 'OK';
    ok.push({
      coin,
      side,
      local,
      sig,
      expected: +expected.toFixed(4),
      actualRatio: +actualRatio.toFixed(4),
    });
  }
  allLocal.push({
    coin,
    side,
    local,
    sig,
    expected: +expected.toFixed(4),
    actualRatio: actualRatio == null ? null : +actualRatio.toFixed(4),
    status,
  });
}

let signalLongNonZero = 0;
for (const [k, v] of signal) {
  if (v > 0 && k.includes('|long|')) signalLongNonZero += 1;
}

console.log(
  JSON.stringify(
    {
      meta: {
        accountGid: GID,
        invest: 1500,
        maxPrincipal: 1000,
        openRatio: RATIO,
        tol: TOL,
        signalHttp: res.status,
        signalSuccess: json.success,
        localOpenCount: locals.length,
        signalLongNonZero,
      },
      verdict: {
        orphanCount: orphans.length,
        excessCount: excess.length,
        underCount: under.length,
        okCount: ok.length,
        needReconcileAction: orphans.length > 0 || excess.length > 0,
        note:
          orphans.length > 0
            ? '存在「信号账户该币已无仓，本地还持有」→ 应对账独有强平'
            : '没有「信号已空、本地还持有」的孤儿仓',
      },
      orphans,
      excess,
      ok,
      underWorst: under
        .slice()
        .sort((a, b) => (a.actualRatio ?? 0) - (b.actualRatio ?? 0))
        .slice(0, 15),
      allLocal,
    },
    null,
    2,
  ),
);
