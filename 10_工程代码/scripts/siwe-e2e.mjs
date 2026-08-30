// DramaX SIWE 真实签名 E2E（testnet）
// 用法：NODE_PATH=<workers-api>/node_modules node scripts/siwe-e2e.mjs [baseUrl]
// 覆盖：nonce → EIP-4361 消息构造 → 签名 → 登录 → JWT 鉴权读接口 → refresh → 重放防护
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const BASE = process.argv[2] ?? "https://dramax-api-testnet.dappweb.workers.dev";
const DOMAIN = "dramax-mobile-testnet.pages.dev";
const CHAIN_ID = 97;

const log = (ok, name, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
const assert = (ok, name, detail = "") => {
  log(ok, name, detail);
  if (!ok) process.exit(1);
};

const j = async (path, opts = {}) => {
  const r = await fetch(BASE + path, opts);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// 1. 一次性钱包
const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);
console.log(`wallet: ${account.address}`);
assert(/^0x[0-9a-f]{40}$/i.test(account.address), "wallet generated");

// 2. nonce
const n = await j("/auth/nonce");
assert(n.status === 200 && typeof n.body.nonce === "string" && n.body.nonce.length >= 16, "GET /auth/nonce", n.body.nonce);
const nonce = n.body.nonce;

// 3. EIP-4361 消息 + 签名
const message = [
  `${DOMAIN} wants you to sign in with your Ethereum account:`,
  account.address,
  "",
  "DramaX testnet E2E sign-in",
  "",
  `URI: https://${DOMAIN}`,
  "Version: 1",
  `Chain ID: ${CHAIN_ID}`,
  `Nonce: ${nonce}`,
  `Issued At: ${new Date().toISOString()}`,
].join("\n");
const signature = await account.signMessage({ message });
assert(signature.startsWith("0x") && signature.length > 100, "signMessage (EIP-191)");

// 4. 登录
const login = await j("/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ address: account.address, message, nonce, signature }),
});
assert(login.status === 200 && !!login.body.token, "POST /auth/login", `status=${login.status} err=${login.body.error ?? "-"}`);
const token = login.body.token;
console.log(`userId: ${login.body.userId}`);

const auth = { authorization: `Bearer ${token}` };

// 5. JWT 鉴权读接口
const holdings = await j("/holdings", { headers: auth });
assert(holdings.status === 200, "GET /holdings (auth)", `status=${holdings.status} count=${Array.isArray(holdings.body.holdings) ? holdings.body.holdings.length : "?"}`);

const listings = await j("/listings", { headers: auth });
const items = listings.body.listings ?? listings.body.items ?? [];
assert(listings.status === 200 && items.length >= 1, "GET /listings (auth)", `status=${listings.status} count=${items.length}`);
const ids = items.map((x) => x.id ?? x.listing_id ?? "");
console.log("listing ids:", ids.join(", "), JSON.stringify(items[0] ?? {}).slice(0, 200));
// 种子挂单可能正被上一轮 E2E 撮合锁定（15min 窗口），断言放宽为「任一种子价格在场」
const prices = items.map((x) => String(x.list_price ?? ""));
assert(prices.includes("15201.24") || prices.includes("945.90"), "seed listing price present (15201.24 / 945.90)", prices.join(","));

// 6. refresh
const ref = await j("/auth/refresh", { method: "POST", headers: auth });
assert(ref.status === 200 && !!ref.body.token, "POST /auth/refresh", `status=${ref.status}`);

// 7. 重放防护：同 nonce 再登录应 401
const replay = await j("/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ address: account.address, message, nonce, signature }),
});
assert(replay.status === 401, "nonce replay rejected", `status=${replay.status} err=${replay.body.error ?? "-"}`);

// 8. 未登录访问仍 401（无 token）
const anon = await j("/holdings");
assert(anon.status === 401, "GET /holdings (no token) -> 401", `status=${anon.status}`);

console.log("\n=== ALL SIWE E2E PASS ===");
