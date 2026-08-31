// 交易链路：卖出占用冻结 / 挂单 / 撮合结算 / 积分 / 团队 / 账本
// 状态机：MATURED →(校验占用)→ READY_TO_LIST → LISTED → MATCHED → SOLD（分支 DAO_INSUFFICIENT）

import { Hono } from "hono";
import * as rules from "@dramax/shared";
import { toCents, fmt } from "./util";
import type { Env, ChainEvent } from "./index";

export const trading = new Hono<{ Bindings: Env }>();

type Vars = { userId: string };
const route = trading as unknown as Hono<{ Bindings: Env; Variables: Vars }>;

route.use("*", async (c, next) => {
  const token = (c.req.header("authorization") ?? "").replace(/^Bearer /, "");
  const { verifyJWT } = await import("./util");
  const p = token ? await verifyJWT(token, c.env.JWT_SECRET) : null;
  if (!p || p.role !== "user") return c.json({ error: "unauthorized" }, 401);
  (c as any).set("userId", p.sub);
  await next();
});

const USER_ERR = (c: any) => c.json({ error: "unauthorized" }, 401);

// ─── 卖出申请：MATURED → 校验占用（增长×85%）→ 冻结 → READY_TO_LIST ───
route.post("/holdings/:id/sell-intent", async (c) => {
  const userId = (c as any).get("userId") as string;
  if (!userId) return USER_ERR(c);
  const hid = c.req.param("id");

  const h = await c.env.DB.prepare(`SELECT * FROM holdings WHERE id=? AND user_id=?`).bind(hid, userId).first<any>();
  if (!h) return c.json({ error: "not found" }, 404);
  if (h.state !== "MATURED" && h.state !== "DAO_INSUFFICIENT") return c.json({ error: `illegal state ${h.state}, expect MATURED` }, 409);

  const book = rules.GROWTH.bookValue(Number(h.principal), h.zone, rules.GROWTH.HOLD_DAYS);
  const growth = rules.GROWTH.growthOf(Number(h.principal), h.zone, rules.GROWTH.HOLD_DAYS);
  const occupancy = toCents(rules.SELL.occupancyOf(growth));

  const u = await c.env.DB.prepare(`SELECT drama_balance, drama_frozen FROM users WHERE id=?`).bind(userId).first<any>();
  const balC = toCents(u.drama_balance);

  if (balC < occupancy) {
    // 分支：DAO_INSUFFICIENT（需占用 / 可用 / 缺口）
    const gap = occupancy - balC;
    if (h.state !== "DAO_INSUFFICIENT") {
      await c.env.DB.prepare(`UPDATE holdings SET state='DAO_INSUFFICIENT', state_version=state_version+1 WHERE id=? AND state_version=?`).bind(hid, h.state_version).run();
    }
    return c.json({ state: "DAO_INSUFFICIENT", need: fmt(occupancy), have: u.drama_balance, gap: fmt(gap) }, 402);
  }

  const newBal = fmt(balC - occupancy);
  const newFrozen = fmt(toCents(u.drama_frozen) + occupancy);

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET drama_balance=?, drama_frozen=? WHERE id=? AND drama_balance=?`).bind(newBal, newFrozen, userId, u.drama_balance),
    c.env.DB.prepare(`UPDATE holdings SET state='READY_TO_LIST', state_version=state_version+1 WHERE id=? AND state_version=?`).bind(hid, h.state_version),
    c.env.DB.prepare(`INSERT INTO drama_ledger (user_id, type, amount, balance_after, frozen_after, ref_type, ref_id) VALUES (?,?,?,?,?,?,?)`)
      .bind(userId, "FREEZE_OCCUPANCY", fmt(-occupancy), newBal, newFrozen, "holding", hid),
  ]);
  return c.json({ state: "READY_TO_LIST", occupancy: fmt(occupancy), listPrice: fmt(rules.SELL.listPriceOf(book)) }, 200);
});

// ─── 补足缺口：为 DAO_INSUFFICIENT 持仓生成 DEPOSIT 支付意图（DApp 直付） ───
route.post("/holdings/:id/topup", async (c) => {
  const userId = (c as any).get("userId") as string;
  if (!userId) return USER_ERR(c);
  const h = await c.env.DB.prepare(`SELECT * FROM holdings WHERE id=? AND user_id=? AND state='DAO_INSUFFICIENT'`).bind(c.req.param("id"), userId).first<any>();
  if (!h) return c.json({ error: "not found or not in DAO_INSUFFICIENT" }, 404);

  const growth = rules.GROWTH.growthOf(Number(h.principal), h.zone, rules.GROWTH.HOLD_DAYS);
  const occupancy = rules.SELL.occupancyOf(growth);
  const u = await c.env.DB.prepare(`SELECT drama_balance FROM users WHERE id=?`).bind(userId).first<any>();
  const gap = Math.max(0, Math.round((occupancy - Number(u.drama_balance)) * 100) / 100);
  if (gap <= 0) return c.json({ error: "no gap, retry sell-intent" }, 409);

  // 复用支付意图创建（orderId=持仓id，金额=缺口）
  const res = await fetch(new URL(`/payments/intent`, c.req.url).toString(), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: c.req.header("authorization") ?? "" },
    body: JSON.stringify({ orderType: "DEPOSIT", orderId: h.id, baseAmount: gap.toFixed(2) }),
  });
  return c.json(await res.json(), res.status as 201);
});

// ─── 挂单 ───
route.get("/listings", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT l.id, l.list_price, l.status, l.created_at, s.title, s.cover_key, h.zone, h.principal
     FROM listings l JOIN holdings h ON h.id=l.holding_id JOIN scripts s ON s.id=h.script_id
     WHERE l.status='LISTED' ORDER BY l.created_at DESC LIMIT 100`
  ).all();
  return c.json({ listings: rows.results, premium: rules.SELL.LIST_PREMIUM });
});

