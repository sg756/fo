/**
 * 在 prisma db push 删掉 follow_templates.exchange / account_gid 之前，
 * 把现有单选数据抄进两张关联表。可重复执行。
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const cols = await prisma.$queryRawUnsafe(
    `SELECT COLUMN_NAME AS name
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'follow_templates'
       AND COLUMN_NAME IN ('exchange', 'account_gid', 'account_name')`,
  );
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('exchange')) {
    console.log('skip: follow_templates.exchange already gone');
    return;
  }

  const [collRow] = await prisma.$queryRawUnsafe(
    `SELECT TABLE_COLLATION AS c
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'follow_templates'`,
  );
  const collation = collRow?.c || 'utf8mb4_unicode_ci';
  const charset = String(collation).split('_')[0] || 'utf8mb4';

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS follow_template_exchanges (
      id VARCHAR(191) NOT NULL,
      template_id VARCHAR(191) NOT NULL,
      exchange ENUM('BINANCE','OKX','BITGET','BYBIT','GATE','HUOBI','KUCOIN','HYPERLIQUID','HASHKEY','BACKPACK','ASTER','LIGHTER') NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY follow_template_exchanges_template_id_exchange_key (template_id, exchange),
      KEY follow_template_exchanges_exchange_idx (exchange),
      CONSTRAINT follow_template_exchanges_template_id_fkey
        FOREIGN KEY (template_id) REFERENCES follow_templates(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) DEFAULT CHARACTER SET ${charset} COLLATE ${collation}
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS follow_template_accounts (
      id VARCHAR(191) NOT NULL,
      template_id VARCHAR(191) NOT NULL,
      account_gid VARCHAR(191) NOT NULL,
      account_name VARCHAR(191) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY follow_template_accounts_template_id_account_gid_key (template_id, account_gid),
      KEY follow_template_accounts_account_gid_idx (account_gid),
      CONSTRAINT follow_template_accounts_template_id_fkey
        FOREIGN KEY (template_id) REFERENCES follow_templates(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) DEFAULT CHARACTER SET ${charset} COLLATE ${collation}
  `);

  const exInserted = await prisma.$executeRawUnsafe(`
    INSERT INTO follow_template_exchanges (id, template_id, exchange, created_at)
    SELECT REPLACE(UUID(), '-', ''), id, exchange, NOW(3)
    FROM follow_templates t
    WHERE NOT EXISTS (
      SELECT 1 FROM follow_template_exchanges e
      WHERE e.template_id = t.id AND e.exchange = t.exchange
    )
  `);

  let accInserted = 0;
  if (names.has('account_gid')) {
    const nameExpr = names.has('account_name') ? 'account_name' : 'NULL';
    accInserted = await prisma.$executeRawUnsafe(`
      INSERT INTO follow_template_accounts (id, template_id, account_gid, account_name, created_at)
      SELECT REPLACE(UUID(), '-', ''), id, account_gid, ${nameExpr}, NOW(3)
      FROM follow_templates t
      WHERE account_gid IS NOT NULL AND account_gid <> ''
        AND NOT EXISTS (
          SELECT 1 FROM follow_template_accounts a
          WHERE a.template_id = t.id AND a.account_gid = t.account_gid
        )
    `);
  }

  const [counts] = await prisma.$queryRawUnsafe(
    `SELECT
       (SELECT COUNT(*) FROM follow_templates) AS templates,
       (SELECT COUNT(*) FROM follow_template_exchanges) AS exchanges,
       (SELECT COUNT(*) FROM follow_template_accounts) AS accounts`,
  );
  const flagCols = await prisma.$queryRawUnsafe(
    `SELECT COLUMN_NAME AS name
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'follow_templates'
       AND COLUMN_NAME IN ('all_exchanges', 'all_accounts')`,
  );
  const flags = new Set(flagCols.map((c) => c.name));
  if (!flags.has('all_exchanges')) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE follow_templates ADD COLUMN all_exchanges BOOLEAN NOT NULL DEFAULT false`,
    );
  }
  if (!flags.has('all_accounts')) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE follow_templates ADD COLUMN all_accounts BOOLEAN NOT NULL DEFAULT false`,
    );
  }

  console.log(
    JSON.stringify({
      insertedExchanges: Number(exInserted),
      insertedAccounts: Number(accInserted),
      templates: Number(counts.templates),
      exchanges: Number(counts.exchanges),
      accounts: Number(counts.accounts),
      flagsAdded: !flags.has('all_exchanges') || !flags.has('all_accounts'),
    }),
  );
}

main()
  .catch((e) => {
    console.error(e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
