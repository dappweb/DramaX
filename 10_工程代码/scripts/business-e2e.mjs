// DramaX 全业务链路 E2E（testnet）
// 用法：node business-e2e.mjs [baseUrl]
// 覆盖：场次 → 预约(余额不足负向) → 只读账户端点 → 撮合种子挂单 → P2P 支付意图 → 撮合查询
//       → Admin 端点负向断言（未授权钱包 403 / 无 token 401）
// 注意：撮合会锁定 demo-l2（状态 MATCHED）；不付款 15 分钟后 cron 自动回滚为 LISTED（回滚修复 2026-08-30）。
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const BASE = process.argv[2] ?? "https://dramax-api-testnet.dappweb.workers.dev";
const DOMAIN = "dramax-admin-testnet.pages.dev"; // 撮合买家走 admin 域亦可（白名单内），此处仅登录用户端
const log = (ok, name, detail = "") => console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
const assert = (ok, name, detail = "") => { log(ok, name, detail); if (!ok) process.exit(1); };
const j = async (path, opts = {}) => {
  const r = await fetch(BASE + path, opts);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

async function siweLogin(account) {
  const n = await j("/auth/nonce");
  assert(n.status === 200 && n.body.nonce, "GET /auth/nonce", n.body.nonce);
  const message = [
    `${DOMAIN} wants you to sign in with your Ethereum account:`,
    account.address, "", "DramaX business E2E", "",
    `URI: https://${DOMAIN}`, "Version: 1", "Chain ID: 97",
    `Nonce: ${n.body.nonce}`, `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const signature = await account.signMessage({ message });
  const res = await j("/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: account.address, message, nonce: n.body.nonce, signature }),
  });
  assert(res.status === 200 && res.body.token, "SIWE login", `status=${res.status}`);
  return res.body.token;
}

// ── 买家钱包 ──
const buyer = privateKeyToAccount(generatePrivateKey());
console.log(`buyer: ${buyer.address}`);
const token = await siweLogin(buyer);
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

// 1. 场次列表
const sess = await j("/sessions");
assert(sess.status === 200 && (sess.body.sessions?.length ?? 0) >= 5, "GET /sessions", `count=${sess.body.sessions?.length}`);
const open = sess.body.sessions[0];

// 2. 预约负向：新钱包零余额 → 402 balance insufficient
//    注意：300–1,000 档 pending（TIERS 待确认）→ 正确报 400「该档位待确认」；
//    只挑 fee>0 的可用档位场次（如 sess-02：1000–5000 档 fee=75），amount 取档位中值。
const bookable = (sess.body.sessions ?? []).find((s) => Number(s.fee) > 0);
assert(!!bookable, "bookable session exists (fee>0)", bookable?.id);
const amt = Math.max(Number(bookable.tier_min) + 1, 2000);
const rsv = await j(`/sessions/${bookable.id}/reserve`, { method: "POST", headers: auth, body: JSON.stringify({ amount: String(amt) }) });
assert(rsv.status === 402 && rsv.body.error === "balance insufficient", "reserve w/o balance -> 402", JSON.stringify(rsv.body));
// 负向：未登录预约 → 401
const rsvAnon = await j(`/sessions/${bookable.id}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: String(amt) }) });
assert(rsvAnon.status === 401, "reserve without token -> 401", `status=${rsvAnon.status}`);
// 负向：pending 档位 → 400（300–1,000 档待确认）
const pendingSess = (sess.body.sessions ?? []).find((s) => Number(s.fee) === 0 && Number(s.tier_min) <= 1000);
if (pendingSess) {
  const rsvPend = await j(`/sessions/${pendingSess.id}/reserve`, { method: "POST", headers: auth, body: JSON.stringify({ amount: "300" }) });
  assert(rsvPend.status === 400 && rsvPend.body.error.includes("待确认"), "pending tier reserve -> 400", rsvPend.body.error);
}

// 3. 只读账户端点
for (const ep of ["/credits", "/credits/ledger", "/team/commissions", "/team/tree", "/ledger/drama"]) {
  const r = await j(ep, { headers: auth });
  assert(r.status === 200, `GET ${ep}`, `status=${r.status}`);
}

