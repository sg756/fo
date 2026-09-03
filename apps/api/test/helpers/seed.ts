import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { Exchange, PrismaClient } from '@prisma/client';
import { encrypt } from '../../src/common/crypto.util';

export type TestSeed = {
  runId: string;
  userId: string;
  email: string;
  templateId: string;
  accountGid: string;
};

function ensureEncKey() {
  if (!process.env.ENC_KEY || process.env.ENC_KEY.length !== 64) {
    process.env.ENC_KEY = crypto.randomBytes(32).toString('hex');
  }
}

function genInvite() {
  return String(crypto.randomInt(0, 1e8)).padStart(8, '0');
}

export async function seedTestUser(prisma: PrismaClient): Promise<TestSeed> {
  ensureEncKey();
  const runId = `mock${Date.now()}`;
  const email = `${runId}@mock.test`;
  const accountGid = `G_SIGNAL_${runId}`;

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash('test123456', 8),
      nickname: `Mock ${runId}`,
      status: 'ACTIVE',
      followEnabled: true,
      followStartedAt: new Date(),
      inviteCode: genInvite(),
      pointCard: { create: { balance: 10000 } },
    },
  });

  await prisma.exchangeKey.create({
    data: {
      userId: user.id,
      exchange: 'BINANCE',
      label: 'mock',
      encApiKey: encrypt('mock-api-key'),
      encApiSecret: encrypt('mock-api-secret'),
      active: true,
    },
  });

  const template = await prisma.followTemplate.create({
    data: {
      name: `MockTpl ${runId}`,
      exchange: 'BINANCE',
      accountGid,
      accountName: 'MockSignal',
      unitAmount: 1,
      maxPrincipal: 1000,
      minInvestAmount: 1,
      active: true,
    },
  });

  await prisma.userFollowConfig.create({
    data: {
      userId: user.id,
      exchange: 'BINANCE',
      templateId: template.id,
      investAmount: 100,
    },
  });

  return {
    runId,
    userId: user.id,
    email,
    templateId: template.id,
    accountGid,
  };
}

export async function cleanupTestUser(prisma: PrismaClient, seed: TestSeed) {
  const uid = seed.userId;
  await prisma.profitRecord.deleteMany({ where: { userId: uid } });
  await prisma.followFillSlice.deleteMany({
    where: { followLog: { userId: uid } },
  }).catch(() => undefined);
  await prisma.signalFollowLog.deleteMany({ where: { userId: uid } });
  await prisma.userPosition.deleteMany({ where: { userId: uid } });
  await prisma.userFollowConfig.deleteMany({ where: { userId: uid } });
  await prisma.exchangeKey.deleteMany({ where: { userId: uid } });
  await prisma.pointCardTx.deleteMany({ where: { userId: uid } });
  await prisma.pointCard.deleteMany({ where: { userId: uid } });
  await prisma.user.deleteMany({ where: { id: uid } });
  await prisma.followTemplate.deleteMany({ where: { id: seed.templateId } });
}

export type OpenLogOpts = {
  userId: string;
  orderId: string;
  exchange?: Exchange;
  status?: 'PLACED' | 'FILLED' | 'CANCELLED' | 'CANCEL_FAILED' | 'PENDING';
  fillKind?: 'NONE' | 'PARTIAL' | 'FULL';
  filledAmt?: number;
  avgPrice?: number;
  abnormalKind?: 'NONE' | 'BUSINESS' | 'SYSTEM';
  abnormalAt?: Date | null;
  signalKey?: string;
  expiresAt?: Date | null;
};

export async function createOpenLog(prisma: PrismaClient, opts: OpenLogOpts) {
  const signalKey = opts.signalKey || `OG-${opts.orderId}:open:na`;
  return prisma.signalFollowLog.create({
    data: {
      orderGid: `OG-${opts.orderId}`,
      signalKey,
      userId: opts.userId,
      exchange: opts.exchange || 'BINANCE',
      status: opts.status || 'PLACED',
      success: true,
      orderId: opts.orderId,
      symbol: 'BTC/PC',
      side: 'open',
      orderType: 'limit',
      accountType: 'future',
      coinName: 'BTC',
      equalCoinName: 'PC',
      positionSide: 'long',
      isOpen: true,
      fillKind: opts.fillKind || 'NONE',
      orderAmt: 0.01,
      filledAmt: opts.filledAmt ?? 0,
      recordedFilledAmt: opts.filledAmt ?? 0,
      avgPrice: opts.avgPrice ?? 0,
      abnormalKind: opts.abnormalKind || 'NONE',
      abnormalAt: opts.abnormalAt ?? null,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 3600_000),
      requestBody: JSON.stringify({
        apiCode: 'bac',
        coinName: 'BTC',
        equalCoinName: 'PC',
        isOpen: true,
        amount: 0.01,
        price: 50000,
      }),
    },
  });
}

export async function getPosition(prisma: PrismaClient, userId: string) {
  return prisma.userPosition.findFirst({
    where: { userId, exchange: 'BINANCE', coinName: 'BTC', equalCoinName: 'PC', positionSide: 'long' },
  });
}

export async function getLogByOrder(prisma: PrismaClient, userId: string, orderId: string) {
  return prisma.signalFollowLog.findFirst({
    where: { userId, orderId },
    orderBy: { createdAt: 'desc' },
  });
}
