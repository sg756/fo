/**
 * 将 users.role=ADMIN 拆到 admins 表，并建立平台点卡账户。
 * 可重复执行（幂等）。
 */
const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');

const prisma = new PrismaClient();

function invite() {
  return String(crypto.randomInt(0, 1e8)).padStart(8, '0');
}

async function main() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS admins (
      id VARCHAR(191) NOT NULL,
      email VARCHAR(191) NOT NULL,
      passwordHash VARCHAR(191) NOT NULL,
      nickname VARCHAR(191) NULL,
      status ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
      adminRoleId VARCHAR(191) NULL,
      lastLoginAt DATETIME(3) NULL,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt DATETIME(3) NOT NULL,
      PRIMARY KEY (id),
      UNIQUE INDEX admins_email_key (email),
      INDEX admins_status_idx (status),
      INDEX admins_adminRoleId_idx (adminRoleId)
    ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  `);

  const cols = await prisma.$queryRawUnsafe(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'isPlatform'
  `);
  if (!cols.length) {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE users ADD COLUMN isPlatform TINYINT(1) NOT NULL DEFAULT 0
    `);
  }

  const hasRole = await prisma.$queryRawUnsafe(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'
  `);

  let admins = [];
  if (hasRole.length) {
    admins = await prisma.$queryRawUnsafe(`
      SELECT id, email, passwordHash, nickname, status, adminRoleId, lastLoginAt, createdAt, updatedAt
      FROM users WHERE role = 'ADMIN'
    `);
  }
  console.log('ADMIN users still in users:', admins.length);

  for (const a of admins) {
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO admins (id, email, passwordHash, nickname, status, adminRoleId, lastLoginAt, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        email = VALUES(email),
        passwordHash = VALUES(passwordHash),
        nickname = VALUES(nickname),
        status = VALUES(status),
        adminRoleId = VALUES(adminRoleId),
        lastLoginAt = VALUES(lastLoginAt),
        updatedAt = VALUES(updatedAt)
    `,
      a.id,
      a.email,
      a.passwordHash,
      a.nickname,
      a.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
      a.adminRoleId,
      a.lastLoginAt,
      a.createdAt,
      a.updatedAt || new Date(),
    );
  }

  let platform = await prisma.$queryRawUnsafe(`SELECT id FROM users WHERE isPlatform = 1 LIMIT 1`);
  if (!platform.length) {
    platform = await prisma.$queryRawUnsafe(
      `SELECT id FROM users WHERE email = 'platform@system.local' LIMIT 1`,
    );
  }
  let platformId = platform[0]?.id;
  if (!platformId) {
    let code = invite();
    for (let i = 0; i < 20; i++) {
      const exists = await prisma.$queryRawUnsafe(`SELECT id FROM users WHERE inviteCode = ?`, code);
      if (!exists.length) break;
      code = invite();
    }
    platformId = 'platform_' + crypto.randomBytes(8).toString('hex');
    const now = new Date();
    const roleExpr = hasRole.length ? `'USER'` : null;
    if (hasRole.length) {
      await prisma.$executeRawUnsafe(
        `
        INSERT INTO users (
          id, email, passwordHash, nickname, status, role, isPlatform, inviteCode, createdAt, updatedAt
        ) VALUES (?, 'platform@system.local', ?, '平台账户', 'DISABLED', 'USER', 1, ?, ?, ?)
      `,
        platformId,
        '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinu',
        code,
        now,
        now,
      );
    } else {
      await prisma.$executeRawUnsafe(
        `
        INSERT INTO users (
          id, email, passwordHash, nickname, status, isPlatform, inviteCode, createdAt, updatedAt
        ) VALUES (?, 'platform@system.local', ?, '平台账户', 'DISABLED', 1, ?, ?, ?)
      `,
        platformId,
        '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinu',
        code,
        now,
        now,
      );
    }
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO point_cards (id, userId, balance, frozen, updatedAt)
      VALUES (?, ?, 0, 0, ?)
      ON DUPLICATE KEY UPDATE userId = userId
    `,
      'pc_' + crypto.randomBytes(8).toString('hex'),
      platformId,
      now,
    );
    console.log('created platform user', platformId);
  } else {
    await prisma.$executeRawUnsafe(
      `UPDATE users SET isPlatform = 1, status = 'DISABLED', nickname = COALESCE(nickname, '平台账户') WHERE id = ?`,
      platformId,
    );
    console.log('platform user', platformId);
  }

  // 确保平台有点卡
  const pc = await prisma.$queryRawUnsafe(`SELECT id FROM point_cards WHERE userId = ?`, platformId);
  if (!pc.length) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO point_cards (id, userId, balance, frozen, updatedAt) VALUES (?, ?, 0, 0, ?)`,
      'pc_' + crypto.randomBytes(8).toString('hex'),
      platformId,
      new Date(),
    );
  }

  for (const a of admins) {
    const cards = await prisma.$queryRawUnsafe(
      `SELECT balance, frozen FROM point_cards WHERE userId = ?`,
      a.id,
    );
    if (cards[0]) {
      const bal = Number(cards[0].balance || 0);
      const fro = Number(cards[0].frozen || 0);
      if (bal !== 0 || fro !== 0) {
        await prisma.$executeRawUnsafe(
          `UPDATE point_cards SET balance = balance + ?, frozen = frozen + ? WHERE userId = ?`,
          bal,
          fro,
          platformId,
        );
        console.log('merged point card from', a.email, 'bal=', bal);
      }
    }
    await prisma.$executeRawUnsafe(
      `UPDATE commission_records SET earnerId = ? WHERE earnerId = ? AND level = 'PLATFORM'`,
      platformId,
      a.id,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE commission_records SET earnerId = ? WHERE earnerId = ?`,
      platformId,
      a.id,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE commission_records SET fromUserId = ? WHERE fromUserId = ?`,
      platformId,
      a.id,
    );

    await prisma.$executeRawUnsafe(`DELETE FROM point_card_txs WHERE userId = ?`, a.id);
    await prisma.$executeRawUnsafe(`DELETE FROM point_cards WHERE userId = ?`, a.id);
    const childTables = [
      'wallets',
      'recharge_orders',
      'withdraw_requests',
      'exchange_keys',
      'ip_assignments',
      'post_logs',
      'signal_follow_logs',
      'profit_records',
    ];
    for (const t of childTables) {
      try {
        await prisma.$executeRawUnsafe(`DELETE FROM ${t} WHERE userId = ?`, a.id);
      } catch (e) {
        console.warn('skip', t, e.message?.slice?.(0, 80) || e);
      }
    }
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = ?`, a.id);
    console.log('removed admin from users:', a.email);
  }

  const left = hasRole.length
    ? await prisma.$queryRawUnsafe(`SELECT COUNT(*) as c FROM users WHERE role = 'ADMIN'`)
    : [{ c: 0 }];
  const adminCount = await prisma.$queryRawUnsafe(`SELECT COUNT(*) as c FROM admins`);
  console.log('remaining ADMIN in users:', Number(left[0].c));
  console.log('admins table count:', Number(adminCount[0].c));
  console.log('done');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
