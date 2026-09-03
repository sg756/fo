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
import { mapiMock, ORDER } from './helpers/mapi-mock';
import { FollowAbnormalKind, FollowFillKind, UserPositionStatus } from '@prisma/client';

describe('跟单 Mock 全分支集成测试', () => {
  let ctx: TestContext;
  let prisma: PrismaService;
  let seed: TestSeed;

  beforeAll(async () => {
    process.env.FOLLOWER_ENABLED = 'false';
    process.env.TRADE_REQUIRE_PROXY = 'false';
    ctx = await createTestContext();
    prisma = ctx.module.get(PrismaService);
    seed = await seedTestUser(prisma);
  }, 120000);

  afterAll(async () => {
    if (seed) await cleanupTestUser(prisma, seed);
    await destroyTestContext(ctx);
  });

  beforeEach(() => {
    mapiMock.reset();
    mapiMock.setDefaultQuery('OPEN');
    mapiMock.setDefaultCancel('OK');
  });

  async function wipeUserLogs() {
    await prisma.profitRecord.deleteMany({ where: { userId: seed.userId } });
    await prisma.signalFollowLog.deleteMany({ where: { userId: seed.userId } });
    await prisma.userPosition.deleteMany({ where: { userId: seed.userId } });
  }

  // ─── G: 写仓汇总 ─────────────────────────────────────────
  describe('G syncUserPositionFromLots', () => {
    beforeEach(() => wipeUserLogs());

    it('G-01 FILLED 开仓计入 qty', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.FULL,
        status: 'FILLED',
        fillKind: 'FULL',
        filledAmt: 0.01,
        avgPrice: 50200,
      });
      await ctx.trade.syncUserPositionFromLots({
        userId: seed.userId,
        exchange: 'BINANCE',
        coinName: 'BTC',
        equalCoinName: 'PC',
        positionSide: 'long',
      });
      const pos = await getPosition(prisma, seed.userId);
      expect(pos?.status).toBe(UserPositionStatus.OPEN);
      expect(Number(pos?.qty)).toBeCloseTo(0.01, 6);
    });

    it('G-02 CANCELLED+部分成计入 qty', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.PARTIAL,
        status: 'CANCELLED',
        fillKind: 'PARTIAL',
        filledAmt: 0.004,
        avgPrice: 50100,
      });
      await ctx.trade.syncUserPositionFromLots({
        userId: seed.userId,
        exchange: 'BINANCE',
        coinName: 'BTC',
        equalCoinName: 'PC',
        positionSide: 'long',
      });
      const pos = await getPosition(prisma, seed.userId);
      expect(Number(pos?.qty)).toBeCloseTo(0.004, 6);
    });

    it('G-03 PLACED+部分成计入 qty', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.PARTIAL,
        status: 'PLACED',
        fillKind: 'PARTIAL',
        filledAmt: 0.004,
        avgPrice: 50100,
      });
      await ctx.trade.syncUserPositionFromLots({
        userId: seed.userId,
        exchange: 'BINANCE',
        coinName: 'BTC',
        equalCoinName: 'PC',
        positionSide: 'long',
      });
      const pos = await getPosition(prisma, seed.userId);
      expect(Number(pos?.qty)).toBeCloseTo(0.004, 6);
    });

    it('G-04 CANCEL_FAILED+部分成计入 qty', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.PARTIAL,
        status: 'CANCEL_FAILED',
        fillKind: 'PARTIAL',
        filledAmt: 0.004,
        avgPrice: 50100,
      });
      await ctx.trade.syncUserPositionFromLots({
        userId: seed.userId,
        exchange: 'BINANCE',
        coinName: 'BTC',
        equalCoinName: 'PC',
        positionSide: 'long',
      });
      const pos = await getPosition(prisma, seed.userId);
      expect(Number(pos?.qty)).toBeCloseTo(0.004, 6);
    });

    it('G-05 零成交 CANCELLED 不写仓', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.OPEN_1,
        status: 'CANCELLED',
        fillKind: 'NONE',
        filledAmt: 0,
      });
      await ctx.trade.syncUserPositionFromLots({
        userId: seed.userId,
        exchange: 'BINANCE',
        coinName: 'BTC',
        equalCoinName: 'PC',
        positionSide: 'long',
      });
      const pos = await getPosition(prisma, seed.userId);
      expect(pos?.status).toBe(UserPositionStatus.CLOSED);
      expect(Number(pos?.qty ?? 0)).toBeCloseTo(0, 6);
    });

    it('G-06 两笔 lot 加权汇总', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.PARTIAL,
        status: 'CANCELLED',
        fillKind: 'PARTIAL',
        filledAmt: 0.004,
        avgPrice: 50000,
        signalKey: 'lot-a:open:na',
      });
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.FULL,
        status: 'FILLED',
        fillKind: 'FULL',
        filledAmt: 0.006,
        avgPrice: 50200,
        signalKey: 'lot-b:open:na',
      });
      await ctx.trade.syncUserPositionFromLots({
        userId: seed.userId,
        exchange: 'BINANCE',
        coinName: 'BTC',
        equalCoinName: 'PC',
        positionSide: 'long',
      });
      const pos = await getPosition(prisma, seed.userId);
      expect(Number(pos?.qty)).toBeCloseTo(0.01, 6);
      expect(Number(pos?.entryPrice)).toBeCloseTo(50120, 0);
    });

    it('G-07 全平后保留开仓均价', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.FULL,
        status: 'FILLED',
        fillKind: 'FULL',
        filledAmt: 0.01,
        avgPrice: 50200,
      });
      await ctx.trade.syncUserPositionFromLots({
        userId: seed.userId,
        exchange: 'BINANCE',
        coinName: 'BTC',
        equalCoinName: 'PC',
        positionSide: 'long',
      });
      expect(Number((await getPosition(prisma, seed.userId))?.entryPrice)).toBeCloseTo(50200, 0);

      await prisma.signalFollowLog.updateMany({
        where: { userId: seed.userId, orderId: ORDER.FULL },
        data: { consumedAmt: 0.01, profitConsumed: true },
      });
      await ctx.trade.syncUserPositionFromLots({
        userId: seed.userId,
        exchange: 'BINANCE',
        coinName: 'BTC',
        equalCoinName: 'PC',
        positionSide: 'long',
      });
      const pos = await getPosition(prisma, seed.userId);
      expect(pos?.status).toBe(UserPositionStatus.CLOSED);
      expect(Number(pos?.qty ?? 0)).toBeCloseTo(0, 6);
      expect(Number(pos?.entryPrice)).toBeCloseTo(50200, 0);
    });
  });

  // ─── A: 成交巡检 ─────────────────────────────────────────
  describe('A syncPlacedOrderFills', () => {
    beforeEach(() => wipeUserLogs());

    it('A-01 仍挂单 status=0', async () => {
      await createOpenLog(prisma, { userId: seed.userId, orderId: ORDER.OPEN_1 });
      mapiMock.setQuery(ORDER.OPEN_1, 'OPEN');
      await ctx.worker.syncPlacedOrderFills();
      const log = await getLogByOrder(prisma, seed.userId, ORDER.OPEN_1);
      expect(log?.status).toBe('PLACED');
      expect(log?.fillKind).toBe(FollowFillKind.NONE);
    });

    it('A-02 部分成写仓并尝试撤余', async () => {
      await createOpenLog(prisma, { userId: seed.userId, orderId: ORDER.PARTIAL });
      mapiMock.setQuery(ORDER.PARTIAL, 'PARTIAL');
      mapiMock.setCancel(ORDER.PARTIAL, 'OK');
      await ctx.worker.syncPlacedOrderFills();
      const log = await getLogByOrder(prisma, seed.userId, ORDER.PARTIAL);
      expect(log?.fillKind).toBe(FollowFillKind.PARTIAL);
      expect(Number(log?.filledAmt)).toBeCloseTo(0.004, 6);
      expect(['PLACED', 'CANCEL_FAILED']).toContain(log?.status);
      const pos = await getPosition(prisma, seed.userId);
      expect(Number(pos?.qty)).toBeCloseTo(0.004, 6);
    });

    it('A-03 部分成增量更新', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.PARTIAL,
        fillKind: 'PARTIAL',
        filledAmt: 0.004,
      });
      mapiMock.setQuery(ORDER.PARTIAL, 'PARTIAL_2');
      await ctx.worker.syncPlacedOrderFills();
      const log = await getLogByOrder(prisma, seed.userId, ORDER.PARTIAL);
      expect(Number(log?.filledAmt)).toBeCloseTo(0.006, 6);
      expect(['PLACED', 'CANCEL_FAILED']).toContain(log?.status);
      const pos = await getPosition(prisma, seed.userId);
      expect(Number(pos?.qty)).toBeCloseTo(0.006, 6);
    });

    it('A-04 全成 FILLED', async () => {
      await createOpenLog(prisma, { userId: seed.userId, orderId: ORDER.FULL });
      mapiMock.setQuery(ORDER.FULL, 'FULL');
      await ctx.worker.syncPlacedOrderFills();
      const log = await getLogByOrder(prisma, seed.userId, ORDER.FULL);
      expect(log?.status).toBe('FILLED');
      expect(log?.fillKind).toBe(FollowFillKind.FULL);
      const pos = await getPosition(prisma, seed.userId);
      expect(Number(pos?.qty)).toBeCloseTo(0.01, 6);
    });

    it('A-05 外部撤单零成交', async () => {
      await createOpenLog(prisma, { userId: seed.userId, orderId: ORDER.OPEN_1 });
      mapiMock.setQuery(ORDER.OPEN_1, 'CANCELLED');
      await ctx.worker.syncPlacedOrderFills();
      const log = await getLogByOrder(prisma, seed.userId, ORDER.OPEN_1);
      expect(log?.status).toBe('CANCELLED');
      expect(log?.fillKind).toBe(FollowFillKind.NONE);
      const pos = await getPosition(prisma, seed.userId);
      expect(pos).toBeNull();
    });

    it('A-06 外部撤单但已有部分成', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.PARTIAL,
        fillKind: 'PARTIAL',
        filledAmt: 0.004,
      });
      mapiMock.setQuery(ORDER.PARTIAL, 'CANCELLED_PARTIAL');
      await ctx.worker.syncPlacedOrderFills();
      const log = await getLogByOrder(prisma, seed.userId, ORDER.PARTIAL);
      expect(log?.status).toBe('CANCELLED');
      expect(log?.fillKind).toBe(FollowFillKind.PARTIAL);
      const pos = await getPosition(prisma, seed.userId);
      expect(Number(pos?.qty)).toBeCloseTo(0.004, 6);
    });

    it('A-07 unknown 本轮不动', async () => {
      await createOpenLog(prisma, { userId: seed.userId, orderId: ORDER.UNKNOWN });
      mapiMock.setQuery(ORDER.UNKNOWN, 'UNKNOWN');
      await ctx.worker.syncPlacedOrderFills();
      const log = await getLogByOrder(prisma, seed.userId, ORDER.UNKNOWN);
      expect(log?.status).toBe('PLACED');
    });

    it('A-08 查单超时本轮不动', async () => {
      await createOpenLog(prisma, { userId: seed.userId, orderId: ORDER.SYS_ERR });
      mapiMock.setQuery(ORDER.SYS_ERR, 'TIMEOUT');
      await ctx.worker.syncPlacedOrderFills();
      const log = await getLogByOrder(prisma, seed.userId, ORDER.SYS_ERR);
      expect(log?.status).toBe('PLACED');
    });

    it('A-09 部分平只减查单增量', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.FULL,
        status: 'FILLED',
        fillKind: 'FULL',
        filledAmt: 0.01,
        avgPrice: 50000,
      });
      await ctx.trade.syncUserPositionFromLots({
        userId: seed.userId,
        exchange: 'BINANCE',
        coinName: 'BTC',
        equalCoinName: 'PC',
        positionSide: 'long',
      });
      expect(Number((await getPosition(prisma, seed.userId))?.qty)).toBeCloseTo(0.01, 6);

      await prisma.signalFollowLog.create({
        data: {
          orderGid: 'OG-CLOSE-PART',
          signalKey: `OG-CLOSE-PART:close:${Date.now()}`,
          userId: seed.userId,
          exchange: 'BINANCE',
          status: 'PLACED',
          success: true,
          orderId: ORDER.OPEN_2,
          symbol: 'BTC/PC',
          side: 'close',
          orderType: 'limit',
          accountType: 'future',
          coinName: 'BTC',
          equalCoinName: 'PC',
          positionSide: 'long',
          isOpen: false,
          orderAmt: 0.01,
          requestBody: JSON.stringify({
            isOpen: false,
            amount: 0.01,
            coinName: 'BTC',
            equalCoinName: 'PC',
          }),
        },
      });
      mapiMock.setQuery(ORDER.OPEN_2, 'PARTIAL');
      mapiMock.setCancel(ORDER.OPEN_2, 'OK');
      await ctx.worker.syncPlacedOrderFills();
      const pos = await getPosition(prisma, seed.userId);
      expect(Number(pos?.qty)).toBeCloseTo(0.006, 6);
    });
  });

  // ─── B: 撤单 ─────────────────────────────────────────────
  describe('B cancelOrder', () => {
    beforeEach(() => wipeUserLogs());

    it('B-01 撤成功零成交', async () => {
      await createOpenLog(prisma, { userId: seed.userId, orderId: ORDER.OPEN_1 });
      mapiMock.setCancel(ORDER.OPEN_1, 'OK');
      mapiMock.setQuery(ORDER.OPEN_1, 'CANCELLED');
      const res = await ctx.trade.cancelOrder(seed.userId, {
        exchange: 'BINANCE',
        orderId: ORDER.OPEN_1,
        coinName: 'BTC',
        equalCoinName: 'PC',
        isOpen: true,
        cancelReason: 'MANUAL',
        skipTradePassword: true,
      });
      expect(res.ok).toBe(true);
      const log = await getLogByOrder(prisma, seed.userId, ORDER.OPEN_1);
      expect(log?.status).toBe('CANCELLED');
      expect(log?.fillKind).toBe(FollowFillKind.NONE);
    });

    it('B-02 撤成功保留部分成', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.PARTIAL,
        fillKind: 'PARTIAL',
        filledAmt: 0.004,
        avgPrice: 50100,
      });
      mapiMock.setCancel(ORDER.PARTIAL, 'OK');
      mapiMock.setQuery(ORDER.PARTIAL, 'CANCELLED_PARTIAL');
      await ctx.trade.cancelOrder(seed.userId, {
        exchange: 'BINANCE',
        orderId: ORDER.PARTIAL,
        coinName: 'BTC',
        equalCoinName: 'PC',
        isOpen: true,
        cancelReason: 'SIGNAL',
        skipTradePassword: true,
      });
      const log = await getLogByOrder(prisma, seed.userId, ORDER.PARTIAL);
      expect(log?.status).toBe('CANCELLED');
      expect(log?.fillKind).toBe(FollowFillKind.PARTIAL);
      const pos = await getPosition(prisma, seed.userId);
      expect(Number(pos?.qty)).toBeCloseTo(0.004, 6);
    });

    it('B-03 撤时发现已全成', async () => {
      await createOpenLog(prisma, { userId: seed.userId, orderId: ORDER.FULL });
      mapiMock.setCancel(ORDER.FULL, 'OK');
      mapiMock.setQuery(ORDER.FULL, 'FULL');
      const res = await ctx.trade.cancelOrder(seed.userId, {
        exchange: 'BINANCE',
        orderId: ORDER.FULL,
        coinName: 'BTC',
        equalCoinName: 'PC',
        isOpen: true,
        cancelReason: 'MANUAL',
        skipTradePassword: true,
      });
      expect(res.filled).toBe(true);
      const log = await getLogByOrder(prisma, seed.userId, ORDER.FULL);
      expect(log?.status).toBe('FILLED');
      expect(log?.fillKind).toBe(FollowFillKind.FULL);
    });

    it('B-04 撤包成功但查单仍 partial → CANCEL_FAILED+写仓', async () => {
      await createOpenLog(prisma, { userId: seed.userId, orderId: ORDER.PARTIAL });
      mapiMock.setCancel(ORDER.PARTIAL, 'OK');
      mapiMock.setQuery(ORDER.PARTIAL, 'PARTIAL');
      await expect(
        ctx.trade.cancelOrder(seed.userId, {
          exchange: 'BINANCE',
          orderId: ORDER.PARTIAL,
          coinName: 'BTC',
          equalCoinName: 'PC',
          isOpen: true,
          cancelReason: 'MANUAL',
          skipTradePassword: true,
        }),
      ).rejects.toThrow(/仍挂单/);
      const log = await getLogByOrder(prisma, seed.userId, ORDER.PARTIAL);
      expect(log?.status).toBe('CANCEL_FAILED');
      const pos = await getPosition(prisma, seed.userId);
      expect(Number(pos?.qty)).toBeCloseTo(0.004, 6);
    });

    it('B-05 Unknown 假成功 → 业务异常+保留部分仓', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.UNKNOWN,
        fillKind: 'PARTIAL',
        filledAmt: 0.004,
        avgPrice: 50100,
      });
      mapiMock.setCancel(ORDER.UNKNOWN, 'FAKE_UNKNOWN');
      mapiMock.setQuery(ORDER.UNKNOWN, 'UNKNOWN');
      const res = await ctx.trade.cancelOrder(seed.userId, {
        exchange: 'BINANCE',
        orderId: ORDER.UNKNOWN,
        coinName: 'BTC',
        equalCoinName: 'PC',
        isOpen: true,
        cancelReason: 'SIGNAL',
        skipTradePassword: true,
      });
      expect((res as any).exchangeGone).toBe(true);
      const log = await getLogByOrder(prisma, seed.userId, ORDER.UNKNOWN);
      expect(log?.status).toBe('CANCELLED');
      expect(log?.abnormalKind).toBe(FollowAbnormalKind.BUSINESS);
      expect(log?.fillKind).toBe(FollowFillKind.PARTIAL);
      const pos = await getPosition(prisma, seed.userId);
      expect(Number(pos?.qty)).toBeCloseTo(0.004, 6);
    });

    it('B-07 撤单返回已成交', async () => {
      await createOpenLog(prisma, { userId: seed.userId, orderId: ORDER.FULL });
      mapiMock.setCancel(ORDER.FULL, 'FAIL_FILLED');
      const res = await ctx.trade.cancelOrder(seed.userId, {
        exchange: 'BINANCE',
        orderId: ORDER.FULL,
        coinName: 'BTC',
        equalCoinName: 'PC',
        isOpen: true,
        cancelReason: 'MANUAL',
        skipTradePassword: true,
      });
      expect(res.filled).toBe(true);
      const log = await getLogByOrder(prisma, seed.userId, ORDER.FULL);
      expect(log?.status).toBe('FILLED');
    });

    it('B-09 系统异常标 SYSTEM', async () => {
      await createOpenLog(prisma, { userId: seed.userId, orderId: ORDER.SYS_ERR });
      mapiMock.setCancel(ORDER.SYS_ERR, 'SYS');
      await expect(
        ctx.trade.cancelOrder(seed.userId, {
          exchange: 'BINANCE',
          orderId: ORDER.SYS_ERR,
          coinName: 'BTC',
          equalCoinName: 'PC',
          isOpen: true,
          cancelReason: 'MANUAL',
          skipTradePassword: true,
        }),
      ).rejects.toThrow(/撤单失败/);
      const log = await getLogByOrder(prisma, seed.userId, ORDER.SYS_ERR);
      expect(log?.status).toBe('CANCEL_FAILED');
      expect(log?.abnormalKind).toBe(FollowAbnormalKind.SYSTEM);
    });
  });

  // ─── C: 先撤再开 ─────────────────────────────────────────
  describe('C clearSameDirectionOpenOrders', () => {
    beforeEach(() => wipeUserLogs());

    it('C-01 无旧单直接 ok', async () => {
      const res = await ctx.trade.clearSameDirectionOpenOrders({
        userId: seed.userId,
        exchange: 'BINANCE',
        coinName: 'BTC',
        equalCoinName: 'PC',
        positionSide: 'long',
      });
      expect(res.ok).toBe(true);
      expect(res.cleared).toBe(0);
    });

    it('C-10 撤净旧单', async () => {
      await createOpenLog(prisma, { userId: seed.userId, orderId: ORDER.OPEN_1 });
      mapiMock.setCancel(ORDER.OPEN_1, 'OK');
      mapiMock.setQuery(ORDER.OPEN_1, 'CANCELLED');
      const res = await ctx.trade.clearSameDirectionOpenOrders({
        userId: seed.userId,
        exchange: 'BINANCE',
        coinName: 'BTC',
        equalCoinName: 'PC',
        positionSide: 'long',
        cancelReason: 'SIGNAL',
      });
      expect(res.ok).toBe(true);
      expect(res.cleared).toBe(1);
      const log = await getLogByOrder(prisma, seed.userId, ORDER.OPEN_1);
      expect(log?.status).toBe('CANCELLED');
    });

    it('C-11 部分成后撤净并保留仓', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.PARTIAL,
        fillKind: 'PARTIAL',
        filledAmt: 0.004,
        avgPrice: 50100,
      });
      mapiMock.setCancel(ORDER.PARTIAL, 'OK');
      mapiMock.setQuery(ORDER.PARTIAL, 'CANCELLED_PARTIAL');
      const res = await ctx.trade.clearSameDirectionOpenOrders({
        userId: seed.userId,
        exchange: 'BINANCE',
        coinName: 'BTC',
        equalCoinName: 'PC',
        positionSide: 'long',
        cancelReason: 'SIGNAL',
      });
      expect(res.ok).toBe(true);
      const pos = await getPosition(prisma, seed.userId);
      expect(Number(pos?.qty)).toBeCloseTo(0.004, 6);
    });

    it('C-12 Unknown 后可继续', async () => {
      await createOpenLog(prisma, { userId: seed.userId, orderId: ORDER.UNKNOWN });
      mapiMock.setCancel(ORDER.UNKNOWN, 'FAKE_UNKNOWN');
      mapiMock.setQuery(ORDER.UNKNOWN, 'UNKNOWN');
      const res = await ctx.trade.clearSameDirectionOpenOrders({
        userId: seed.userId,
        exchange: 'BINANCE',
        coinName: 'BTC',
        equalCoinName: 'PC',
        positionSide: 'long',
        cancelReason: 'SIGNAL',
      });
      expect(res.ok).toBe(true);
      expect(res.cleared).toBe(1);
    });

    it('C-20 系统异常硬闸', async () => {
      await createOpenLog(prisma, { userId: seed.userId, orderId: ORDER.SYS_ERR });
      mapiMock.setCancel(ORDER.SYS_ERR, 'SYS');
      const res = await ctx.trade.clearSameDirectionOpenOrders({
        userId: seed.userId,
        exchange: 'BINANCE',
        coinName: 'BTC',
        equalCoinName: 'PC',
        positionSide: 'long',
        cancelReason: 'SIGNAL',
      });
      expect(res.ok).toBe(false);
      expect(res.systemError).toBe(true);
      const log = await getLogByOrder(prisma, seed.userId, ORDER.SYS_ERR);
      expect(log?.abnormalKind).toBe(FollowAbnormalKind.SYSTEM);
    });

    it('C-30 业务仍挂单 blocked', async () => {
      await createOpenLog(prisma, { userId: seed.userId, orderId: ORDER.OPEN_1 });
      mapiMock.setCancel(ORDER.OPEN_1, 'FAIL_OPEN');
      const res = await ctx.trade.clearSameDirectionOpenOrders({
        userId: seed.userId,
        exchange: 'BINANCE',
        coinName: 'BTC',
        equalCoinName: 'PC',
        positionSide: 'long',
        cancelReason: 'SIGNAL',
      });
      expect(res.ok).toBe(false);
      expect(res.blocked).toBe(true);
    });
  });

  // ─── D: 端到端旅程 ───────────────────────────────────────
  describe('D 端到端', () => {
    beforeEach(() => wipeUserLogs());

    it('D-02 部分成→撤剩余→本地仓保留', async () => {
      await createOpenLog(prisma, { userId: seed.userId, orderId: ORDER.PARTIAL });
      mapiMock.setQuery(ORDER.PARTIAL, 'PARTIAL');
      await ctx.worker.syncPlacedOrderFills();
      mapiMock.setCancel(ORDER.PARTIAL, 'OK');
      mapiMock.setQuery(ORDER.PARTIAL, 'CANCELLED_PARTIAL');
      await ctx.trade.cancelOrder(seed.userId, {
        exchange: 'BINANCE',
        orderId: ORDER.PARTIAL,
        coinName: 'BTC',
        equalCoinName: 'PC',
        isOpen: true,
        cancelReason: 'EXPIRED',
        skipTradePassword: true,
      });
      const pos = await getPosition(prisma, seed.userId);
      expect(Number(pos?.qty)).toBeCloseTo(0.004, 6);
      const log = await getLogByOrder(prisma, seed.userId, ORDER.PARTIAL);
      expect(log?.status).toBe('CANCELLED');
      expect(log?.fillKind).toBe(FollowFillKind.PARTIAL);
    });

    it('D-05 有部分仓时 clear 后可读本地 qty', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.PARTIAL,
        status: 'CANCELLED',
        fillKind: 'PARTIAL',
        filledAmt: 0.004,
        avgPrice: 50100,
      });
      await ctx.trade.syncUserPositionFromLots({
        userId: seed.userId,
        exchange: 'BINANCE',
        coinName: 'BTC',
        equalCoinName: 'PC',
        positionSide: 'long',
      });
      const qty = await ctx.trade.getOpenLocalQty({
        userId: seed.userId,
        exchange: 'BINANCE',
        coinName: 'BTC',
        equalCoinName: 'PC',
        positionSide: 'long',
      });
      expect(qty).toBeCloseTo(0.004, 6);
    });
  });

  // ─── E: 过期撤 ───────────────────────────────────────────
  describe('E cancelExpiredOrders', () => {
    beforeEach(async () => {
      await wipeUserLogs();
      await prisma.systemConfig.upsert({
        where: { key: 'chase_on_expire' },
        create: { key: 'chase_on_expire', value: 'false', remark: 'test' },
        update: { value: 'false' },
      });
    });

    it('E-01 过期撤成功', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.OPEN_1,
        expiresAt: new Date(Date.now() - 60_000),
      });
      mapiMock.setCancel(ORDER.OPEN_1, 'OK');
      mapiMock.setQuery(ORDER.OPEN_1, 'CANCELLED');
      await ctx.worker.cancelExpiredOrders();
      const log = await getLogByOrder(prisma, seed.userId, ORDER.OPEN_1);
      expect(log?.status).toBe('CANCELLED');
      expect(log?.cancelReason).toBe('EXPIRED');
      expect(mapiMock.getPlaceOrderCount()).toBe(0);
    });

    it('E-02 过期撤部分成保留仓', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.PARTIAL,
        fillKind: 'PARTIAL',
        filledAmt: 0.004,
        expiresAt: new Date(Date.now() - 60_000),
      });
      mapiMock.setCancel(ORDER.PARTIAL, 'OK');
      mapiMock.setQuery(ORDER.PARTIAL, 'CANCELLED_PARTIAL');
      await ctx.worker.cancelExpiredOrders();
      const pos = await getPosition(prisma, seed.userId);
      expect(Number(pos?.qty)).toBeCloseTo(0.004, 6);
      expect(mapiMock.getPlaceOrderCount()).toBe(0);
    });

    it('E-03 开启 chaseOnExpire：过期撤单后自动市价追入', async () => {
      await prisma.systemConfig.upsert({
        where: { key: 'chase_on_expire' },
        create: { key: 'chase_on_expire', value: 'true', remark: 'test' },
        update: { value: 'true' },
      });
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.OPEN_2,
        expiresAt: new Date(Date.now() - 60_000),
      });
      mapiMock.setCancel(ORDER.OPEN_2, 'OK');
      mapiMock.setQuery(ORDER.OPEN_2, 'CANCELLED');

      await ctx.worker.cancelExpiredOrders();

      expect(mapiMock.getPlaceOrderCount()).toBe(1);
      const chased = await prisma.signalFollowLog.findFirst({
        where: {
          userId: seed.userId,
          orderType: 'market',
          status: 'PLACED',
          signalKey: { startsWith: 'chase:' },
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(chased).toBeTruthy();
      expect(chased?.requestBody || '').toContain('chase_on_expire');
    });
  });

  // ─── F: 系统异常重试 ─────────────────────────────────────
  describe('F retrySystemAbnormalCancels', () => {
    beforeEach(() => wipeUserLogs());

    it('F-02 重试成功后清除 SYSTEM', async () => {
      const log = await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.SYS_ERR,
        status: 'CANCEL_FAILED',
        abnormalKind: 'SYSTEM',
        abnormalAt: new Date(Date.now() - 15_000),
      });
      mapiMock.setCancel(ORDER.SYS_ERR, 'OK');
      mapiMock.setQuery(ORDER.SYS_ERR, 'CANCELLED');
      const res = await ctx.trade.retrySystemAbnormalCancels({ minIntervalMs: 0 });
      expect(res.tried).toBeGreaterThanOrEqual(1);
      const updated = await prisma.signalFollowLog.findUnique({ where: { id: log.id } });
      expect(updated?.abnormalKind).toBe(FollowAbnormalKind.NONE);
      expect(updated?.status).toBe('CANCELLED');
    });

    it('F-03 间隔未到不重试', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.SYS_ERR,
        status: 'CANCEL_FAILED',
        abnormalKind: 'SYSTEM',
        abnormalAt: new Date(),
      });
      const res = await ctx.trade.retrySystemAbnormalCancels({ minIntervalMs: 60_000 });
      expect(res.tried).toBe(0);
    });
  });

  // ─── H: 平仓数量兜底 ─────────────────────────────────────
  describe('H resolveCloseAmount', () => {
    it('H-01 不超本地仓', () => {
      const r = ctx.trade.resolveCloseAmount(0.005, 0.01, 0.9);
      expect(r.amount).toBeCloseTo(0.005, 6);
    });

    it('H-02 超量 clamp', () => {
      const r = ctx.trade.resolveCloseAmount(0.02, 0.01, 0.9);
      expect(r.amount).toBeCloseTo(0.01, 6);
      expect(r.fullClose).toBe(true);
    });

    it('H-03 近满抬全平', () => {
      const r = ctx.trade.resolveCloseAmount(0.009, 0.01, 0.9);
      expect(r.amount).toBeCloseTo(0.01, 6);
      expect(r.fullClose).toBe(true);
    });
  });

  // ─── I/J: 查询与边界 ─────────────────────────────────────
  describe('I/J 查询与边界', () => {
    beforeEach(() => wipeUserLogs());

    it('I-01 abnormalKind=SYSTEM 筛选', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.SYS_ERR,
        status: 'CANCEL_FAILED',
        abnormalKind: 'SYSTEM',
        abnormalAt: new Date(),
      });
      const rows = await prisma.signalFollowLog.findMany({
        where: { userId: seed.userId, abnormalKind: 'SYSTEM' },
      });
      expect(rows.length).toBe(1);
    });

    it('I-02 fillKind=PARTIAL 筛选', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.PARTIAL,
        fillKind: 'PARTIAL',
        filledAmt: 0.004,
      });
      const rows = await prisma.signalFollowLog.findMany({
        where: { userId: seed.userId, fillKind: 'PARTIAL' },
      });
      expect(rows.length).toBe(1);
    });

    it('J-07 Unknown 后保留部分仓不清 DISCARD', async () => {
      await createOpenLog(prisma, {
        userId: seed.userId,
        orderId: ORDER.UNKNOWN,
        fillKind: 'PARTIAL',
        filledAmt: 0.004,
        avgPrice: 50100,
      });
      await ctx.trade.syncOpenPositionFromFollowLog({
        userId: seed.userId,
        exchange: 'BINANCE',
        coinName: 'BTC',
        equalCoinName: 'PC',
        positionSide: 'long',
        isOpen: true,
      });
      mapiMock.setCancel(ORDER.UNKNOWN, 'FAKE_UNKNOWN');
      mapiMock.setQuery(ORDER.UNKNOWN, 'UNKNOWN');
      await ctx.trade.cancelOrder(seed.userId, {
        exchange: 'BINANCE',
        orderId: ORDER.UNKNOWN,
        coinName: 'BTC',
        equalCoinName: 'PC',
        isOpen: true,
        cancelReason: 'SIGNAL',
        skipTradePassword: true,
      });
      const pos = await getPosition(prisma, seed.userId);
      expect(pos?.status).toBe(UserPositionStatus.OPEN);
      expect(Number(pos?.qty)).toBeCloseTo(0.004, 6);
      expect(pos?.abnormal).toBe(false);
    });
  });

  // ─── K: 竞态测试 ─────────────────────────────────────────
  describe('K 竞态：syncPlacedOrderFills 与 cancelOrder 并发', () => {
    beforeEach(() => wipeUserLogs());

    it('K-01 并发时最终状态一致且不重复写仓位', async () => {
      await createOpenLog(prisma, { userId: seed.userId, orderId: ORDER.OPEN_1 });

      // 并发两条链都会 QueryOrder，同一 orderId 的返回前先卡住，制造 interleaving
      mapiMock.setQueryGate(ORDER.OPEN_1);
      mapiMock.setQuery(ORDER.OPEN_1, 'FULL');
      mapiMock.setCancel(ORDER.OPEN_1, 'OK');

      const pSync = ctx.worker.syncPlacedOrderFills();
      const pCancel = ctx.trade.cancelOrder(seed.userId, {
        exchange: 'BINANCE',
        orderId: ORDER.OPEN_1,
        coinName: 'BTC',
        equalCoinName: 'PC',
        isOpen: true,
        cancelReason: 'SIGNAL',
        skipTradePassword: true,
      });

      // 等两条并发链都走到 QueryOrder（都被闸门阻塞住）
      await mapiMock.waitForQueryGateCalls(ORDER.OPEN_1, 2);
      mapiMock.releaseQueryGate(ORDER.OPEN_1);

      await Promise.all([pSync, pCancel]);

      const log = await getLogByOrder(prisma, seed.userId, ORDER.OPEN_1);
      expect(log?.status).toBe('FILLED');

      const pos = await getPosition(prisma, seed.userId);
      expect(Number(pos?.qty ?? 0)).toBeCloseTo(0.01, 6);
    });
  });
});