// 挂单：READY_TO_LIST → LISTED（挂单价 = 账面价 × 1.03，由 shared 计算）
route.post("/holdings/:id/list", async (c) => {
  const userId = (c as any).get("userId") as string;
  if (!userId) return USER_ERR(c);
  const h = await c.env.DB.prepare(`SELECT * FROM holdings WHERE id=? AND user_id=? AND state='READY_TO_LIST'`).bind(c.req.param("id"), userId).first<any>();
  if (!h) return c.json({ error: "not found or not READY_TO_LIST" }, 404);

  const book = rules.GROWTH.bookValue(Number(h.principal), h.zone, rules.GROWTH.HOLD_DAYS);
  const price = fmt(rules.SELL.listPriceOf(book));
  const listingId = crypto.randomUUID();

  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO listings (id, holding_id, seller_id, list_price, status) VALUES (?,?,?,?, 'LISTED')`)
      .bind(listingId, h.id, userId, price),
    c.env.DB.prepare(`UPDATE holdings SET state='LISTED', state_version=state_version+1 WHERE id=? AND state='READY_TO_LIST'`).bind(h.id),
  ]);
  return c.json({ listingId, listPrice: price }, 201);
});

// 撤单：解冻占用，LISTED → READY_TO_LIST
route.delete("/listings/:id", async (c) => {
  const userId = (c as any).get("userId") as string;
  if (!userId) return USER_ERR(c);
  const l = await c.env.DB.prepare(`SELECT l.*, h.id AS hid, h.zone, h.principal FROM listings l JOIN holdings h ON h.id=l.holding_id WHERE l.id=? AND l.seller_id=? AND l.status='LISTED'`).bind(c.req.param("id"), userId).first<any>();
  if (!l) return c.json({ error: "not found or not LISTED" }, 404);

  const growth = rules.GROWTH.growthOf(Number(l.principal), l.zone, rules.GROWTH.HOLD_DAYS);
  const occupancy = toCents(rules.SELL.occupancyOf(growth));
  const u = await c.env.DB.prepare(`SELECT drama_balance, drama_frozen FROM users WHERE id=?`).bind(userId).first<any>();

  const newBal = fmt(toCents(u.drama_balance) + occupancy);
  const newFrozen = fmt(toCents(u.drama_frozen) - occupancy);

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE listings SET status='CANCELLED' WHERE id=? AND status='LISTED'`).bind(l.id),
    c.env.DB.prepare(`UPDATE holdings SET state='READY_TO_LIST', state_version=state_version+1 WHERE id=?`).bind(l.hid),
    c.env.DB.prepare(`UPDATE users SET drama_balance=?, drama_frozen=? WHERE id=? AND drama_frozen=?`).bind(newBal, newFrozen, userId, u.drama_frozen),
    c.env.DB.prepare(`INSERT INTO drama_ledger (user_id, type, amount, balance_after, frozen_after, ref_type, ref_id) VALUES (?,?,?,?,?,?,?)`)
      .bind(userId, "UNFREEZE_OCCUPANCY", fmt(occupancy), newBal, newFrozen, "listing", l.id),
  ]);
  return c.json({ ok: true, unfrozen: fmt(occupancy) });
});

