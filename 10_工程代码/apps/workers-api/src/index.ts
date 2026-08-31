// DramaX Workers API —— 核心实现
// 模块：认证（SIWE/JWT）、支付意图（金额盐）、抢购入账（D1 batch 原子）、
//       Indexer（BSC getLogs 增量扫描）、入账引擎（Queue consumer）、Admin（admin.ts）
// 规则只从 @dramax/shared 引用；金额以「分」内部运算、TEXT 十进制入库。

import { Hono } from "hono";
import { cors } from "hono/cors";
import * as rules from "@dramax/shared";
import { admin } from "./admin";
import { trading, settleMatch } from "./trading";
import { toCents, fmt, signJWT, verifyJWT, rpc, TRANSFER_TOPIC, padAddr, hexToCents, siweNonce, verifySiwe, verifyTurnstile, kvPut, kvGet, kvDel, kvSweep } from "./util";

export interface Env {
  DB: D1Database;
  INTENTS: KVNamespace;
  EVENTS: Queue;
  JWT_SECRET: string;
  BSC_RPC_URL: string;
  ADMIN_INITIAL_PASSWORD: string;
  ADMIN_OWNER_WALLET: string; // owner 钱包地址（SIWE 首登自举建档；小写比较）
  PLATFORM_ADDRESSES: string; // 逗号分隔的平台归集地址池
  ALLOWED_ORIGIN: string;
  TURNSTILE_SECRET: string;   // wrangler secret put TURNSTILE_SECRET（未配置=开发环境跳过校验）
  TURNSTILE_HOSTNAMES: string; // 逗号分隔前端域名白名单（m.dramax.ai,admin.dramax.ai）
  BLOCKED_COUNTRIES: string;  // 逗号分隔 ISO 国家码，区域屏蔽（默认 CN；合规：不面向中国大陆提供服务）
  CHAIN_ID?: string;          // 链覆盖（testnet=97）；缺省用 shared.CHAIN.ID(56)
  USDT_CONTRACT?: string;     // USDT 合约覆盖（testnet 0x3376…6C7）；缺省用 shared.CHAIN.USDT
  CHAIN_CONFIRMATIONS?: string; // 确认数覆盖；缺省 15
  INTERNAL_CRON_TOKEN?: string; // /internal/cron 触发令牌（wrangler secret put；未配置=端点 503 关闭）
  ENV?: string;               // 环境标记（[env.testnet.vars] ENV="testnet"；/internal/simulate-deposit 仅 testnet 开放）
}

// 链参数：环境变量覆盖 > shared 单一事实源（mainnet BSC 56 / testnet 97）
export function chainOf(env: Env) {
  return {
    id: Number(env.CHAIN_ID ?? rules.CHAIN.ID),
    usdt: (env.USDT_CONTRACT ?? rules.CHAIN.USDT).toLowerCase(),
    confirmations: Number(env.CHAIN_CONFIRMATIONS ?? rules.CHAIN.CONFIRMATIONS),
  };
}

export interface ChainEvent {
  txHash: string;
  logIndex: number;
  blockNo: number;
  blockHash: string;
  from: string;
  to: string;
  cents: number;
  intentId: string | null;
}

const app = new Hono<{ Bindings: Env }>();

// ─── 区域屏蔽（合规：不面向中国大陆提供服务）───
// 代码级拦截基于 request.cf.country（Cloudflare 边缘注入，不可伪造）；
// WAF 托管规则为账户级配置，两者叠加。451 = Unavailable For Legal Reasons。
app.use("*", async (c, next) => {
  // /internal/* 为服务器间触发端点（INTERNAL_CRON_TOKEN 鉴权），不受区域屏蔽限制（launchd 从本机 curl）
  if (!c.req.path.startsWith("/internal/")) {
    const blocked = (c.env.BLOCKED_COUNTRIES ?? "CN").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const country = (c.req.raw.cf as { country?: string } | undefined)?.country?.toUpperCase();
    if (country && blocked.includes(country)) {
      return c.json({ error: "service unavailable in your region" }, 451);
    }
  }
  await next();
});

