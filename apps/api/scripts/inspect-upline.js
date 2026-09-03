const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const users = await p.user.findMany({
    where: { role: 'USER' },
    select: {
      id: true,
      email: true,
      nickname: true,
      inviteCode: true,
      parentId: true,
      l1Id: true,
      l2Id: true,
    },
  });

  const byId = new Map(users.map((u) => [u.id, u]));
  const issues = [];

  for (const u of users) {
    // self parent / self l1 / self l2
    if (u.parentId === u.id) issues.push({ type: 'self_parent', user: u });
    if (u.l1Id === u.id) issues.push({ type: 'self_l1', user: u });
    if (u.l2Id === u.id) issues.push({ type: 'self_l2', user: u });

    // cycle detection
    const seen = new Set();
    let cur = u.parentId;
    let depth = 0;
    while (cur) {
      if (cur === u.id) {
        issues.push({ type: 'cycle', user: u, via: [...seen] });
        break;
      }
      if (seen.has(cur) || depth > 50) break;
      seen.add(cur);
      cur = byId.get(cur)?.parentId ?? null;
      depth++;
    }

    // l1/l2 mismatch vs parent chain
    const expectL1 = u.parentId || null;
    const parent = u.parentId ? byId.get(u.parentId) : null;
    const expectL2 = parent?.parentId || null;
    if (u.l1Id !== expectL1 || u.l2Id !== expectL2) {
      issues.push({
        type: 'l1l2_mismatch',
        user: u,
        expect: { l1Id: expectL1, l2Id: expectL2 },
      });
    }
  }

  console.log('users', users.length);
  console.log(
    'summary',
    users.map((u) => ({
      nick: u.nickname || u.email,
      code: u.inviteCode,
      parent: u.parentId ? byId.get(u.parentId)?.nickname || u.parentId.slice(0, 8) : null,
      l1: u.l1Id?.slice(0, 8),
      l2: u.l2Id?.slice(0, 8),
    })),
  );
  console.log('issues', JSON.stringify(issues, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