// ─── 撮合：买家支付 → 创建 P2P 意图（15 分钟广播窗口，Indexer 自动核验） ───
route.post("/listings/:id/match", async (c) => {
  const userId = (c as any).get("userId") as string;
  if (!userId) return USER_ERR(c);
  const l = await c.env.DB.prepare(`SELECT * FROM listings WHERE id=? AND status='LISTED'`).bind(c.req.param("id")).first<any>();
  if (!l) return c.json({ error: "not found or not LISTED" }, 409);
  if (l.seller_id === userId) return c.json({ error: "cannot match own listing" }, 400);

  // 修复(2026-08-30)：matches.payee_addr/salt_amount 为 NOT NULL，原 INSERT 漏列必 500。
  // 撮合时预生成收款地址与盐值（saltFor 纯函数，payments/intent 对同一 matchId 复用同盐）。
  const pool = (c.env.PLATFORM_ADDRESSES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!pool.length) return c.json({ error: "platform addresses not configured" }, 503);
  const matchId = crypto.randomUUID();
  const payee = pool[Math.floor(Math.random() * pool.length)];
  const salted = rules.PAYMENT.saltFor(Number(l.list_price), matchId);
  const deadline = new Date(Date.now() + rules.PAYMENT.BROADCAST_WINDOW_MIN * 60 * 1000).toISOString();

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE listings SET status='MATCHED', buyer_id=? WHERE id=? AND status='LISTED'`).bind(userId, l.id),
    c.env.DB.prepare(`UPDATE holdings SET state='MATCHED', state_version=state_version+1 WHERE id=? AND state='LISTED'`).bind(l.holding_id),
    c.env.DB.prepare(`INSERT INTO matches (id, listing_id, seller_id, buyer_id, price, payee_addr, salt_amount, broadcast_deadline, status) VALUES (?,?,?,?,?,?,?,?, 'PAYING')`)
      .bind(matchId, l.id, l.seller_id, userId, l.list_price, payee, salted.saltAmount.toFixed(2), deadline),
  ]);
  return c.json({ matchId, price: l.list_price, payee, saltAmount: salted.saltAmount.toFixed(2), broadcastWindowMin: rules.PAYMENT.BROADCAST_WINDOW_MIN, deadline }, 201);
});

route.get("/matches/:id", async (c) => {
  const m = await c.env.DB.prepare(`SELECT id, status, price, broadcast_deadline FROM matches WHERE id=?`).bind(c.req.param("id")).first();
  if (!m) return c.json({ error: "not found" }, 404);
  return c.json(m);
});

// ─── 撮合结算：P2P 支付意图 CREDITED 后由入账引擎调用（index.ts consumer） ───
export async function settleMatch(env: Env, ev: ChainEvent, intent: any): Promise<boolean> {
  const m = await env.DB.prepare(`SELECT * FROM matches WHERE id=? AND status='PAYING'`).bind(intent.order_id).first<any>();
  if (!m) return false;
  const l = await env.DB.prepare(`SELECT * FROM listings WHERE id=?`).bind(m.listing_id).first<any>();
  const h = await env.DB.prepare(`SELECT * FROM holdings WHERE id=?`).bind(l.holding_id).first<any>();
  if (!l || !h) return false;

  const growth = rules.GROWTH.growthOf(Number(h.principal), h.zone, rules.GROWTH.HOLD_DAYS);
  const split = rules.SETTLE.split(growth); // 70 手续费 / 15 现金 / 15 积分
  const occupancy = toCents(rules.SELL.occupancyOf(growth));
  const s = await env.DB.prepare(`SELECT drama_balance, drama_frozen, credit_balance FROM users WHERE id=?`).bind(m.seller_id).first<any>();
  if (!s) return false;

  // 卖家占用消耗（frozen 扣减，不退余额）+ 积分 1:1 入账（来源A）
  const newFrozen = fmt(toCents(s.drama_frozen) - occupancy);
  const newCredit = fmt(toCents(s.credit_balance) + toCents(split.credit));
  const feeCents = toCents(split.fee);

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE matches SET status='SOLD', buyer_txid=? WHERE id=? AND status='PAYING'`).bind(ev.txHash, m.id),
    env.DB.prepare(`UPDATE listings SET status='SOLD' WHERE id=?`).bind(l.id),
    env.DB.prepare(`UPDATE holdings SET state='SOLD', state_version=state_version+1 WHERE id=?`).bind(h.id),
    env.DB.prepare(`UPDATE users SET drama_frozen=?, credit_balance=? WHERE id=? AND drama_frozen=?`).bind(newFrozen, newCredit, m.seller_id, s.drama_frozen),
    env.DB.prepare(`INSERT INTO drama_ledger (user_id, type, amount, balance_after, frozen_after, ref_type, ref_id) VALUES (?,?,?,?,?,?,?)`)
      .bind(m.seller_id, "OCCUPANCY_BURNED", fmt(-occupancy), s.drama_balance, newFrozen, "match", m.id),
    env.DB.prepare(`INSERT INTO credit_ledger (user_id, source, amount, balance_after, ref_type, ref_id) VALUES (?,?,?,?,?,?)`)
      .bind(m.seller_id, "A_TRADE", fmt(split.credit), newCredit, "match", m.id),
  ];

  // 返佣：从手续费池按卖家邀请链 1-3 代 7% / 4-10 代 2% 记账（提现另行审批）
  const path = await env.DB.prepare(`SELECT path FROM referral_relations WHERE user_id=?`).bind(m.seller_id).first<any>();
  if (path?.path) {
    const chain = String(path.path).split("/").filter(Boolean).reverse(); // 最近祖先在前
    for (let depth = 1; depth <= Math.min(10, chain.length); depth++) {
      const cm = rules.COMMISSION.of(feeCents / 100, depth);
      if (cm.amount <= 0) continue;
      stmts.push(
        env.DB.prepare(`INSERT INTO commission_records (order_id, beneficiary_id, depth, rate, amount) VALUES (?,?,?,?,?)`)
          .bind(m.id, chain[depth - 1], depth, String(cm.rate), fmt(cm.amount))
      );
    }
  }
  // TODO(待拍板): 持仓转移语义（买家新 HOLDING / 重置周期）+ 超额支付处理
  await env.DB.batch(stmts);
  return true;
}