app.use("*", (c, next) => {
  const origins = c.env.ALLOWED_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
  return cors({ origin: origins.length > 1 ? origins : origins[0] ?? "*" })(c, next);
});

app.get("/health", (c) => c.json({ ok: true, chain: chainOf(c.env).id, usdt: chainOf(c.env).usdt, tiers: rules.TIERS.length, ts: Date.now() }));

// ─── 鉴权中间件（用户） ───
async function requireUser(c: any): Promise<{ sub: string } | null> {
  const token = (c.req.header("authorization") ?? "").replace(/^Bearer /, "");
  const p = token ? await verifyJWT(token, c.env.JWT_SECRET) : null;
  return p && p.role === "user" ? p : null;
}

// ─── 认证：SIWE 钱包签名登录 ───
app.get("/auth/nonce", async (c) => {
  const nonce = siweNonce();
  await kvPut(c.env.DB, `nonce:${nonce}`, "1", 300);
  await kvSweep(c.env.DB);
  return c.json({ nonce });
});

app.post("/auth/login", async (c) => {
  const { address, message, nonce, signature, turnstileToken } = await c.req.json<{
    address: string; message: string; nonce: string; signature: string; turnstileToken?: string;
  }>();
  // Turnstile 人机校验（action=user_login，先于 nonce 消耗，防脚本刷 nonce）
  const ts = await verifyTurnstile({
    secret: c.env.TURNSTILE_SECRET, token: turnstileToken,
    expectedAction: "user_login", hostnames: c.env.TURNSTILE_HOSTNAMES,
    remoteip: c.req.header("cf-connecting-ip"),
  });
  if (!ts.ok) return c.json({ error: ts.error }, 403);
  if (!message || !nonce || !signature) return c.json({ error: "missing fields" }, 400);
  if (!(await kvGet(c.env.DB, `nonce:${nonce}`))) return c.json({ error: "nonce expired" }, 401);
  const v = await verifySiwe({ allowedOrigin: c.env.ALLOWED_ORIGIN, message, nonce, signature });
  if (!v.ok) return c.json({ error: v.error }, 401);
  if (address && address.toLowerCase() !== v.address) return c.json({ error: "address mismatch" }, 401);

  // 单次有效：验签通过即焚毁 nonce（防重放）
  await kvDel(c.env.DB, `nonce:${nonce}`);
  const addr = v.address!;
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO users (id, wallet) VALUES (?, ?) ON CONFLICT(wallet) DO NOTHING`
  ).bind(id, addr).run();
  const user = await c.env.DB.prepare(`SELECT id FROM users WHERE wallet=?`).bind(addr).first<{ id: string }>();
  const token = await signJWT({ sub: user!.id, role: "user", exp: 0 }, c.env.JWT_SECRET, 7200);
  return c.json({ token, userId: user!.id });
});

app.post("/auth/refresh", async (c) => {
  const p = await requireUser(c);
  if (!p) return c.json({ error: "unauthorized" }, 401);
  return c.json({ token: await signJWT({ sub: p.sub, role: "user", exp: 0 }, c.env.JWT_SECRET, 7200) });
});

// ─── 支付意图（金额盐绑定，P0 方案 A） ───
app.post("/payments/intent", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const { orderType, orderId, baseAmount } = await c.req.json<{ orderType: "DEPOSIT" | "P2P"; orderId: string; baseAmount: string }>();

  // 盐 = orderId 哈希分位；冲突时重试（同订单 5 分钟失效重生成）
  let salted: { cents: number; saltAmount: number } | null = null;
  let intentId = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const s = rules.PAYMENT.saltFor(Number(baseAmount), attempt === 0 ? orderId : `${orderId}#${attempt}`);
    const clash = await c.env.DB.prepare(
      `SELECT id FROM payment_intents WHERE salt_amount=? AND status='PENDING' AND expires_at > ?`
    ).bind(s.saltAmount.toFixed(2), new Date().toISOString()).first();
    if (!clash) { salted = s; break; }
  }
  if (!salted) return c.json({ error: "salt collision, retry later" }, 503);

  const pool = (c.env.PLATFORM_ADDRESSES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!pool.length) return c.json({ error: "platform addresses not configured" }, 503);
  let payee = pool[Math.floor(Math.random() * pool.length)];
  // P2P：复用撮合时锁定的收款地址（match 与 intent 的盐值同由 saltFor(orderId) 纯函数保证一致）
  if (orderType === "P2P") {
    const mm = await c.env.DB.prepare(`SELECT payee_addr FROM matches WHERE id=?`).bind(orderId).first<{ payee_addr: string }>();
    if (mm?.payee_addr) payee = mm.payee_addr;
  }
  intentId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + rules.PAYMENT.INTENT_TTL_MIN * 60 * 1000).toISOString();

  await kvPut(c.env.DB, `intent:${intentId}`, JSON.stringify({ orderId, orderType }), rules.PAYMENT.INTENT_TTL_MIN * 60);
  await c.env.DB.prepare(
    `INSERT INTO payment_intents (id, order_type, order_id, user_id, payee_addr, base_amount, salt_amount, expires_at) VALUES (?,?,?,?,?,?,?,?)`
  ).bind(intentId, orderType, orderId, user.sub, payee, baseAmount, salted.saltAmount.toFixed(2), expiresAt).run();

  return c.json({
    intentId, payee, saltAmount: salted.saltAmount.toFixed(2),
    chainId: chainOf(c.env).id, usdt: chainOf(c.env).usdt,
    confirmations: rules.CHAIN.CONFIRMATIONS, expiresAt,
    memo: `金额含系统识别码 0.${String(salted.cents).padStart(2, "0")}`,
  }, 201);
});