// 4. 撮合任一在售挂单（优先 demo-l2；上一轮可能锁定了它，15min 窗口内未回滚则换目标）
const listings = await j("/listings", { headers: auth });
const all = listings.body.listings ?? [];
const target = all.find((l) => l.id === "demo-l2") ?? all[0];
assert(!!target, "a LISTED seed listing present", target?.id ?? "-");

const m = await j(`/listings/${target.id}/match`, { method: "POST", headers: auth });
assert(m.status === 201 && m.body.matchId, `POST /listings/${target.id}/match`, `status=${m.status} price=${m.body.price}`);
console.log(`matchId: ${m.body.matchId} (15min broadcast window)`);

// 自撮合负向已被 UNIQUE seller 约束防住——改测不存在的挂单
const m404 = await j("/listings/no-such/match", { method: "POST", headers: auth });
assert(m404.status === 409, "match unknown listing -> 409", `status=${m404.status}`);

// 5. 撮合详情
const md = await j(`/matches/${m.body.matchId}`, { headers: auth });
assert(md.status === 200 && md.body.status === "PAYING", "GET /matches/:id PAYING", md.body.status);

// 6. P2P 支付意图（盐值绑定买家可见金额）
const it = await j("/payments/intent", {
  method: "POST", headers: auth,
  body: JSON.stringify({ orderType: "P2P", orderId: m.body.matchId, baseAmount: m.body.price }),
});
assert(it.status === 201 && it.body.payee && it.body.saltAmount, "POST /payments/intent", `payee=${it.body.payee} salt=${it.body.saltAmount} err=${it.body.error ?? "-"}`);

// 7. 意图状态查询
const st = await j(`/payments/${it.body.intentId}/status`, { headers: auth });
assert(st.status === 200 && st.body.status === "PENDING", "GET /payments/:id/status PENDING", JSON.stringify(st.body));

// 8. 撮合后挂单从转让市场消失
const after = await j("/listings", { headers: auth });
const stillThere = (after.body.listings ?? []).some((l) => l.id === target.id);
assert(!stillThere, "matched listing removed from market");

// 9. Admin 端点负向：无 token 401 / 未授权钱包 SIWE 403
const a401 = await j("/admin/dashboard");
assert(a401.status === 401, "GET /admin/dashboard no token -> 401", `status=${a401.status}`);
const an = await j("/admin/auth/nonce");
const amsg = [
  `${DOMAIN} wants you to sign in with your Ethereum account:`,
  buyer.address, "", "admin attempt", "",
  `URI: https://${DOMAIN}`, "Version: 1", "Chain ID: 97",
  `Nonce: ${an.body.nonce}`, `Issued At: ${new Date().toISOString()}`,
].join("\n");
const asig = await buyer.signMessage({ message: amsg });
const aLogin = await j("/admin/auth/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: amsg, nonce: an.body.nonce, signature: asig }),
});
assert(aLogin.status === 403, "admin SIWE unauthorized wallet -> 403", `status=${aLogin.status} err=${aLogin.body.error ?? "-"}`);

console.log("\n=== ALL BUSINESS E2E PASS ===");
console.log("note: demo-l2 将在 15 分钟 broadcast window 超时后由 cron 自动回滚为 LISTED（回滚修复已部署）");