// ─── 积分 / 团队 / 账本（只读） ───
route.get("/credits", async (c) => {
  const userId = (c as any).get("userId") as string;
  if (!userId) return USER_ERR(c);
  const u = await c.env.DB.prepare(`SELECT credit_balance FROM users WHERE id=?`).bind(userId).first<any>();
  return c.json({ credit_balance: u?.credit_balance ?? "0", rate: rules.ASSETS.CREDIT_RATE, note: "1 Drama = 1 积分，不可兑回 Drama/USDT" });
});

route.get("/credits/ledger", async (c) => {
  const userId = (c as any).get("userId") as string;
  if (!userId) return USER_ERR(c);
  // 修复(2026-08-31)：.all() 返回 D1Result 包装，直接 c.json 会把 {results:[…]} 塞给前端（同 audit-logs bug⑥）
  const rows = await c.env.DB.prepare(`SELECT * FROM credit_ledger WHERE user_id=? ORDER BY id DESC LIMIT 100`).bind(userId).all();
  return c.json({ ledger: rows.results });
});

route.get("/team/commissions", async (c) => {
  const userId = (c as any).get("userId") as string;
  if (!userId) return USER_ERR(c);
  const rows = await c.env.DB.prepare(`SELECT depth, rate, SUM(amount) AS total, COUNT(*) AS cnt FROM commission_records WHERE beneficiary_id=? GROUP BY depth, rate ORDER BY depth`).bind(userId).all();
  return c.json({ commissions: rows.results, rates: { "1-3": 0.07, "4-10": 0.02 } });
});

route.get("/team/tree", async (c) => {
  const userId = (c as any).get("userId") as string;
  if (!userId) return USER_ERR(c);
  const depth = Math.min(Number(c.req.query("depth") ?? 10), 10);
  const me = await c.env.DB.prepare(`SELECT path FROM referral_relations WHERE user_id=?`).bind(userId).first<any>();
  if (!me?.path) return c.json({ tree: [] });
  const rows = await c.env.DB.prepare(`SELECT user_id, depth FROM referral_relations WHERE path LIKE ? AND depth <= ? ORDER BY depth`).bind(`${me.path}/%`, depth).all();
  return c.json({ tree: rows.results });
});

route.get("/ledger/drama", async (c) => {
  const userId = (c as any).get("userId") as string;
  if (!userId) return USER_ERR(c);
  // 修复(2026-08-31)：.all() 返回 D1Result 包装（同 audit-logs bug⑥）
  const rows = await c.env.DB.prepare(`SELECT * FROM drama_ledger WHERE user_id=? ORDER BY id DESC LIMIT 100`).bind(userId).all();
  return c.json({ ledger: rows.results });
});
