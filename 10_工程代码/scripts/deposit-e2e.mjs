// DramaX 充值入账链路 E2E（testnet，真实链上转账）
// 用法：E2E_DEPOSIT_KEY=0x... [MOCK_USDT=0x...] INTERNAL_TOKEN=xxx node deposit-e2e.mjs [baseUrl]
// 前置：
//   1. E2E_DEPOSIT_KEY：有 testnet gas 的私钥（>=0.01 tBNB）
//   2. MOCK_USDT：MockUSDT 合约地址（未设则自动部署，需要 gas）；首次部署后需把
//      testnet worker 的 USDT_CONTRACT var 指向该地址并重新部署 —— 脚本会断言 /payments/intent 返回的 usdt 一致
//   3. INTERNAL_TOKEN：/internal/cron 触发令牌（DRAMAX_CRON_TOKEN secret 同值）
// 覆盖：SIWE 登录 → MockUSDT mint → DEPOSIT 支付意图（盐值金额）→ 链上转账
//       → indexer getLogs 扫描（/internal/cron）→ 5 确认 + Queue 入账 → 账本/余额断言
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, createPublicClient, http, parseUnits, formatUnits } from "viem";
import MockUSDT from "../contracts/MockUSDT.json" with { type: "json" };

const BASE = process.argv[2] ?? "https://dramax-api-testnet.dappweb.workers.dev";
const DOMAIN = "dramax-mobile-testnet.pages.dev";
const RPC = "https://bsc-testnet-rpc.publicnode.com";
const KEY = process.env.E2E_DEPOSIT_KEY;
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;
const DEPOSIT_AMOUNT = "100"; // Drama，盐值会加 0.00~0.99 分位识别码

const log = (ok, name, detail = "") => console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
const assert = (ok, name, detail = "") => { log(ok, name, detail); if (!ok) process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (path, opts = {}) => {
  const r = await fetch(BASE + path, opts);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

assert(/^0x[0-9a-fA-F]{64}$/.test(KEY ?? ""), "env E2E_DEPOSIT_KEY provided");
const account = privateKeyToAccount(KEY);

const chain = {
  id: 97,
  name: "BSC Testnet",
  nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  testnet: true,
};
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });
console.log(`wallet: ${account.address}`);

// 0. gas 检查
const gas = await publicClient.getBalance({ address: account.address });
assert(gas > parseUnits("0.005", 18), "wallet has testnet gas", `${Number(formatUnits(gas, 18)).toFixed(4)} tBNB`);

// 1. MockUSDT：未配置则部署（部署者即 E2E 钱包）
let usdtAddr = process.env.MOCK_USDT;
if (!usdtAddr) {
  const hash = await walletClient.deployContract({ abi: MockUSDT.abi, bytecode: MockUSDT.bytecode, args: [] });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash });
  usdtAddr = rcpt.contractAddress;
  log(true, "MockUSDT deployed", usdtAddr);
  console.log(`>> 把 testnet worker 的 USDT_CONTRACT var 改为 ${usdtAddr} 并重新部署后重跑（本次继续用本地读写验证转账段）`);
}
const usdt = getContract({ address: usdtAddr, abi: MockUSDT.abi, client: { public: publicClient, wallet: walletClient } });

// 2. mint 足额测试 USDT（200，覆盖充值金额 + 误差）
const myUsdt = await usdt.read.balanceOf([account.address]);
if (myUsdt < parseUnits("200", 18)) {
  const h = await usdt.write.mint([account.address, parseUnits("200", 18)]);
  const r = await publicClient.waitForTransactionReceipt({ hash: h });
  assert(r.status === "success", "mint 200 MockUSDT");
} else {
  log(true, "MockUSDT balance sufficient", formatUnits(myUsdt, 18));
}

// 3. SIWE 登录
const n = await j("/auth/nonce");
assert(n.status === 200 && n.body.nonce, "GET /auth/nonce");
const message = [
  `${DOMAIN} wants you to sign in with your Ethereum account:`,
  account.address, "", "DramaX deposit E2E", "",
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

// 4. DEPOSIT 支付意图（金额含分位盐）
const orderId = crypto.randomUUID();
const intent = await j("/payments/intent", {
  method: "POST", headers: auth,
  body: JSON.stringify({ orderType: "DEPOSIT", orderId, baseAmount: DEPOSIT_AMOUNT }),
});
assert(intent.status === 201, "POST /payments/intent (DEPOSIT)", `status=${intent.status}`);
const { intentId, payee, saltAmount, usdt: intentUsdt, confirmations } = intent.body;
console.log(`intent=${intentId} payee=${payee} saltAmount=${saltAmount} confirmations=${confirmations}`);
assert(intentUsdt?.toLowerCase() === usdtAddr.toLowerCase(),
  "intent usdt matches MockUSDT",
  `intent=${intentUsdt} mock=${usdtAddr}（不一致说明 worker USDT_CONTRACT 未指向 MockUSDT，先 wrangler.toml 更新 + 重新部署）`);
assert(Number(saltAmount) > Number(DEPOSIT_AMOUNT) && Number(saltAmount) < Number(DEPOSIT_AMOUNT) + 1,
  "saltAmount in (base, base+1)", saltAmount);

// 5. 链上转账（精确盐值金额 → 平台归集地址）
const txHash = await usdt.write.transfer([payee, parseUnits(saltAmount, 18)]);
const rcpt = await publicClient.waitForTransactionReceipt({ hash: txHash });
assert(rcpt.status === "success", "on-chain USDT transfer", `tx=${txHash} block=${rcpt.blockNumber}`);

// 6. 触发 indexer 扫描（扫到 → chain_events + 入 Queue）
assert(!!INTERNAL_TOKEN, "env INTERNAL_TOKEN provided");
for (let i = 0; i < 3; i++) {
  const cr = await fetch(`${BASE}/internal/cron`, { method: "POST", headers: { "x-internal-token": INTERNAL_TOKEN } });
  console.log(`cron#${i}: ${cr.status}`);
  await sleep(8000);
}

// 7. 轮询意图状态（5 确认 ≈ 15s + Queue 消费延迟）
let credited = false;
let lastStatus = "";
for (let i = 0; i < 30; i++) {
  await sleep(10000);
  const st = await j(`/payments/${intentId}/status`);
  lastStatus = st.body.status ?? JSON.stringify(st.body);
  console.log(`poll#${i}: status=${lastStatus}`);
  if (lastStatus === "CREDITED") { credited = true; break; }
  if (lastStatus === "ROLLED_BACK") break;
}
assert(credited, "intent CREDITED (indexer scanned + queue credited)", `last=${lastStatus}`);

// 8. 账本断言：DEPOSIT 行，金额 = 盐值金额
const ledger = await j("/ledger/drama", { headers: { authorization: auth.authorization } });
assert(ledger.status === 200, "GET /ledger/drama");
const dep = (ledger.body.ledger ?? []).find((r) => r.type === "DEPOSIT" && r.ref_id === txHash);
assert(!!dep, "ledger DEPOSIT row for tx", `tx=${txHash}`);
assert(dep.amount === saltAmount, "ledger amount == saltAmount", `${dep.amount} vs ${saltAmount}`);

console.log(`\nALL PASS — 充值 ${saltAmount} Drama 入账，balance_after=${dep.balance_after}，tx=${txHash}`);