// ═══ Admin 正向管理链路（凭据经 env 注入，不落 repo） ═══
const ADMIN_PASS = process.env.E2E_ADMIN_PASS;
if (ADMIN_PASS) {
  console.log("\n── Admin 管理链路 ──");
  // 1. 密码登录（负向：错密码 401）
  const badPw = await j("/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "e2e-admin", password: "wrong-pass" }) });
  assert(badPw.status === 401, "admin login wrong password -> 401", `status=${badPw.status}`);
  const aL = await j("/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "e2e-admin", password: ADMIN_PASS }) });
  assert(aL.status === 200 && aL.body.token && aL.body.role === "owner", "admin login (password bootstrap path)", `role=${aL.body.role}`);
  const aAuth = { authorization: `Bearer ${aL.body.token}`, "content-type": "application/json" };

  // 2. 看板 + 审计
  const dash = await j("/admin/dashboard", { headers: aAuth });
  assert(dash.status === 200 && !!dash.body.tiers, "GET /admin/dashboard", `status=${dash.status}`);

  // 3. 剧本：创建 → 提交 → 上架（负向：跳过 submit 直接 approve 应 409）
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const sc = await j("/admin/scripts", { method: "POST", headers: aAuth, body: JSON.stringify({ title: "E2E 测试剧本", price: 2000, synopsis: "auto", category: "urban", episodes: 80, copyright_hash: hex }) });
  assert(sc.status === 201 && sc.body.state === "DRAFT", "POST /admin/scripts -> DRAFT", sc.body.id);
  const early = await j(`/admin/scripts/${sc.body.id}/approve`, { method: "POST", headers: aAuth });
  assert(early.status === 409, "approve before submit -> 409", `status=${early.status}`);
  const sub = await j(`/admin/scripts/${sc.body.id}/submit`, { method: "POST", headers: aAuth });
  assert(sub.status === 200 && sub.body.state === "REVIEWING", "submit -> REVIEWING");
  const app = await j(`/admin/scripts/${sc.body.id}/approve`, { method: "POST", headers: aAuth });
  assert(app.status === 200 && app.body.state === "LISTED", "approve -> LISTED");

  // 3b. 负向：无版权哈希的剧本 approve 应 400
  const sc2 = await j("/admin/scripts", { method: "POST", headers: aAuth, body: JSON.stringify({ title: "E2E 无哈希剧本", price: 2000 }) });
  await j(`/admin/scripts/${sc2.body.id}/submit`, { method: "POST", headers: aAuth });
  const app2 = await j(`/admin/scripts/${sc2.body.id}/approve`, { method: "POST", headers: aAuth });
  assert(app2.status === 400 && String(app2.body.error).includes("copyright_hash"), "approve w/o copyright_hash -> 400", app2.body.error);

  // 4. 场次：NORMAL 区下一个 UTC 16:00，档位 2000–5000（fee 75）
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(16, 0, 0, 0);
  const ssn = await j("/admin/sessions", {
    method: "POST", headers: aAuth,
    body: JSON.stringify({ script_id: sc.body.id, zone: "NORMAL", start_at: d.toISOString(), tier_min: "2000", tier_max: "5000", capacity: 10 }),
  });
  assert(ssn.status === 201 && ssn.body.fee === "75.00", "POST /admin/sessions -> SCHEDULED", `fee=${ssn.body.fee}`);
  // 负向：时间规则（普通区非 16:00 应 400）
  const badT = new Date(d); badT.setUTCHours(10, 0, 0, 0);
  const ssnBad = await j("/admin/sessions", {
    method: "POST", headers: aAuth,
    body: JSON.stringify({ script_id: sc.body.id, zone: "NORMAL", start_at: badT.toISOString(), tier_min: "2000", tier_max: "5000", capacity: 10 }),
  });
  assert(ssnBad.status === 400, "session wrong hour -> 400", ssnBad.body.error);

  // 5. 用户端可见新场次（SCHEDULED 含在公开列表）
  const pub = await j("/sessions");
  assert((pub.body.sessions ?? []).some((s) => s.id === ssn.body.id), "new session visible on public /sessions");

  // 6. 审计日志有记录（兼容 {logs:[...]} 与旧 {logs:{results:[...]}} 两种返回）
  const logs = await j("/admin/audit-logs?limit=50", { headers: aAuth });
  const lgRows = Array.isArray(logs.body.logs) ? logs.body.logs : (logs.body.logs?.results ?? []);
  const kinds = lgRows.map((x) => x.action ?? "");
  assert(kinds.includes("script.create") && kinds.includes("session.create"), "audit-logs recorded", kinds.slice(0, 5).join(","));

  console.log("=== ADMIN CHAIN PASS ===");
} else {
  console.log("\n(skip admin chain: E2E_ADMIN_PASS not set)");
}
