const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const u1 = await p.user.findFirst({ where: { inviteCode: '20288208' } });
  const a1 = await p.user.findFirst({ where: { inviteCode: '18178002' } });
  if (!u1 || !a1) throw new Error('user not found');

  // 恢复环之前的关系：admin1 为根，u1 挂在 admin1 下
  await p.user.update({
    where: { id: a1.id },
    data: { parentId: null, l1Id: null, l2Id: null },
  });
  await p.user.update({
    where: { id: u1.id },
    data: { parentId: a1.id, l1Id: a1.id, l2Id: null },
  });

  const after = await p.user.findMany({
    where: { role: 'USER' },
    select: {
      id: true,
      nickname: true,
      email: true,
      inviteCode: true,
      parentId: true,
      l1Id: true,
      l2Id: true,
    },
  });
  const m = new Map(after.map((x) => [x.id, x.nickname || x.email]));
  console.log(
    after.map((u) => ({
      nick: u.nickname || u.email,
      code: u.inviteCode,
      parent: u.parentId ? m.get(u.parentId) : null,
      l1: u.l1Id ? m.get(u.l1Id) : null,
      l2: u.l2Id ? m.get(u.l2Id) : null,
    })),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
