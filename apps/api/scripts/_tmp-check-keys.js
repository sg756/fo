const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const u = await p.user.findFirst({
    where: { email: 'admin1@account.local' },
    select: { id: true, email: true },
  });
  console.log('user', u);
  if (!u) return;
  const keys = await p.exchangeKey.findMany({
    where: { userId: u.id },
    select: {
      id: true,
      exchange: true,
      label: true,
      active: true,
      encApiKey: true,
      encApiSecret: true,
      encPassphrase: true,
      updatedAt: true,
    },
  });
  for (const k of keys) {
    console.log(
      JSON.stringify({
        exchange: k.exchange,
        label: k.label,
        active: k.active,
        hasKey: !!k.encApiKey,
        hasSecret: !!k.encApiSecret,
        hasPass: !!k.encPassphrase,
        passEncLen: k.encPassphrase ? k.encPassphrase.length : 0,
        updatedAt: k.updatedAt,
      }),
    );
  }
  await p.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});
