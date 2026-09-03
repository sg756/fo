/**
 * 点卡拆分：跟单点卡 vs 可提佣金
 * - 将历史 COMMISSION 入账从 balance 迁到 commissionBalance（不超过当前 balance）
 * - 将进行中的提现冻结从 frozen 迁到 commissionFrozen
 *
 * 用法: node scripts/migrate-commission-balance.js
 */
require('dotenv').config();
const { PrismaClient, Prisma } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const cards = await prisma.pointCard.findMany();
  let moved = 0;

  for (const card of cards) {
    const earned = await prisma.pointCardTx.aggregate({
      where: { userId: card.userId, type: 'COMMISSION' },
      _sum: { amount: true },
    });
    const earnedAmt = new Prisma.Decimal(earned._sum.amount ?? 0);

    const pending = await prisma.withdrawRequest.aggregate({
      where: {
        userId: card.userId,
        status: { in: ['PENDING', 'APPROVED'] },
      },
      _sum: { amount: true, fee: true },
    });
    const pendingAmt = new Prisma.Decimal(pending._sum.amount ?? 0).add(
      pending._sum.fee ?? 0,
    );

    const settled = await prisma.withdrawRequest.aggregate({
      where: {
        userId: card.userId,
        status: { in: ['SETTLED', 'RELEASED'] },
      },
      _sum: { amount: true, fee: true },
    });
    const settledAmt = new Prisma.Decimal(settled._sum.amount ?? 0).add(
      settled._sum.fee ?? 0,
    );

    // 理论剩余可提佣金 = 累计佣金 - 已结算提现 - 进行中提现
    let wantAvail = earnedAmt.sub(settledAmt).sub(pendingAmt);
    if (wantAvail.lt(0)) wantAvail = new Prisma.Decimal(0);

    // 历史佣金混在 balance 里，只能从当前 balance 挪出
    const bal = new Prisma.Decimal(card.balance);
    const alreadyComm = new Prisma.Decimal(card.commissionBalance ?? 0);
    if (alreadyComm.gt(0) || new Prisma.Decimal(card.commissionFrozen ?? 0).gt(0)) {
      // 已迁移过则跳过
      continue;
    }

    const moveAvail = wantAvail.gt(bal) ? bal : wantAvail;
    const froz = new Prisma.Decimal(card.frozen);
    const moveFrozen = pendingAmt.gt(froz) ? froz : pendingAmt;

    if (moveAvail.lte(0) && moveFrozen.lte(0)) continue;

    await prisma.pointCard.update({
      where: { id: card.id },
      data: {
        balance: bal.sub(moveAvail),
        frozen: froz.sub(moveFrozen),
        commissionBalance: moveAvail,
        commissionFrozen: moveFrozen,
      },
    });
    moved++;
    console.log(
      `user=${card.userId} moveAvail=${moveAvail} moveFrozen=${moveFrozen} earned=${earnedAmt}`,
    );
  }

  console.log(`DONE moved=${moved}/${cards.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
