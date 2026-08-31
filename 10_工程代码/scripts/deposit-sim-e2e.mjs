// DramaX 充值入账引擎 E2E（testnet，模拟模式——无需链上 gas）
// 用法：INTERNAL_TOKEN=xxx node deposit-sim-e2e.mjs [baseUrl]
// 原理：POST /internal/simulate-deposit（仅 testnet 开放）以真实最新块（满足确认数+reorg 校验）
//       构造 ChainEvent 推入 Queue，覆盖入账引擎全链路：确认数 → 块哈希校验 → D1 原子入账 → 账本。
//       getLogs 扫描 + 真实转账段由 deposit-e2e.mjs（gas 就绪后）覆盖。
const BASE = process.argv[2] ?? "https://dramax-api-testnet.dappweb.workers.dev";
const DOMAIN = "dramax-mobile-testnet.pages.dev";
const TOKEN = process.env.INTERNAL_TOKEN;

const log = (ok, name, detail = "") => console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
const assert = (ok, name, detail = "") => { log(ok, name, detail); if (!ok) process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (path, opts = {}) => {
  const r = await fetch(BASE + path, opts);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
assert(!!TOKEN, "env INTERNAL_TOKEN provided");

// 0. 前置
const health = await j("/health");
assert(health.status === 200 && health.body.chain === 97, "GET /health chain=97", JSON.stringify(health.body));

// 1. SIWE 登录（随机钱包，零 gas 需求）
const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
const account = privateKeyToAccount(generatePrivateKey());
console.log(`wallet: ${account.address}`);
const n = await j("/auth/nonce");
assert(n.status === 200 && n.body.nonce, "GET /auth/nonce");
const message = [
  `${DOMAIN} wants you to sign in with your Ethereum account:`,
  account.address, "", "DramaX deposit-sim E2E", "",
  `URI: https://${DOMAIN}`, "Version: 1", "Chain ID: 97",
  `Nonce: ${n.body.nonce}`, `Issued At: ${new Date().toISOString()}`,
].join("\n");
const signature = await account.signMessage({ message });
const login = await j("/auth/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ address: account.address, message, nonce: n.body.nonce, signature }),
});
assert(login.status === 200 && login.body.token, "SIWE login", `status=${login.status}`);
const auth = { authorization: `Bearer ${login.body.token}`, "content-type": "application/json" };

// 2. DEPOSIT 意图
const intent = await j("/payments/intent", {
  method: "POST", headers: auth,
  body: JSON.stringify({ orderType: "DEPOSIT", orderId: crypto.randomUUID(), baseAmount: "50" }),
});
assert(intent.status === 201, "POST /payments/intent (DEPOSIT)", `status=${intent.status}`);
const { intentId, saltAmount } = intent.body;
console.log(`intent=${intentId} saltAmount=${saltAmount}`);

// 3. 负向：无 token / 错 token
const unauth = await fetch(`${BASE}/internal/simulate-deposit`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intentId }),
});
assert(unauth.status === 401, "simulate w/o token -> 401", `status=${unauth.status}`);
const notfound = await fetch(`${BASE}/internal/simulate-deposit`, {
  method: "POST", headers: { "x-internal-token": TOKEN, "content-type": "application/json" },
  body: JSON.stringify({ intentId: "00000000-0000-4000-8000-000000000000" }),
});
assert(notfound.status === 404, "simulate unknown intent -> 404", `status=${notfound.status}`);

// 4. 触发模拟入账
const sim = await fetch(`${BASE}/internal/simulate-deposit`, {
  method: "POST", headers: { "x-internal-token": TOKEN, "content-type": "application/json" },
  body: JSON.stringify({ intentId }),
});
const simBody = await sim.json().catch(() => ({}));
assert(sim.status === 202 && simBody.queued, "POST /internal/simulate-deposit", `status=${sim.status} tx=${simBody.txHash}`);

// 5. 轮询意图状态 → CREDITED（Queue 消费 + D1 batch 入账）
let credited = false, lastStatus = "";
for (let i = 0; i < 24; i++) {
  await sleep(5000);
  const st = await j(`/payments/${intentId}/status`);
  lastStatus = st.body.status ?? JSON.stringify(st.body);
  console.log(`poll#${i}: ${lastStatus}`);
  if (lastStatus === "CREDITED") { credited = true; break; }
}
assert(credited, "intent CREDITED via queue consumer", `last=${lastStatus}`);

// 6. 账本断言
const ledger = await j("/ledger/drama", { headers: { authorization: auth.authorization } });
assert(ledger.status === 200, "GET /ledger/drama");
const dep = (ledger.body.ledger ?? []).find((r) => r.type === "DEPOSIT");
assert(!!dep && dep.amount === saltAmount, "ledger DEPOSIT amount == saltAmount", `${dep?.amount} vs ${saltAmount}`);
assert(dep.balance_after === saltAmount, "balance_after == credited amount", dep.balance_after);

console.log(`\nALL PASS — 模拟入账 ${saltAmount} Drama（Queue 全链路），tx=${simBody.txHash}`);