app.get("/payments/:id/status", async (c) => {
  const row = await c.env.DB.prepare(`SELECT status, salt_amount, expires_at FROM payment_intents WHERE id=?`).bind(c.req.param("id")).first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

// ─── 场次与抢购 ───
app.get("/sessions", async (c) => {
  // JOIN scripts 带出标题/封面/作品地址，供前端卡片展示封面缩略图与跳转
  const SEL = `SELECT se.*, s.title AS script_title, s.cover_url, s.work_url FROM sessions se JOIN scripts s ON s.id=se.script_id`;
  const zone = c.req.query("zone");
  const rows = zone
    ? await c.env.DB.prepare(`${SEL} WHERE se.zone=? AND se.status IN ('SCHEDULED','OPEN') ORDER BY se.start_at`).bind(zone).all()
    : await c.env.DB.prepare(`${SEL} WHERE se.status IN ('SCHEDULED','OPEN') ORDER BY se.start_at`).all();
  return c.json({ sessions: rows.results, tiers: rules.TIERS });
});

app.post("/sessions/:id/reserve", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const { amount } = await c.req.json<{ amount: string }>();
  const sid = c.req.param("id");

  const sess = await c.env.DB.prepare(`SELECT * FROM sessions WHERE id=?`).bind(sid).first<any>();
  if (!sess || !["SCHEDULED", "OPEN"].includes(sess.status)) return c.json({ error: "session unavailable" }, 409);
  if (sess.taken >= sess.capacity) return c.json({ error: "session full" }, 409);

  const amtC = toCents(amount);
  const fee = rules.feeFor(amtC / 100);
  if (!fee || fee.pending) return c.json({ error: "该档位待确认，暂不可预约" }, 400);
  // 修复(2026-08-30)：feeFor 返回元（如 75），DB fee 列也存元字符串（'75'）——
  // 原代码 toCents(sess.fee)=7500 分与 fee.fee=75 元直接比较，永远 fee mismatch；totalC 又把元当分扣。统一转分。
  const feeC = toCents(String(fee.fee)); // 档位手续费（分）
  if (toCents(sess.fee) !== feeC) return c.json({ error: "fee mismatch" }, 400);

  const userRow = await c.env.DB.prepare(`SELECT drama_balance FROM users WHERE id=?`).bind(user.sub).first<{ drama_balance: string }>();
  if (!userRow) return c.json({ error: "user not found" }, 404);

  const balC = toCents(userRow.drama_balance);
  const totalC = amtC + feeC;
  if (balC < totalC) return c.json({ error: "balance insufficient", need: fmt(totalC), have: userRow.drama_balance }, 402);

  const now = fmt(balC - amtC);          // 扣本金后
  const after = fmt(balC - totalC);      // 再扣手续费后
  const reservationId = crypto.randomUUID();
  const holdingId = crypto.randomUUID();
  const zone = sess.zone as "NORMAL" | "INNOVATION";

  // D1 batch = 原子：余额 CAS + 容量守卫 + 预约 + 持仓 + 两行账本（本金/手续费）
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET drama_balance=? WHERE id=? AND drama_balance=?`).bind(after, user.sub, userRow.drama_balance),
    c.env.DB.prepare(`UPDATE sessions SET taken=taken+1 WHERE id=? AND taken<capacity`).bind(sid),
    c.env.DB.prepare(`INSERT INTO reservations (id, user_id, session_id, amount, fee, status) VALUES (?,?,?,?,?,'CONFIRMED')`)
      .bind(reservationId, user.sub, sid, amount, sess.fee),
    c.env.DB.prepare(`INSERT INTO holdings (id, user_id, script_id, zone, principal, state) VALUES (?,?,?,?,?,'HOLDING')`)
      .bind(holdingId, user.sub, sess.script_id, zone, amount),
    c.env.DB.prepare(`INSERT INTO drama_ledger (user_id, type, amount, balance_after, frozen_after, ref_type, ref_id) VALUES (?,?,?,?,?,?,?)`)
      .bind(user.sub, "RESERVE_PRINCIPAL", fmt(-amtC), now, "0", "holding", holdingId),
    c.env.DB.prepare(`INSERT INTO drama_ledger (user_id, type, amount, balance_after, frozen_after, ref_type, ref_id) VALUES (?,?,?,?,?,?,?)`)
      .bind(user.sub, "RESERVE_FEE", fmt(-feeC), after, "0", "reservation", reservationId),
  ]);

  return c.json({ holdingId, reservationId, bookValue: fmt(rules.GROWTH.bookValue(amtC / 100, zone, 0)), zone }, 201);
});

// ─── 持仓 / 挂单 / 撮合 / 积分 / 团队 / 账本（实现沿用骨架 TODO，下一迭代） ───
app.get("/holdings", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const rows = await c.env.DB.prepare(`SELECT * FROM holdings WHERE user_id=? ORDER BY created_at DESC`).bind(user.sub).all();
  const enriched = (rows.results as any[]).map((h) => {
    const days = Math.min(rules.GROWTH.HOLD_DAYS, h.state === "HOLDING" ? Math.floor((Date.now() - Date.parse(h.created_at)) / 86400000) : rules.GROWTH.HOLD_DAYS);
    const book = rules.GROWTH.bookValue(Number(h.principal), h.zone, days);
    const growth = rules.GROWTH.growthOf(Number(h.principal), h.zone, days);
    return { ...h, bookValue: fmt(book), growth: fmt(growth), occupancy: fmt(rules.SELL.occupancyOf(growth)), listPrice: fmt(rules.SELL.listPriceOf(book)) };
  });
  return c.json({ holdings: enriched });
});

// ─── Admin 挂载（必须在 trading 之前：trading 的 use("*") 会拦截后续挂载的所有路径） ───
app.route("/admin", admin);

// ─── 内部触发端点：launchd curl 定时跑 indexer（替代被配额拒的 Workers Cron） ───
// 鉴权：x-internal-token 头 = INTERNAL_CRON_TOKEN secret；未配置 token 时端点 503 关闭
// 必须在 trading 挂载之前注册（同 admin 的 use("*") 拦截问题）
app.post("/internal/cron", async (c) => {
  const expect = c.env.INTERNAL_CRON_TOKEN;
  if (!expect) return c.json({ error: "internal cron disabled" }, 503);
  if ((c.req.header("x-internal-token") ?? "") !== expect) return c.json({ error: "unauthorized" }, 401);
  await runCronOnce(c.env);
  return c.json({ ok: true, ts: Math.floor(Date.now() / 1000) });
});

// ─── 内部模拟入账（仅 testnet）：把既有 PENDING 意图直接推进入账引擎 ───
// 用途：无测试币 gas 时 E2E 验证 Queue consumer 全链路（确认数/reorg 校验/D1 原子入账）。
// 真实链上转账段（getLogs 扫描匹配）由 deposit-e2e.mjs 在 gas 就绪后覆盖。
// 鉴权同 /internal/cron；生产（ENV!=testnet）直接 404 关闭。
app.post("/internal/simulate-deposit", async (c) => {
  if (c.env.ENV !== "testnet") return c.json({ error: "not found" }, 404);
  const expect = c.env.INTERNAL_CRON_TOKEN;
  if (!expect) return c.json({ error: "internal endpoints disabled" }, 503);
  if ((c.req.header("x-internal-token") ?? "") !== expect) return c.json({ error: "unauthorized" }, 401);
  const { intentId } = await c.req.json<{ intentId: string }>();
  if (!intentId) return c.json({ error: "missing intentId" }, 400);
  const intent = await c.env.DB.prepare(
    `SELECT id, user_id, salt_amount FROM payment_intents WHERE id=? AND status='PENDING' AND order_type='DEPOSIT'`
  ).bind(intentId).first<any>();
  if (!intent) return c.json({ error: "intent not found or not PENDING" }, 404);

  const latest = parseInt(await rpc<string>(c.env.BSC_RPC_URL, "eth_blockNumber", []), 16);
  const blockNo = latest - chainOf(c.env).confirmations - 1; // 满足确认数 + 不含 reorg 窗口
  const block = await rpc<any>(c.env.BSC_RPC_URL, "eth_getBlockByNumber", ["0x" + blockNo.toString(16), false]);
  if (!block?.hash) return c.json({ error: "block fetch failed" }, 502);

  const txHash = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const cents = toCents(intent.salt_amount);
  const platform = (c.env.PLATFORM_ADDRESSES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const ev: ChainEvent = {
    txHash, logIndex: 0, blockNo, blockHash: block.hash,
    from: "0x" + "ab".repeat(20), // 模拟付款方（非平台地址，不影响入账逻辑）
    to: platform[0] ?? "0x" + "cd".repeat(20),
    cents, intentId: intent.id,
  };
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO chain_events (tx_hash, log_index, block_no, block_hash, contract_addr, from_addr, to_addr, amount, status, intent_id) VALUES (?,?,?,?,?,?,?,?, 'PENDING', ?)`
  ).bind(ev.txHash, ev.logIndex, ev.blockNo, ev.blockHash, chainOf(c.env).usdt, ev.from, ev.to, (cents / 100).toFixed(2), ev.intentId).run();
  await c.env.EVENTS.send(ev);
  return c.json({ ok: true, queued: true, txHash, blockNo, cents: (cents / 100).toFixed(2) }, 202);
});

