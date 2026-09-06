import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();

async function main() {
  const positions = await p.userPosition.findMany({
    where: { coinName: 'VIC' },
    include: { user: { select: { nickname: true, userNo: true, email: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  console.log('=== positions ===');
  for (const r of positions) {
    console.log(
      JSON.stringify({
        user: r.user?.nickname || r.user?.email,
        userNo: r.user?.userNo,
        status: r.status,
        qty: String(r.qty),
        entry: String(r.entryPrice),
        side: r.positionSide,
        equal: r.equalCoinName,
        exchange: r.exchange,
        openedAt: r.openedAt,
        closedAt: r.closedAt,
        updatedAt: r.updatedAt,
      }),
    );
  }

  const logs = await p.signalFollowLog.findMany({
    where: { coinName: 'VIC' },
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { nickname: true, userNo: true } } },
  });
  console.log('=== logs', logs.length, '===');
  for (const r of logs) {
    const filled = Number(r.filledAmt ?? 0);
    const consumed = Number(r.consumedAmt ?? 0);
    console.log(
      JSON.stringify({
        user: r.user?.nickname,
        orderId: r.orderId,
        status: r.status,
        isOpen: r.isOpen,
        side: r.side,
        positionSide: r.positionSide,
        filled: String(r.filledAmt ?? ''),
        consumed: String(r.consumedAmt ?? ''),
        remain: r.isOpen ? filled - consumed : undefined,
        avg: String(r.avgPrice ?? ''),
        profitConsumed: r.profitConsumed,
        signalKey: r.signalKey,
        cancelMsg: r.cancelMsg?.slice?.(0, 40),
        errorMsg: r.errorMsg?.slice?.(0, 80),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }),
    );
  }

  const profits = await p.profitRecord.findMany({
    where: { symbol: { contains: 'VIC' } },
    orderBy: { createdAt: 'desc' },
  });
  console.log('=== profits ===');
  for (const r of profits) {
    console.log(
      JSON.stringify({
        symbol: r.symbol,
        profit: String(r.profit),
        settled: r.settled,
        orderId: r.orderId,
        signalKey: r.signalKey,
        closedAt: r.closedAt,
      }),
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
