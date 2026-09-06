/**
 * 生产/开发统一种子脚本（纯 JS，不依赖 ts-node）。
 * 幂等：已有管理员 / 平台账户 / 规则等则跳过或 upsert，不覆盖已有管理员密码。
 * 账号密码来自 .env：ADMIN_EMAIL / ADMIN_PASSWORD
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const prisma = new PrismaClient();

function genNumericInviteCode(length = 8) {
  const max = 10 ** length;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(length, '0');
}

async function main() {
  const email = process.env.ADMIN_EMAIL || 'admin@floworder.local';
  const password = process.env.ADMIN_PASSWORD || 'admin123456';

  const systemRole = await prisma.adminRole.upsert({
    where: { code: 'system' },
    create: {
      code: 'system',
      name: '系统管理员',
      menus: [],
      isSystem: true,
      description: '全部菜单',
    },
    update: {},
  });

  const existing = await prisma.admin.findUnique({ where: { email } });
  if (!existing) {
    await prisma.admin.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(password, 10),
        nickname: '平台管理员',
        status: 'ACTIVE',
        adminRoleId: systemRole.id,
      },
    });
    console.log(`已创建管理员(admins表): ${email} / ${password}`);
  } else {
    console.log(`管理员已存在: ${email}`);
  }

  let platform = await prisma.user.findFirst({ where: { isPlatform: true } });
  if (!platform) {
    let inviteCode = genNumericInviteCode();
    for (let i = 0; i < 20; i++) {
      const exists = await prisma.user.findUnique({ where: { inviteCode } });
      if (!exists) break;
      inviteCode = genNumericInviteCode();
    }
    await prisma.user.create({
      data: {
        email: 'platform@system.local',
        passwordHash: await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10),
        nickname: '平台账户',
        status: 'DISABLED',
        isPlatform: true,
        inviteCode,
        pointCard: { create: {} },
      },
    });
    console.log('已创建平台点卡账户 platform@system.local');
  }

  const rule = await prisma.commissionRule.findFirst({ where: { active: true } });
  if (!rule) {
    await prisma.commissionRule.create({
      data: {
        name: 'default',
        extractRate: 0.1,
        l1Rate: 0.25,
        l2Rate: 0.5,
        platformRate: 0.25,
        active: true,
      },
    });
    console.log('已创建默认佣金规则: 抽成=10% 池内直推=25% 间推=50% 平台=25%');
  }

  const proxyCount = await prisma.ipProxy.count();
  if (proxyCount === 0) {
    await prisma.ipProxy.createMany({
      data: [
        {
          name: '主下单节点',
          host: '10.0.0.11',
          port: 3128,
          egressIp: '203.0.113.10',
          region: 'SG',
          weight: 2,
        },
        {
          name: '备用节点 A',
          host: '10.0.0.12',
          port: 3128,
          egressIp: '203.0.113.28',
          region: 'JP',
          weight: 1,
        },
        {
          name: '备用节点 B',
          host: '10.0.0.13',
          port: 3128,
          egressIp: '198.51.100.44',
          region: 'US',
          weight: 1,
        },
      ],
    });
    console.log('已创建 3 条示例出口 IP 代理');
  }

  const cc = await prisma.collectionConfig.findFirst({ where: { chain: 'ETH' } });
  if (!cc) {
    await prisma.collectionConfig.create({
      data: {
        chain: 'ETH',
        targetAddress: '0x0000000000000000000000000000000000000000',
        threshold: 10,
        active: true,
      },
    });
    console.log('已创建默认归集配置(ETH), 请在后台修改目标地址');
  }

  await prisma.systemConfig.upsert({
    where: { key: 'signal_timeout_seconds' },
    create: {
      key: 'signal_timeout_seconds',
      value: '60',
      remark: '跟单信号超时秒数, 超过则作废',
    },
    update: {},
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
