import { PrismaService } from '../src/prisma/prisma.service';
import { createTestContext, destroyTestContext, TestContext } from './helpers/setup-module';
import {
  cleanupTestUser,
  createOpenLog,
  getLogByOrder,
  getPosition,
  seedTestUser,
  TestSeed,
} from './helpers/seed';
import { E2E, mapiMock, ORDER } from './helpers/mapi-mock';
import { FollowAbnormalKind, FollowFillKind, UserPositionStatus } from '@prisma/client';

const POSITION_KEY = 'bac_BTC_PC_long';

function wireSignalAccount(seed: TestSeed) {
  mapiMock.setAccounts([{ value: seed.accountGid, name: 'MockSignal' }]);
}

async function latestOpenLog(prisma: PrismaService, userId: string, orderGid?: string) {
  return prisma.signalFollowLog.findFirst({
    where: {
      userId,
      isOpen: true,
      ...(orderGid ? { orderGid } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

async function latestCloseLog(prisma: PrismaService, userId: string, orderGid?: string) {
  return prisma.signalFollowLog.findFirst({
    where: {
      userId,
      isOpen: false,
      ...(orderGid ? { orderGid } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

describe('信号→下单→平仓 全链路 Mock', () => {
  let ctx: TestContext;
  let prisma: PrismaService;
  let seed: TestSeed;

  beforeAll(async () => {
    process.env.FOLLOWER_ENABLED = 'false';
    process.env.TRADE_REQUIRE_PROXY = 'false';
    ctx = await createTestContext();
    prisma = ctx.module.get(PrismaService);
    seed = await seedTestUser(prisma);
    await prisma.systemConfig.upsert({
      where: { key: 'order_expire_seconds' },
      create: { key: 'order_expire_seconds', value: '3600', remark: 'test' },
      update: { value: '3600' },
    });
    await prisma.systemConfig.upsert({
      where: { key: 'signal_timeout_ms' },
      create: { key: 'signal_timeout_ms', value: '120000', remark: 'test' },
      update: { value: '120000' },
    });
    await prisma.systemConfig.upsert({
      where: { key: 'follow_halted' },
      create: { key: 'follow_halted', value: 'false', remark: 'test' },
      update: { value: 'false' },
    });
  }, 120000);

  afterAll(async () => {
    if (seed) await cleanupTestUser(prisma, seed);
    await destroyTestContext(ctx);
  });

  beforeEach(async () => {
    mapiMock.reset();
    wireSignalAccount(seed);
    mapiMock.setDefaultQuery('OPEN');
    mapiMock.setDefaultCancel('OK');
    await prisma.profitRecord.deleteMany({ where: { userId: seed.userId } });
    await prisma.signalFollowLog.deleteMany({ where: { userId: seed.userId } });
    await prisma.userPosition.deleteMany({ where: { userId: seed.userId } });
  });

  it('E2E-L1 开仓信号 → PlaceOrder → 全成 → 写仓', async () => {
    mapiMock.pushSignal({
      accountGID: seed.accountGid,
      positionKey: POSITION_KEY,
      orderGID: E2E.OPEN_GID,
      orderSide: 'open',
      quantity: 0.01,
      price: 50000,
    });

    await ctx.worker.runOnce();

    const openLog = await latestOpenLog(prisma, seed.userId, E2E.OPEN_GID);
    expect(openLog?.status).toBe('PLACED');
    expect(openLog?.orderId).toBeTruthy();
    expect(mapiMock.getPlaceOrderCount()).toBe(1);

    const orderId = openLog!.orderId!;
    mapiMock.setQuery(orderId, 'FULL');
    await ctx.worker.syncPlacedOrderFills();

    const filled = await prisma.signalFollowLog.findUnique({ where: { id: openLog!.id } });
    expect(filled?.status).toBe('FILLED');
    expect(filled?.fillKind).toBe(FollowFillKind.FULL);

    const pos = await getPosition(prisma, seed.userId);
    expect(pos?.status).toBe(UserPositionStatus.OPEN);
    expect(Number(pos?.qty)).toBeGreaterThan(0);
  });

  it('E2E-L2 开仓全成 → 平仓信号 → 全平 → 本地仓关闭', async () => {
    // 1) 开仓
    mapiMock.pushSignal({
      accountGID: seed.accountGid,
      positionKey: POSITION_KEY,
      orderGID: E2E.OPEN_GID,
      orderSide: 'open',
      quantity: 0.01,
      price: 50000,
    });
    await ctx.worker.runOnce();
    const openLog = await latestOpenLog(prisma, seed.userId, E2E.OPEN_GID);
    expect(openLog?.orderId).toBeTruthy();
    mapiMock.setQuery(openLog!.orderId!, 'FULL');
    await ctx.worker.syncPlacedOrderFills();

    const posOpen = await getPosition(prisma, seed.userId);
    const openQty = Number(posOpen?.qty ?? 0);
    expect(openQty).toBeGreaterThan(0);

    // 2) 平仓信号
    mapiMock.clearSignals();
    mapiMock.pushSignal({
      accountGID: seed.accountGid,
      positionKey: POSITION_KEY,
      orderGID: E2E.CLOSE_GID,
      orderSide: 'close',
      quantity: 0.01,
      price: 50100,
    });
    await ctx.worker.runOnce();

    const closeLog = await latestCloseLog(prisma, seed.userId, E2E.CLOSE_GID);
    expect(closeLog?.status).toBe('PLACED');
    expect(closeLog?.isOpen).toBe(false);
    expect(closeLog?.orderId).toBeTruthy();
    expect(mapiMock.getPlaceOrderCount()).toBe(2);

    mapiMock.setQuery(closeLog!.orderId!, 'FULL');
    await ctx.worker.syncPlacedOrderFills();

    const closedLog = await prisma.signalFollowLog.findUnique({ where: { id: closeLog!.id } });
    expect(closedLog?.status).toBe('FILLED');

    await ctx.trade.syncUserPositionFromLots({
      userId: seed.userId,
      exchange: 'BINANCE',
      coinName: 'BTC',
      equalCoinName: 'PC',
      positionSide: 'long',
    });
    const pos = await getPosition(prisma, seed.userId);
    expect(pos?.status).toBe(UserPositionStatus.CLOSED);
    expect(Number(pos?.qty ?? 0)).toBeCloseTo(0, 8);
  });

  it('E2E-L3 部分成开仓 → 撤剩余 → 平仓信号全平', async () => {
    mapiMock.pushSignal({
      accountGID: seed.accountGid,
      positionKey: POSITION_KEY,
      orderGID: E2E.OPEN_GID_PARTIAL,
      orderSide: 'open',
      quantity: 0.01,
      price: 50000,
    });
    await ctx.worker.runOnce();
    const openLog = await latestOpenLog(prisma, seed.userId, E2E.OPEN_GID_PARTIAL);
    const openOrderId = openLog!.orderId!;

    mapiMock.setQueryOverride(openOrderId, {
      status: '1',
      filledAmt: 0.0004,
      priceAvg: 50100,
      tradeFee: -0.1,
      errorMsg: '',
    });
    await ctx.worker.syncPlacedOrderFills();
    let pos = await getPosition(prisma, seed.userId);
    const partialQty = Number(pos?.qty ?? 0);
    expect(partialQty).toBeGreaterThan(0);

    mapiMock.setCancel(openOrderId, 'OK');
    mapiMock.setQueryOverride(openOrderId, {
      status: '-1',
      filledAmt: 0.0004,
      priceAvg: 50100,
      tradeFee: -0.1,
      errorMsg: '',
    });
    await ctx.trade.cancelOrder(seed.userId, {
      exchange: 'BINANCE',
      orderId: openOrderId,
      coinName: 'BTC',
      equalCoinName: 'PC',
      isOpen: true,
      cancelReason: 'SIGNAL',
      skipTradePassword: true,
    });
    pos = await getPosition(prisma, seed.userId);
    expect(Number(pos?.qty)).toBeCloseTo(partialQty, 6);

    mapiMock.clearSignals();
    mapiMock.pushSignal({
      accountGID: seed.accountGid,
      positionKey: POSITION_KEY,
      orderGID: E2E.CLOSE_GID_PARTIAL,
      orderSide: 'close',
      quantity: 0.01,
      price: 50100,
    });
    await ctx.worker.runOnce();

    const closeLog = await latestCloseLog(prisma, seed.userId, E2E.CLOSE_GID_PARTIAL);
    expect(closeLog?.orderId).toBeTruthy();
    mapiMock.setQuery(closeLog!.orderId!, 'FULL');
    await ctx.worker.syncPlacedOrderFills();

    await ctx.trade.syncUserPositionFromLots({
      userId: seed.userId,
      exchange: 'BINANCE',
      coinName: 'BTC',
      equalCoinName: 'PC',
      positionSide: 'long',
    });
    pos = await getPosition(prisma, seed.userId);
    expect(pos?.status).toBe(UserPositionStatus.CLOSED);
  });

  it('E2E-L4 同向仍有挂单时平仓信号先撤旧单再平', async () => {
    mapiMock.pushSignal({
      accountGID: seed.accountGid,
      positionKey: POSITION_KEY,
      orderGID: E2E.OPEN_GID,
      orderSide: 'open',
      quantity: 0.01,
      price: 50000,
    });
    await ctx.worker.runOnce();
    const openLog = await latestOpenLog(prisma, seed.userId, E2E.OPEN_GID);
    const openOrderId = openLog!.orderId!;

    mapiMock.setQueryOverride(openOrderId, {
      status: '1',
      filledAmt: 0.0004,
      priceAvg: 50100,
      tradeFee: -0.1,
      errorMsg: '',
    });
    await ctx.worker.syncPlacedOrderFills();
    expect((await getPosition(prisma, seed.userId))?.status).toBe(UserPositionStatus.OPEN);

    mapiMock.clearSignals();
    mapiMock.pushSignal({
      accountGID: seed.accountGid,
      positionKey: POSITION_KEY,
      orderGID: E2E.CLOSE_GID,
      orderSide: 'close',
      quantity: 0.01,
      price: 50100,
    });
    mapiMock.setCancel(openOrderId, 'OK');
    mapiMock.setQueryOverride(openOrderId, {
      status: '-1',
      filledAmt: 0.0004,
      priceAvg: 50100,
      tradeFee: -0.1,
      errorMsg: '',
    });
    await ctx.worker.runOnce();

    const openAfter = await getLogByOrder(prisma, seed.userId, openOrderId);
    expect(openAfter?.status).toBe('CANCELLED');

    const closeLog = await latestCloseLog(prisma, seed.userId, E2E.CLOSE_GID);
    expect(closeLog?.status).toBe('PLACED');
    mapiMock.setQuery(closeLog!.orderId!, 'FULL');
    await ctx.worker.syncPlacedOrderFills();

    await ctx.trade.syncUserPositionFromLots({
      userId: seed.userId,
      exchange: 'BINANCE',
      coinName: 'BTC',
      equalCoinName: 'PC',
      positionSide: 'long',
    });
    const pos = await getPosition(prisma, seed.userId);
    expect(pos?.status).toBe(UserPositionStatus.CLOSED);
  });

  it('E2E-L5 重复信号幂等：同一开仓信号不重复下单', async () => {
    const signalAt = Date.now();
    mapiMock.pushSignal({
      accountGID: seed.accountGid,
      positionKey: POSITION_KEY,
      orderGID: E2E.OPEN_GID,
      orderSide: 'open',
      quantity: 0.01,
      price: 50000,
      signalAt,
    });
    await ctx.worker.runOnce();
    const count1 = mapiMock.getPlaceOrderCount();

    mapiMock.pushSignal({
      accountGID: seed.accountGid,
      positionKey: POSITION_KEY,
      orderGID: E2E.OPEN_GID,
      orderSide: 'open',
      quantity: 0.01,
      price: 50000,
      signalAt,
    });
    await ctx.worker.runOnce();
    const count2 = mapiMock.getPlaceOrderCount();

    expect(count1).toBe(1);
    expect(count2).toBe(1);
    const logs = await prisma.signalFollowLog.count({
      where: { userId: seed.userId, isOpen: true, orderGid: E2E.OPEN_GID },
    });
    expect(logs).toBe(1);
  });

  it('E2E-L6 系统异常硬闸：先撤旧单失败时本信号不下单', async () => {
    await createOpenLog(prisma, { userId: seed.userId, orderId: ORDER.SYS_ERR });
    mapiMock.setCancel(ORDER.SYS_ERR, 'SYS');

    mapiMock.pushSignal({
      accountGID: seed.accountGid,
      positionKey: POSITION_KEY,
      orderGID: 'E2E-OG-OPEN-SYS-GATE',
      orderSide: 'open',
      quantity: 0.01,
      price: 50000,
    });

    await ctx.worker.runOnce();

    expect(mapiMock.getPlaceOrderCount()).toBe(0);
    const failedLog = await latestOpenLog(prisma, seed.userId, 'E2E-OG-OPEN-SYS-GATE');
    expect(failedLog?.status).toBe('FAILED');
    expect(failedLog?.abnormalKind).toBe(FollowAbnormalKind.SYSTEM);
  });

  it('E2E-L7 信号超时：过期信号不下单', async () => {
    const staleSignalAt = Date.now() - 180_000;
    mapiMock.pushSignal({
      accountGID: seed.accountGid,
      positionKey: POSITION_KEY,
      orderGID: 'E2E-OG-OPEN-STALE',
      orderSide: 'open',
      quantity: 0.01,
      price: 50000,
      signalAt: staleSignalAt,
    });

    await ctx.worker.runOnce();

    expect(mapiMock.getPlaceOrderCount()).toBe(0);
    const staleLog = await latestOpenLog(prisma, seed.userId, 'E2E-OG-OPEN-STALE');
    expect(staleLog).toBeNull();
  });
});
