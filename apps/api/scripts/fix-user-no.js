/**
 * 修复 users.user_no：回填空值并确保 AUTO_INCREMENT。
 * 幂等，可在 prisma db push 前执行。
 * 用法: node scripts/fix-user-no.js
 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const cols = await p.$queryRawUnsafe(
    `SELECT IS_NULLABLE, EXTRA FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'user_no'`,
  );
  if (!cols.length) {
    console.log('users.user_no 不存在，跳过');
    await p.$disconnect();
    return;
  }
  const extra = String(cols[0].EXTRA || '');
  const nullable = String(cols[0].IS_NULLABLE || '') === 'YES';

  const nulls = await p.$queryRawUnsafe(
    'SELECT COUNT(*) AS c FROM users WHERE user_no IS NULL',
  );
  const nullCount = Number(nulls[0].c) || 0;
  console.log(`user_no null=${nullCount} nullable=${nullable} extra=${extra || '(none)'}`);

  if (nullCount > 0) {
    const maxRow = await p.$queryRawUnsafe(
      'SELECT IFNULL(MAX(user_no), 0) AS m FROM users',
    );
    let n = Number(maxRow[0].m) || 0;
    const missing = await p.$queryRawUnsafe(
      'SELECT id FROM users WHERE user_no IS NULL ORDER BY createdAt ASC',
    );
    for (const u of missing) {
      n += 1;
      await p.$executeRawUnsafe('UPDATE users SET user_no = ? WHERE id = ?', n, u.id);
      console.log(`assigned ${u.id} -> ${n}`);
    }
  }

  if (nullable || !/auto_increment/i.test(extra)) {
    await p.$executeRawUnsafe(
      'ALTER TABLE `users` MODIFY `user_no` INT NOT NULL AUTO_INCREMENT',
    );
    console.log('altered user_no to NOT NULL AUTO_INCREMENT');
  } else {
    console.log('user_no already NOT NULL AUTO_INCREMENT');
  }

  await p.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});
