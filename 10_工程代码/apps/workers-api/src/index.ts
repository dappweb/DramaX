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
  const blocked = (c.env.BLOCKED_COUNTRIES ?? "CN").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const country = (c.req.raw.cf as { country?: string } | undefined)?.country?.toUpperCase();
  if (country && blocked.includes(country)) {
    return c.json({ error: "service unavailable in your region" }, 451);
  }
  await next();
});

app.use("*", (c, next) => {
  const origins = c.env.ALLOWED_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
  return cors({ origin: origins.length > 1 ? origins : origins[0] ?? "*" })(c, next);
});

app.get("/health", (c) => c.json({ ok: true, chain: rules.CHAIN.ID, tiers: rules.TIERS.length, ts: Date.now() }));

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
      `SELECT id FROM payment_intents WHERE salt_amount=? AND status='PENDING' AND expires_at > datetime('now')`
    ).bind(s.saltAmount.toFixed(2)).first();
    if (!clash) { salted = s; break; }
  }
  if (!salted) return c.json({ error: "salt collision, retry later" }, 503);

  const pool = (c.env.PLATFORM_ADDRESSES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!pool.length) return c.json({ error: "platform addresses not configured" }, 503);
  const payee = pool[Math.floor(Math.random() * pool.length)];
  intentId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + rules.PAYMENT.INTENT_TTL_MIN * 60 * 1000).toISOString();

  await kvPut(c.env.DB, `intent:${intentId}`, JSON.stringify({ orderId, orderType }), rules.PAYMENT.INTENT_TTL_MIN * 60);
  await c.env.DB.prepare(
    `INSERT INTO payment_intents (id, order_type, order_id, user_id, payee_addr, base_amount, salt_amount, expires_at) VALUES (?,?,?,?,?,?,?,?)`
  ).bind(intentId, orderType, orderId, user.sub, payee, baseAmount, salted.saltAmount.toFixed(2), expiresAt).run();

  return c.json({
    intentId, payee, saltAmount: salted.saltAmount.toFixed(2),
    chainId: rules.CHAIN.ID, usdt: rules.CHAIN.USDT,
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
  const zone = c.req.query("zone");
  const rows = zone
    ? await c.env.DB.prepare(`SELECT * FROM sessions WHERE zone=? AND status IN ('SCHEDULED','OPEN') ORDER BY start_at`).bind(zone).all()
    : await c.env.DB.prepare(`SELECT * FROM sessions WHERE status IN ('SCHEDULED','OPEN') ORDER BY start_at`).all();
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
  if (toCents(sess.fee) !== fee.fee) return c.json({ error: "fee mismatch" }, 400);

  const userRow = await c.env.DB.prepare(`SELECT drama_balance FROM users WHERE id=?`).bind(user.sub).first<{ drama_balance: string }>();
  if (!userRow) return c.json({ error: "user not found" }, 404);

  const balC = toCents(userRow.drama_balance);
  const totalC = amtC + (fee.fee ?? 0);
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
      .bind(user.sub, "RESERVE_FEE", fmt(-(fee.fee ?? 0)), after, "0", "reservation", reservationId),
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

// ─── 交易链路（卖出/挂单/撮合/积分/团队/账本） ───
app.route("/", trading);

// ─── Cron：Indexer 增量扫描 / 超时扫描 ───
export default {
  fetch: app.fetch,

  async scheduled(_evt: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const latestHex = await rpc<string>(env.BSC_RPC_URL, "eth_blockNumber", []);
      const latest = parseInt(latestHex, 16);
      let last = Number((await kvGet(env.DB, "scan:lastBlock")) ?? latest - rules.CHAIN.CONFIRMATIONS - 1);
      const from = last + 1;
      const to = Math.min(from + 499, latest - rules.CHAIN.CONFIRMATIONS); // 安全深度内增量
      if (from <= to) {
        const platform = (env.PLATFORM_ADDRESSES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (!platform.length) {
          // PLATFORM_ADDRESSES 未配置：跳过链上扫描，仅做超时/到期扫描（防止 getLogs 空 topics 匹配全量 USDT 转账）
          await env.DB.prepare(`UPDATE matches SET status='EXPIRED' WHERE status='PAYING' AND broadcast_deadline < datetime('now')`).run();
          await kvPut(env.DB, "scan:lastBlock", String(latest - rules.CHAIN.CONFIRMATIONS));
          return;
        }
        const logs: any[] = await rpc(env.BSC_RPC_URL, "eth_getLogs", [
          {
            address: rules.CHAIN.USDT,
            topics: [TRANSFER_TOPIC, null, platform.map(padAddr)],
            fromBlock: "0x" + from.toString(16),
            toBlock: "0x" + to.toString(16),
          },
        ]);
        for (const log of logs) {
          const cents = hexToCents(log.data);
          const saltAmount = (cents / 100).toFixed(2);
          // 盐值反查订单（方案 A）；无匹配则记录为孤儿事件（运营审查）
          const intent = await env.DB.prepare(
            `SELECT id FROM payment_intents WHERE salt_amount=? AND status='PENDING' AND expires_at > datetime('now')`
          ).bind(saltAmount).first<{ id: string }>();
          const ev: ChainEvent = {
            txHash: log.transactionHash, logIndex: log.logIndex,
            blockNo: parseInt(log.blockNumber, 16), blockHash: log.blockHash,
            from: log.topics[1].slice(-40).toLowerCase(), to: log.topics[2].slice(-40).toLowerCase(),
            cents, intentId: intent?.id ?? null,
          };
          // INSERT OR IGNORE = (tx_hash, log_index) 幂等
          await env.DB.prepare(
            `INSERT OR IGNORE INTO chain_events (tx_hash, log_index, block_no, block_hash, contract_addr, from_addr, to_addr, amount, status, intent_id) VALUES (?,?,?,?,?,?,?,?, 'PENDING', ?)`
          ).bind(ev.txHash, ev.logIndex, ev.blockNo, ev.blockHash, rules.CHAIN.USDT, ev.from, ev.to, (ev.cents / 100).toFixed(2), ev.intentId).run();
          await env.EVENTS.send(ev);
        }
        last = to;
      }
      await kvPut(env.DB, "scan:lastBlock", String(last));

      // 支付广播超时（15 分钟）：PAYING → EXPIRED（原 60min txid 模式已废除）
      await env.DB.prepare(`UPDATE matches SET status='EXPIRED' WHERE status='PAYING' AND broadcast_deadline < datetime('now')`).run();
      // 到期扫描：HOLDING 满 7 天 → MATURED
      await env.DB.prepare(
        `UPDATE holdings SET state='MATURED', matured_at=datetime('now') WHERE state='HOLDING' AND created_at <= datetime('now', '-7 days')`
      ).run();
    })());
  },

  // ─── 入账引擎：确认数 → reorg 校验 → D1 batch 原子入账 ───
  async queue(batch: MessageBatch<ChainEvent>, env: Env) {
    for (const msg of batch.messages) {
      const ev = msg.body;
      const row = await env.DB.prepare(`SELECT status FROM chain_events WHERE tx_hash=? AND log_index=?`).bind(ev.txHash, ev.logIndex).first<any>();
      if (!row || row.status === "CREDITED") { msg.ack(); continue; }

      const latest = parseInt(await rpc<string>(env.BSC_RPC_URL, "eth_blockNumber", []), 16);
      if (latest - ev.blockNo < rules.CHAIN.CONFIRMATIONS) { msg.retry({ delaySeconds: 30 }); continue; }

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