// ─── 交易链路（卖出/挂单/撮合/积分/团队/账本） ───
app.route("/", trading);

// ─── Cron：Indexer 增量扫描 / 超时扫描 ───
// cron 逻辑抽为独立函数：scheduled（Workers Cron）与 POST /internal/cron（launchd curl 触发）共用

// 支付广播超时（15 分钟）：PAYING → EXPIRED。
// 修复(2026-08-30)：①原先只置 matches，listings/holdings 会永久卡在 MATCHED，现先回滚挂单/持仓再置 EXPIRED；
// ②broadcast_deadline 存 ISO 格式（"…T…Z"），与 datetime('now')（"… …"）字符串比较时 'T'>' ' 恒为假、
// 超时从未生效 —— 统一改绑 ISO 参数比较。
async function expireStaleMatches(env: Env): Promise<void> {
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE listings SET status='LISTED', buyer_id=NULL WHERE status='MATCHED' AND id IN
     (SELECT listing_id FROM matches WHERE status='PAYING' AND broadcast_deadline < ?)`
  ).bind(nowIso).run();
  await env.DB.prepare(
    `UPDATE holdings SET state='LISTED', state_version=state_version+1 WHERE state='MATCHED' AND id IN
     (SELECT l.holding_id FROM listings l JOIN matches m ON m.listing_id=l.id
      WHERE m.status='PAYING' AND m.broadcast_deadline < ?)`
  ).bind(nowIso).run();
  await env.DB.prepare(`UPDATE matches SET status='EXPIRED' WHERE status='PAYING' AND broadcast_deadline < ?`).bind(nowIso).run();
}

async function runCronOnce(env: Env): Promise<void> {
  // 超时回滚放在最前：链上 RPC 故障（getLogs 抛错）不应阻塞撮合超时释放
  await expireStaleMatches(env);
  const latestHex = await rpc<string>(env.BSC_RPC_URL, "eth_blockNumber", []);
  const latest = parseInt(latestHex, 16);
  let last = Number((await kvGet(env.DB, "scan:lastBlock")) ?? latest - chainOf(env).confirmations - 1);
  const from = last + 1;
  const to = Math.min(from + 499, latest - chainOf(env).confirmations); // 安全深度内增量
  if (from <= to) {
    const platform = (env.PLATFORM_ADDRESSES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!platform.length) {
      // PLATFORM_ADDRESSES 未配置：跳过链上扫描，仅做超时/到期扫描（防止 getLogs 空 topics 匹配全量 USDT 转账）
      await expireStaleMatches(env);
      await kvPut(env.DB, "scan:lastBlock", String(latest - chainOf(env).confirmations));
      return;
    }
    const logs: any[] = await rpc(env.BSC_RPC_URL, "eth_getLogs", [
      {
        address: chainOf(env).usdt,
        topics: [TRANSFER_TOPIC, null, platform.map(padAddr)],
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + to.toString(16),
      },
    ]);
    for (const log of logs) {
      const cents = hexToCents(log.data);
      const saltAmount = (cents / 100).toFixed(2);
      // 盐值反查订单（方案 A）；无匹配则记录为孤儿事件（运营审查）
      // expires_at 为 ISO 格式，与 datetime('now') 字符串比较恒真 —— 绑 ISO 参数（修复 2026-08-30）
      const intent = await env.DB.prepare(
        `SELECT id FROM payment_intents WHERE salt_amount=? AND status='PENDING' AND expires_at > ?`
      ).bind(saltAmount, new Date().toISOString()).first<{ id: string }>();
      const ev: ChainEvent = {
        txHash: log.transactionHash, logIndex: log.logIndex,
        blockNo: parseInt(log.blockNumber, 16), blockHash: log.blockHash,
        from: log.topics[1].slice(-40).toLowerCase(), to: log.topics[2].slice(-40).toLowerCase(),
        cents, intentId: intent?.id ?? null,
      };
      // INSERT OR IGNORE = (tx_hash, log_index) 幂等
      await env.DB.prepare(
        `INSERT OR IGNORE INTO chain_events (tx_hash, log_index, block_no, block_hash, contract_addr, from_addr, to_addr, amount, status, intent_id) VALUES (?,?,?,?,?,?,?,?, 'PENDING', ?)`
      ).bind(ev.txHash, ev.logIndex, ev.blockNo, ev.blockHash, chainOf(env).usdt, ev.from, ev.to, (ev.cents / 100).toFixed(2), ev.intentId).run();
      await env.EVENTS.send(ev);
    }
    last = to;
  }
  await kvPut(env.DB, "scan:lastBlock", String(last));
  // 到期扫描：HOLDING 满 7 天 → MATURED
  await env.DB.prepare(
    `UPDATE holdings SET state='MATURED', matured_at=datetime('now') WHERE state='HOLDING' AND created_at <= datetime('now', '-7 days')`
  ).run();
}

export default {
  fetch: app.fetch,

  async scheduled(_evt: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCronOnce(env));
  },

  // ─── 入账引擎：确认数 → reorg 校验 → D1 batch 原子入账 ───
  async queue(batch: MessageBatch<ChainEvent>, env: Env) {
    for (const msg of batch.messages) {
      const ev = msg.body;
      const row = await env.DB.prepare(`SELECT status FROM chain_events WHERE tx_hash=? AND log_index=?`).bind(ev.txHash, ev.logIndex).first<any>();
      if (!row || row.status === "CREDITED") { msg.ack(); continue; }

      const latest = parseInt(await rpc<string>(env.BSC_RPC_URL, "eth_blockNumber", []), 16);
      if (latest - ev.blockNo < chainOf(env).confirmations) { msg.retry({ delaySeconds: 30 }); continue; }

      // reorg：块哈希不匹配 → 回滚未入账事件
      const block = await rpc<any>(env.BSC_RPC_URL, "eth_getBlockByNumber", ["0x" + ev.blockNo.toString(16), false]);
      if (block && block.hash !== ev.blockHash) {
        await env.DB.prepare(`UPDATE chain_events SET status='ROLLED_BACK' WHERE tx_hash=? AND log_index=?`).bind(ev.txHash, ev.logIndex).run();
        msg.ack(); continue; // TODO: 告警通知
      }

      if (!ev.intentId) { await env.DB.prepare(`UPDATE chain_events SET status='CONFIRMED' WHERE tx_hash=? AND log_index=?`).bind(ev.txHash, ev.logIndex).run(); msg.ack(); continue; }

      const intent = await env.DB.prepare(`SELECT * FROM payment_intents WHERE id=? AND status='PENDING'`).bind(ev.intentId).first<any>();
      if (!intent) { msg.ack(); continue; }

      const creditC = Math.min(ev.cents, toCents(intent.salt_amount));
      if (creditC <= 0) { msg.ack(); continue; } // UNDERPAID → 运营处理（超额处理为待拍板项）

      // P2P 撮合支付 → 撮合结算（占用消耗 / 瀑布 70-15-15 / 返佣记账）
      if (intent.order_type === "P2P") {
        const ok = await settleMatch(env, ev, intent);
        if (ok) await env.DB.prepare(`UPDATE payment_intents SET status='CREDITED' WHERE id=?`).bind(intent.id).run();
        msg.ack();
        continue;
      }

      const user = await env.DB.prepare(`SELECT drama_balance FROM users WHERE id=?`).bind(intent.user_id).first<{ drama_balance: string }>();
      if (!user) { msg.ack(); continue; }
      const newBal = fmt(toCents(user.drama_balance) + creditC);

      // D1 batch 原子：事件 CREDITED + 意图 CREDITED + 入金记录 + 账本 + 余额 CAS
      await env.DB.batch([
        env.DB.prepare(`UPDATE chain_events SET status='CREDITED' WHERE tx_hash=? AND log_index=?`).bind(ev.txHash, ev.logIndex),
        env.DB.prepare(`UPDATE payment_intents SET status='CREDITED' WHERE id=?`).bind(intent.id),
        env.DB.prepare(`INSERT INTO deposits (id, user_id, payment_intent_id, tx_hash, chain, amount, confirmations, status, credited_at) VALUES (?,?,?,?,?,?,'15','CREDITED',datetime('now'))`)
          .bind(crypto.randomUUID(), intent.user_id, intent.id, ev.txHash, "BSC", fmt(creditC)),
        env.DB.prepare(`INSERT INTO drama_ledger (user_id, type, amount, balance_after, frozen_after, ref_type, ref_id) VALUES (?,?,?,?,?,?,?)`)
          .bind(intent.user_id, "DEPOSIT", fmt(creditC), newBal, "0", "deposit", ev.txHash),
        env.DB.prepare(`UPDATE users SET drama_balance=? WHERE id=? AND drama_balance=?`).bind(newBal, intent.user_id, user.drama_balance),
      ]);
      msg.ack();
    }
  },
};
