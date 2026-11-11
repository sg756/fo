/**
 * 旧 HD_MNEMONIC / ENC_KEY 已丢失、但库里还是老托管地址时：
 * 用当前 .env 的助记词 + ENC_KEY，给每个已有托管地址的用户换一套新地址。
 *
 * 默认只预览。真正写入：
 *   CONFIRM=1 node scripts/rotate-deposit-wallets.js
 *
 * 会保留 wallets 行 id（充值/归集历史外键不坏），只改 address / derivIndex / encPrivateKey。
 * 扫块之后只认新地址；打到旧地址的币系统收不到，且无私钥也归集不了——执行前务必公告用户。
 *
 * 在 apps/api 目录执行；直接读同级 .env（不依赖 dotenv 包）。
 * 交易所 API Key 请另跑：node scripts/clear-exchange-keys.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
const { HDNodeWallet, Mnemonic, getAddress } = require('ethers');

const p = new PrismaClient();
const HD_INDEX_KEY = 'hd_next_index';
const APPLY = String(process.env.CONFIRM || '') === '1';

function encrypt(plain) {
  const hex = process.env.ENC_KEY || '';
  if (hex.length !== 64) throw new Error('ENC_KEY 必须是 64 位 hex');
  const key = Buffer.from(hex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

function deriveAt(mnemonicPhrase, index) {
  const mnemonic = Mnemonic.fromPhrase(mnemonicPhrase);
  const wallet = HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${index}`);
  return { address: getAddress(wallet.address), privateKey: wallet.privateKey };
}

(async () => {
  const phrase = String(process.env.HD_MNEMONIC || '').trim();
  if (!phrase || phrase.includes('word1')) {
    throw new Error('请先在 .env 配置真实的 HD_MNEMONIC（当前为空或占位）');
  }
  if ((process.env.ENC_KEY || '').length !== 64) {
    throw new Error('请先在 .env 配置真实的 ENC_KEY');
  }

  const rows = await p.wallet.findMany({
    select: {
      id: true,
      userId: true,
      chain: true,
      address: true,
      derivIndex: true,
      user: { select: { email: true, nickname: true, userNo: true } },
    },
    orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }],
  });

  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.userId)) byUser.set(r.userId, []);
    byUser.get(r.userId).push(r);
  }

  const cfg = await p.systemConfig.findUnique({ where: { key: HD_INDEX_KEY } });
  let nextIndex = cfg ? Number(cfg.value) || 0 : 0;
  if (!Number.isFinite(nextIndex) || nextIndex < 0) nextIndex = 0;

  console.log(
    `mode=${APPLY ? 'APPLY' : 'DRY-RUN'} usersWithWallet=${byUser.size} walletRows=${rows.length} hd_next_index=${nextIndex}`,
  );
  if (!APPLY) {
    console.log('预览模式：不写库。确认后执行：CONFIRM=1 node scripts/rotate-deposit-wallets.js');
  }

  const mapping = [];
  let rotatedUsers = 0;

  for (const [userId, wallets] of byUser) {
    const oldAddress = getAddress(wallets[0].address);
    const oldIndex = wallets[0].derivIndex;
    const index = nextIndex;
    nextIndex += 1;
    const { address, privateKey } = deriveAt(phrase, index);
    const encPrivateKey = encrypt(privateKey);
    const u = wallets[0].user;

    mapping.push({
      userNo: u?.userNo ?? '',
      nickname: u?.nickname || '',
      email: u?.email || '',
      userId,
      oldIndex: oldIndex == null ? '' : oldIndex,
      oldAddress,
      newIndex: index,
      newAddress: address,
      chains: wallets.map((w) => w.chain).join('|'),
      rowCount: wallets.length,
    });

    if (APPLY) {
      await p.$transaction(
        wallets.map((w) =>
          p.wallet.update({
            where: { id: w.id },
            data: {
              address,
              derivIndex: index,
              encPrivateKey,
            },
          }),
        ),
      );
    }
    rotatedUsers += 1;
    if (rotatedUsers <= 5 || rotatedUsers % 50 === 0) {
      console.log(
        `#${rotatedUsers} userNo=${u?.userNo ?? '-'} ${oldAddress} -> ${address} index=${index} rows=${wallets.length}`,
      );
    }
  }

  if (APPLY && rotatedUsers > 0) {
    await p.systemConfig.upsert({
      where: { key: HD_INDEX_KEY },
      create: { key: HD_INDEX_KEY, value: String(nextIndex), remark: 'HD 派生下一索引' },
      update: { value: String(nextIndex) },
    });
    console.log(`==> hd_next_index 已更新为 ${nextIndex}`);
  } else if (!APPLY) {
    console.log(`预览：完成后 hd_next_index 将变为 ${nextIndex}`);
  }

  const outDir = path.join(__dirname, '..', '..', '..', 'backups');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(
    outDir,
    `rotate-deposit-wallets-${APPLY ? 'applied' : 'dryrun'}-${stamp}.json`,
  );
  fs.writeFileSync(
    outFile,
    JSON.stringify({ applied: APPLY, rotatedUsers, nextIndex, mapping }, null, 2),
    'utf8',
  );
  console.log(`==> 映射已写 ${outFile}（勿提交 Git）`);
  console.log(
    '提醒：请公告用户改用新充值地址；旧地址上若还有币，无旧钥则无法归集。重启 API 后扫块即只盯新地址。',
  );
})()
  .catch((e) => {
    console.error('FAIL', e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => p.$disconnect());
