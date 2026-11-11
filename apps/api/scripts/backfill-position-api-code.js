/**
 * 持仓唯一键从「用户+交易所+币+周期+方向」换成「用户+apiCode+币+周期+方向」。
 * 先补 api_code，有对不上的行就停，不改索引。可重复执行。
 * 不要用 prisma db push 做这件事（会顺手删 follow_templates 上还留着的旧列）。
 * 用法: node scripts/backfill-position-api-code.js
 */
try {
  require('dotenv').config();
} catch {
  /* 部署环境已注入 DATABASE_URL */
}

const { PrismaClient } = require('@prisma/client');

const SPOT_QUOTES = new Set(['U', 'USDT', 'USDC', 'USD', 'BTC', 'ETH', 'EUR', 'FDUSD', 'DAI', 'TUSD']);

/** 与 exchange-codes.ts 默认现货码 / 无信号时的合约码一致。 */
const VENUES = [
  { id: 'BINANCE', spot: 'ba', future: 'bac' },
  { id: 'OKX', spot: 'ok', future: 'okp' },
  { id: 'BITGET', spot: 'bg', future: 'bgu' },
  { id: 'BYBIT', spot: 'by', future: 'byu' },
  { id: 'GATE', spot: 'gt', future: 'gtc' },
  { id: 'HUOBI', spot: 'hb', future: 'hbp' },
  { id: 'KUCOIN', spot: 'kc', future: 'kcp' },
  { id: 'HYPERLIQUID', spot: 'hpc', future: 'hpc' },
  { id: 'HASHKEY', spot: 'hk', future: 'hk' },
  { id: 'BACKPACK', spot: 'bp', future: 'bpc' },
  { id: 'ASTER', spot: 'at', future: 'atc' },
  { id: 'LIGHTER', spot: 'ltc', future: 'ltc' },
];

const NEW_COLS = ['user_id', 'api_code', 'coin_name', 'equal_coin_name', 'position_side'];

function defaultCode(exchange, equalCoinName) {
  const venue = VENUES.find((v) => v.id === String(exchange || '').toUpperCase());
  if (!venue) return '';
  const eq = String(equalCoinName || '').toUpperCase();
  return (SPOT_QUOTES.has(eq) ? venue.spot : venue.future).toLowerCase();
}

function bodyCode(raw) {
  try {
    return String(JSON.parse(raw || '{}').apiCode || '')
      .trim()
      .toLowerCase();
  } catch {
    return '';
  }
}

function sideOf(raw) {
  return String(raw || 'long').toLowerCase().includes('short') ? 'short' : 'long';
}

function lotKey(row) {
  return [
    row.userId,
    row.exchange,
    String(row.coinName || '').toUpperCase(),
    String(row.equalCoinName || '').toUpperCase(),
    sideOf(row.positionSide),
  ].join('|');
}

function posKey(row) {
  return [
    row.userId,
    String(row.apiCode || '').trim().toLowerCase(),
    String(row.coinName || '').toUpperCase(),
    String(row.equalCoinName || '').toUpperCase(),
    sideOf(row.positionSide),
  ].join('|');
}

