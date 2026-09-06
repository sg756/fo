const API = "http://127.0.0.1:3000/api";
function extractCaptchaCode(imageDataUrl) {
  const b64 = String(imageDataUrl || "").replace(/^data:image\/svg\+xml;base64,/, "");
  const svg = Buffer.from(b64, "base64").toString("utf8");
  return [...svg.matchAll(/>([A-Z0-9])<\/text>/gi)].map((m) => m[1]).join("");
}
async function main() {
  const cap = await fetch(`${API}/admin/auth/captcha`).then((r) => r.json());
  const code = extractCaptchaCode(cap.image);
  const lj = await fetch(`${API}/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "admin@floworder.local",
      password: "admin123456",
      captchaId: cap.id,
      captchaCode: code,
    }),
  }).then((r) => r.json());
  if (!lj.accessToken) throw new Error(JSON.stringify(lj));
  const auth = { Authorization: `Bearer ${lj.accessToken}` };
  const userId = "cmrsxb3nn01uvt2kmm8qwrtkf";
  const t0 = Date.now();
  const bal = await fetch(`${API}/admin/trade/users/${userId}/balances`, { headers: auth }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));
  console.log("elapsed", Date.now() - t0);
  // summarize without huge dump
  const ex = (bal.body.exchanges || []).map((e) => ({
    exchange: e.exchange,
    usdt: e.usdt,
    accounts: (e.accounts || []).map((a) => ({
      type: a.accountType,
      ok: a.ok,
      message: a.message,
      usdt: a.usdt,
      nAssets: (a.assets || []).length,
    })),
  }));
  console.log(JSON.stringify({ status: bal.status, ok: bal.body.ok, message: bal.body.message, exchanges: ex }, null, 2));

  const { PrismaClient } = require("@prisma/client");
  const p = new PrismaClient();
  const last = await p.postLog.findFirst({
    where: { endpoint: { contains: "QueryBalance" }, exchange: "BINANCE" },
    orderBy: { createdAt: "desc" },
  });
  const req = JSON.parse(last.requestBody || "{}");
  console.log("LAST_REQ", {
    proxyIP: req.proxyIP,
    accountType: req.accountType,
    apiCode: req.account?.apiCode,
    ms: last.latencyMs,
    resp: last.responseBody,
  });
  await p.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
