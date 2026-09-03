/**
 * 清理分销脏数据：断开 parent 环、去掉自指、按 parent 重算 l1/l2
 */
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
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const state = new Map(
    users.map((u) => [
      u.id,
      {
        id: u.id,
        email: u.email,
        nickname: u.nickname,
        inviteCode: u.inviteCode,
        createdAt: u.createdAt,
        parentId: u.parentId,
        origParentId: u.parentId,
        origL1Id: u.l1Id,
        origL2Id: u.l2Id,
      },
    ]),
  );

  // 1) 断开环：环内最早注册用户作为树根，清掉其 parent
  for (const u of users) {
    const seen = [];
    let cur = u.id;
    let foundCycle = false;
    while (state.get(cur)?.parentId) {
      const pid = state.get(cur).parentId;
      if (pid === u.id || seen.includes(pid)) {
        foundCycle = true;
        break;
      }
      if (!state.has(pid)) break;
      seen.push(pid);
      cur = pid;
    }
    if (!foundCycle) continue;

    const cycleIds = [u.id, ...seen];
    const root = cycleIds
      .map((id) => state.get(id))
      .filter(Boolean)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (root?.parentId) {
      console.log('break cycle: clear parent of', root.nickname || root.email);
      root.parentId = null;
    }
  }

  // 2) 自指 / 指向不存在
  for (const u of state.values()) {
    if (u.parentId === u.id) {
      console.log('clear self-parent', u.nickname || u.email);
      u.parentId = null;
    }
    if (u.parentId && !state.has(u.parentId)) {
      console.log('clear missing parent', u.nickname || u.email);
      u.parentId = null;
    }
  }

  // 3) 重算 l1/l2 并写库
  let n = 0;
  for (const u of state.values()) {
    const parentId = u.parentId || null;
    const parent = parentId ? state.get(parentId) : null;
    const l1Id = parentId;
    const l2Id = parent?.parentId || null;

    if (u.origParentId !== parentId || u.origL1Id !== l1Id || u.origL2Id !== l2Id) {
      console.log('update', u.nickname || u.email, {
        before: { parentId: u.origParentId, l1Id: u.origL1Id, l2Id: u.origL2Id },
        after: { parentId, l1Id, l2Id },
      });
      await p.user.update({
        where: { id: u.id },
        data: { parentId, l1Id, l2Id },
      });
      n++;
    }
  }

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
  const by = new Map(after.map((x) => [x.id, x]));
  const label = (id) => {
    if (!id) return null;
    const x = by.get(id);
    return x ? x.nickname || x.email : id.slice(0, 8);
  };

  console.log('updated', n);
  console.log(
    'result',
    after.map((u) => ({
      nick: u.nickname || u.email,
      code: u.inviteCode,
      parent: label(u.parentId),
      l1: label(u.l1Id),
      l2: label(u.l2Id),
    })),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