async function main() {
  console.log('backfill-position-api-code: sql');
  const prisma = new PrismaClient();
  try {
    const [table] = await prisma.$queryRawUnsafe(
      `SELECT TABLE_NAME AS name
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_positions'`,
    );
    if (!table) {
      console.log('user_positions 不存在，跳过（新库由 prisma db push 建表）');
      return;
    }

    const cols = await prisma.$queryRawUnsafe(
      `SELECT COLUMN_NAME AS name
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_positions'`,
    );
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has('api_code')) {
      console.log('补列 api_code（可空，随后回填）');
      await prisma.$executeRawUnsafe(
        "ALTER TABLE user_positions ADD COLUMN api_code VARCHAR(32) NULL DEFAULT NULL",
      );
    }

    const indexes = await prisma.$queryRawUnsafe(
      `SELECT INDEX_NAME AS name, SEQ_IN_INDEX AS seq, COLUMN_NAME AS col, NON_UNIQUE AS nonUnique
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_positions' AND NON_UNIQUE = 0
       ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    );
    const byIndex = new Map();
    for (const row of indexes) {
      if (row.name === 'PRIMARY') continue;
      if (!byIndex.has(row.name)) byIndex.set(row.name, []);
      byIndex.get(row.name).push(row.col);
    }
    const sameCols = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);
    let newIndex = '';
    let oldIndex = '';
    for (const [name, cols] of byIndex) {
      if (sameCols(cols, NEW_COLS)) newIndex = name;
      if (cols.includes('exchange') && cols.includes('user_id') && cols.includes('coin_name') && !cols.includes('api_code')) {
        oldIndex = name;
      }
    }

    // 生成的客户端把 apiCode 当成必填，库里还有 NULL 时 findMany 会直接抛错。这里走 SQL。
    const positions = await prisma.$queryRawUnsafe(
      `SELECT id,
              user_id AS userId,
              exchange,
              coin_name AS coinName,
              equal_coin_name AS equalCoinName,
              position_side AS positionSide,
              api_code AS apiCode
       FROM user_positions`,
    );
    const need = positions.filter((row) => !String(row.apiCode || '').trim());
    const codesByLot = new Map();
    if (need.length) {
      const userIds = [...new Set(need.map((row) => row.userId))];
      const logCols = await prisma.$queryRawUnsafe(
        `SELECT COLUMN_NAME AS name
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signal_follow_logs'`,
      );
      const names = new Set(logCols.map((c) => c.name));
      const col = (...cands) => cands.find((c) => names.has(c));
      const userCol = col('userId', 'user_id');
      const exCol = col('exchange');
      const coinCol = col('coinName', 'coin_name');
      const eqCol = col('equalCoinName', 'equal_coin_name');
      const sideCol = col('positionSide', 'position_side');
      const openCol = col('isOpen', 'is_open');
      const bodyCol = col('requestBody', 'request_body');
      if (!userCol || !exCol || !coinCol || !eqCol || !sideCol || !openCol || !bodyCol) {
        console.log('停住：signal_follow_logs 缺少开仓流水字段，索引未改');
        process.exitCode = 1;
        return;
      }
      const marks = userIds.map(() => '?').join(',');
      const logs = await prisma.$queryRawUnsafe(
        `SELECT \`${userCol}\` AS userId,
                \`${exCol}\` AS exchange,
                \`${coinCol}\` AS coinName,
                \`${eqCol}\` AS equalCoinName,
                \`${sideCol}\` AS positionSide,
                \`${bodyCol}\` AS requestBody
         FROM signal_follow_logs
         WHERE \`${openCol}\` = 1 AND \`${userCol}\` IN (${marks})`,
        ...userIds,
      );
      for (const log of logs) {
        const code = bodyCode(log.requestBody);
        if (!code) continue;
        const key = lotKey(log);
        const set = codesByLot.get(key) || new Set();
        set.add(code);
        codesByLot.set(key, set);
      }
    }

    const conflicts = [];
    const planned = new Map();
    for (const row of positions) {
      const current = String(row.apiCode || '').trim().toLowerCase();
      if (current) {
        planned.set(row.id, current);
        continue;
      }
      const set = codesByLot.get(lotKey(row));
      if (set && set.size > 1) {
        conflicts.push({
          id: row.id,
          exchange: row.exchange,
          coin: row.coinName,
          eq: row.equalCoinName,
          side: sideOf(row.positionSide),
          codes: [...set].sort().join(','),
        });
        continue;
      }
      const code = (set && set.size === 1 ? [...set][0] : defaultCode(row.exchange, row.equalCoinName)) || '';
      if (!code) {
        conflicts.push({
          id: row.id,
          exchange: row.exchange,
          coin: row.coinName,
          eq: row.equalCoinName,
          side: sideOf(row.positionSide),
          codes: '无法推断',
        });
        continue;
      }
      planned.set(row.id, code);
    }

    if (conflicts.length) {
      console.log(`停住：${conflicts.length} 行对不上单一 apiCode，索引未改`);
      for (const row of conflicts.slice(0, 30)) {
        console.log(`  ${row.exchange} ${row.coin}/${row.eq} ${row.side} codes=${row.codes} id=${row.id}`);
      }
      process.exitCode = 1;
      return;
    }

    const seen = new Map();
    for (const row of positions) {
      const next = { ...row, apiCode: planned.get(row.id) || '' };
      const key = posKey(next);
      const prev = seen.get(key);
      if (prev) {
        console.log(`停住：补完后唯一键重复 ${row.exchange} ${next.coinName}/${next.equalCoinName} ${sideOf(next.positionSide)} apiCode=${next.apiCode}`);
        console.log(`  ${prev} 与 ${row.id}`);
        process.exitCode = 1;
        return;
      }
      seen.set(key, row.id);
    }

    let filled = 0;
    for (const row of positions) {
      const next = planned.get(row.id) || '';
      const current = String(row.apiCode || '').trim().toLowerCase();
      if (current === next && row.apiCode === next) continue;
      await prisma.$executeRawUnsafe(
        'UPDATE user_positions SET api_code = ? WHERE id = ?',
        next,
        row.id,
      );
      filled++;
    }

    const [lenRow] = await prisma.$queryRawUnsafe(
      `SELECT
         CAST(MAX(CHAR_LENGTH(api_code)) AS CHAR) AS code,
         CAST(MAX(CHAR_LENGTH(coin_name)) AS CHAR) AS coin,
         CAST(MAX(CHAR_LENGTH(equal_coin_name)) AS CHAR) AS eq,
         CAST(MAX(CHAR_LENGTH(position_side)) AS CHAR) AS side
       FROM user_positions`,
    );
    const maxCode = Number(lenRow?.code || 0);
    const maxCoin = Number(lenRow?.coin || 0);
    const maxEq = Number(lenRow?.eq || 0);
    const maxSide = Number(lenRow?.side || 0);
    if (maxCode > 32 || maxCoin > 64 || maxEq > 64 || maxSide > 64) {
      console.log(`停住：字段超长 code=${maxCode} coin=${maxCoin} eq=${maxEq} side=${maxSide}，索引未改`);
      process.exitCode = 1;
      return;
    }

    const [col] = await prisma.$queryRawUnsafe(
      `SELECT IS_NULLABLE AS nullable, CHARACTER_MAXIMUM_LENGTH AS len, COLUMN_DEFAULT AS def
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_positions' AND COLUMN_NAME = 'api_code'`,
    );
    const nullable = String(col?.nullable || '') === 'YES';
    const len = Number(col?.len || 0);
    const def = col?.def == null ? null : String(col.def);
    const [colInfo] = await prisma.$queryRawUnsafe(
      `SELECT CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_positions' AND COLUMN_NAME = 'coin_name'`,
    );
    const charset = String(colInfo?.charset || 'utf8mb4');
    const collation = String(colInfo?.collation || 'utf8mb4_unicode_ci');
    const colSql = (name, type, extra) =>
      `ALTER TABLE user_positions MODIFY ${name} ${type} CHARACTER SET ${charset} COLLATE ${collation} ${extra}`;
    if (nullable || len !== 32 || def !== '') {
      await prisma.$executeRawUnsafe(colSql('api_code', 'VARCHAR(32)', "NOT NULL DEFAULT ''"));
    }
    // user_id 仍是 varchar(191)。utf8mb4 下再带三个 varchar(191) 会超过 3072 字节，唯一键加不上。
    const wide = await prisma.$queryRawUnsafe(
      `SELECT COLUMN_NAME AS name, CHARACTER_MAXIMUM_LENGTH AS len
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_positions'
         AND COLUMN_NAME IN ('coin_name', 'equal_coin_name', 'position_side')`,
    );
    for (const row of wide) {
      if (Number(row.len) <= 64) continue;
      const extra = row.name === 'equal_coin_name' ? "NOT NULL DEFAULT ''" : 'NOT NULL';
      await prisma.$executeRawUnsafe(colSql(row.name, 'VARCHAR(64)', extra));
    }

    if (oldIndex && oldIndex !== newIndex) {
      await prisma.$executeRawUnsafe(`ALTER TABLE user_positions DROP INDEX \`${oldIndex}\``);
    }
    if (!newIndex) {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE user_positions ADD UNIQUE KEY user_pos_uniq (user_id, api_code, coin_name, equal_coin_name, position_side)',
      );
      newIndex = 'user_pos_uniq';
    }

    console.log(`持仓 api_code 已补 ${filled} 行，唯一键 ${newIndex}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  const msg = e?.message || String(e);
  // 新装/空库常见：表尚未建好。交给后面的 db push，不要打断 apply-dist
  if (/does not exist|Unknown table|user_positions/i.test(msg) && /exist|find|Unknown/i.test(msg)) {
    console.log(`跳过持仓回填：${msg.split('\n')[0]}`);
    return;
  }
  console.error(msg);
  process.exit(1);
});
