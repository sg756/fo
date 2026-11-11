/**
 * ENC_KEY 已更换、旧交易所 API Key 密文解不开时：清空 exchange_keys，
 * 并关闭这些用户的跟单开关，避免继续用失效 Key 下单。
 * 须人工通知用户在 App 里重新绑定 API。
 *
 * 默认只预览。真正写入：
 *   CONFIRM=1 node scripts/clear-exchange-keys.js
 *
 * 在 apps/api 目录执行；直接读同级 .env（不依赖 dotenv 包）。
 */
const fs = require('fs');
const path = require('path');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === '') process.env[key] = val;
  }
}

const apiRoot = path.join(__dirname, '..');
loadEnvFile(path.join(apiRoot, '.env.dev'));
loadEnvFile(path.join(apiRoot, '.env'));

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const APPLY = String(process.env.CONFIRM || '') === '1';

(async () => {
  const keys = await p.exchangeKey.findMany({
    select: {
      id: true,
      userId: true,
      exchange: true,
      label: true,
      active: true,
      user: { select: { userNo: true, nickname: true, email: true, followEnabled: true } },
    },
    orderBy: [{ userId: 'asc' }, { exchange: 'asc' }],
  });

  const userIds = [...new Set(keys.map((k) => k.userId))];
  const following = keys.filter((k) => k.user?.followEnabled).map((k) => k.userId);
  const followUserIds = [...new Set(following)];

  console.log(
    `mode=${APPLY ? 'APPLY' : 'DRY-RUN'} exchangeKeyRows=${keys.length} users=${userIds.length} followEnabledAmongThem=${followUserIds.length}`,
  );
  if (!APPLY) {
    console.log('预览模式：不写库。确认后执行：CONFIRM=1 node scripts/clear-exchange-keys.js');
  }

  for (const k of keys.slice(0, 10)) {
    console.log(
      `  userNo=${k.user?.userNo ?? '-'} ${k.exchange} label=${k.label || 'default'} active=${k.active} follow=${!!k.user?.followEnabled}`,
    );
  }
  if (keys.length > 10) console.log(`  ... 另有 ${keys.length - 10} 行`);

  if (APPLY && keys.length > 0) {
    const del = await p.exchangeKey.deleteMany({});
    console.log(`==> 已删除 exchange_keys ${del.count} 行`);

    if (followUserIds.length > 0) {
      const upd = await p.user.updateMany({
        where: { id: { in: followUserIds } },
        data: { followEnabled: false, followStoppedAt: new Date() },
      });
      console.log(`==> 已关闭跟单 followEnabled=false：${upd.count} 人`);
    }
  } else if (!APPLY && followUserIds.length > 0) {
    console.log(`预览：将关闭 ${followUserIds.length} 人的跟单开关`);
  }

  const outDir = path.join(__dirname, '..', '..', '..', 'backups');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(
    outDir,
    `clear-exchange-keys-${APPLY ? 'applied' : 'dryrun'}-${stamp}.json`,
  );
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        applied: APPLY,
        keyCount: keys.length,
        userCount: userIds.length,
        followDisabled: followUserIds.length,
        users: userIds.map((id) => {
          const sample = keys.find((k) => k.userId === id)?.user;
          return {
            userId: id,
            userNo: sample?.userNo ?? '',
            nickname: sample?.nickname || '',
            email: sample?.email || '',
            followEnabled: !!sample?.followEnabled,
            exchanges: keys.filter((k) => k.userId === id).map((k) => k.exchange),
          };
        }),
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`==> 名单已写 ${outFile}（勿提交 Git）`);
  console.log('请人工通知用户：在 App「开启合约 / 交易所 API」里重新填写 Key 后再开跟单。');
})()
  .catch((e) => {
    console.error('FAIL', e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => p.$disconnect());
