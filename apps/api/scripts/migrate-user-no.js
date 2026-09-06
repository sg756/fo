/**
 * 为 users 增加后台内部序号 user_no（MySQL AUTO_INCREMENT UNIQUE，非主键）。
 * 主键仍为 cuid；可重复执行（幂等）。
 *
 * 用法: node scripts/migrate-user-no.js
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const START = 10001;

async function main() {
  const cols = await prisma.$queryRawUnsafe(`
    SELECT COLUMN_NAME, EXTRA, IS_NULLABLE, COLUMN_TYPE
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'user_no'
  `);

  if (!cols.length) {
    console.log('添加 user_no 列…');
    await prisma.$executeRawUnsafe(`ALTER TABLE users ADD COLUMN user_no INT NULL`);
  }

  const missing = await prisma.$queryRawUnsafe(`
    SELECT id FROM users WHERE user_no IS NULL ORDER BY createdAt ASC, id ASC
  `);
  if (missing.length) {
    const maxRows = await prisma.$queryRawUnsafe(`
      SELECT COALESCE(MAX(user_no), ${START - 1}) AS m FROM users
    `);
    let n = Number(maxRows[0]?.m ?? START - 1) + 1;
    if (n < START) n = START;
    console.log(`回填 ${missing.length} 行，从 ${n} 起…`);
    for (const row of missing) {
      await prisma.$executeRaw`UPDATE users SET user_no = ${n} WHERE id = ${row.id}`;
      n += 1;
    }
  }

  const meta = await prisma.$queryRawUnsafe(`
    SELECT EXTRA, IS_NULLABLE
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'user_no'
  `);
  const extra = String(meta[0]?.EXTRA || '').toLowerCase();
  const nullable = String(meta[0]?.IS_NULLABLE || '') === 'YES';

  const idx = await prisma.$queryRawUnsafe(`
    SELECT INDEX_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'user_no'
      AND NON_UNIQUE = 0
  `);
  if (!idx.length) {
    console.log('添加唯一索引 users_user_no_key…');
    await prisma.$executeRawUnsafe(`ALTER TABLE users ADD UNIQUE INDEX users_user_no_key (user_no)`);
  }

  if (nullable || !extra.includes('auto_increment')) {
    const maxRows = await prisma.$queryRawUnsafe(`SELECT COALESCE(MAX(user_no), ${START - 1}) AS m FROM users`);
    const next = Number(maxRows[0]?.m ?? START - 1) + 1;
    console.log(`设为 NOT NULL AUTO_INCREMENT，下一号=${next}…`);
    await prisma.$executeRawUnsafe(
      `ALTER TABLE users MODIFY COLUMN user_no INT NOT NULL AUTO_INCREMENT, AUTO_INCREMENT = ${next}`,
    );
  }

  const sample = await prisma.$queryRawUnsafe(
    `SELECT id, user_no, email FROM users ORDER BY user_no ASC LIMIT 5`,
  );
  console.log('完成。样例:', sample);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
