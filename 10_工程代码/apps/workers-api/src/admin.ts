// Admin：钱包登录（SIWE，主路径）+ 密码登录（bcrypt，后备）+ 剧本状态机（DRAFT→REVIEWING→LISTED→REMOVED）+ audit_log 留痕
// 规则引用 @dramax/shared，禁止硬编码口径。

import { Hono } from "hono";
import bcrypt from "bcryptjs";
import type { Env } from "./index";
import { signJWT, toCents, fmt, siweNonce, verifySiwe, verifyTurnstile, kvPut, kvGet, kvDel } from "./util";
import { tierFor, TIERS } from "@dramax/shared";

export const admin = new Hono<{ Bindings: Env }>();

type Vars = { adminId: string; account: string };
const route = admin as unknown as Hono<{ Bindings: Env; Variables: Vars }>;

// ─── 审计工具：who/when/what/before→after 四要素，任何写操作必须调用 ───
async function audit(c: { env: Env }, adminId: string, action: string, entity: string, entityId: string | null, before: unknown, after: unknown) {
  await c.env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, entity, entity_id, before, after) VALUES (?,?,?,?,?,?)`
  )
    .bind(adminId, action, entity, entityId, JSON.stringify(before) ?? null, JSON.stringify(after) ?? null)
    .run();
}

// ─── 钱包登录（主路径）：SIWE 验签 → admins.wallet 匹配 → owner 首登自举建档 ───
// 路由必须注册在下方鉴权中间件之前（Hono 按注册顺序匹配）
route.get("/auth/nonce", async (c) => {
  const nonce = siweNonce();
  await kvPut(c.env.DB, `admin-nonce:${nonce}`, "1", 300);
  return c.json({ nonce });
});

route.post("/auth/login", async (c) => {
  const { message, nonce, signature, turnstileToken } = await c.req.json<{
    message: string; nonce: string; signature: string; turnstileToken?: string;
  }>();
  // Turnstile 人机校验（action=admin_login，先于 nonce 消耗）
  const ts = await verifyTurnstile({
    secret: c.env.TURNSTILE_SECRET, token: turnstileToken,
    expectedAction: "admin_login", hostnames: c.env.TURNSTILE_HOSTNAMES,
    remoteip: c.req.header("cf-connecting-ip"),
  });
  if (!ts.ok) return c.json({ error: ts.error }, 403);
  if (!message || !nonce || !signature) return c.json({ error: "missing fields" }, 400);
  if (!(await kvGet(c.env.DB, `admin-nonce:${nonce}`))) return c.json({ error: "nonce expired" }, 401);

  const v = await verifySiwe({ allowedOrigin: c.env.ALLOWED_ORIGIN, message, nonce, signature });
  if (!v.ok) return c.json({ error: v.error }, 401);
  // 单次有效：验签通过即焚毁 nonce（防重放）
  await kvDel(c.env.DB, `admin-nonce:${nonce}`);
  const wallet = v.address!;

  let row = await c.env.DB.prepare(`SELECT id, account, role, failed_attempts, locked_until FROM admins WHERE wallet=?`).bind(wallet).first<any>();
  if (!row) {
    // owner 自举：ENV 配置的 owner 钱包首次登录 → 建档（account=钱包地址，role=owner）
    const ownerWallet = (c.env.ADMIN_OWNER_WALLET ?? "").toLowerCase();
    if (ownerWallet && wallet === ownerWallet) {
      const id = crypto.randomUUID();
      await c.env.DB.prepare(
        `INSERT INTO admins (id, account, wallet, role) VALUES (?,?,?,'owner') ON CONFLICT(wallet) DO NOTHING`
      ).bind(id, wallet, wallet).run();
      row = { id, account: wallet, role: "owner" };
    } else {
      return c.json({ error: "wallet not authorized for admin" }, 403);
    }
  }
  if (row.locked_until && new Date(row.locked_until) > new Date()) return c.json({ error: "locked, try later" }, 423);

  await audit(c, row.id, "login.wallet", "admin", row.id, null, { account: row.account, wallet });
  const token = await signJWT({ sub: row.id, role: "admin", exp: 0 }, c.env.JWT_SECRET, 7200);
  return c.json({ token, role: row.role });
});

// ─── 密码登录（后备）：bcrypt 哈希校验；Turnstile + TOTP 后续接入；5 次失败锁 15min ───
route.post("/login", async (c) => {
  const { account, password } = await c.req.json<{ account: string; password: string }>();
  const row = await c.env.DB.prepare(`SELECT id, account, password_hash, role, failed_attempts, locked_until FROM admins WHERE account=?`).bind(account).first<any>();
  if (!row) return c.json({ error: "invalid credentials" }, 401);
  if (row.locked_until && new Date(row.locked_until) > new Date()) return c.json({ error: "locked, try later" }, 423);

  // 正式路径：bcrypt.compare(password, password_hash)
  // 引导路径：password_hash 为空时允许 ADMIN_INITIAL_PASSWORD 首登，成功后自愈固化为哈希（此后仅走哈希校验）
  const usingBootstrap = !row.password_hash;
  const ok = usingBootstrap
    ? password === c.env.ADMIN_INITIAL_PASSWORD
    : await bcrypt.compare(password, row.password_hash);
  if (!ok) {
    const fails = (row.failed_attempts ?? 0) + 1;
    const lock = fails >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
    await c.env.DB.prepare(`UPDATE admins SET failed_attempts=?, locked_until=? WHERE id=?`).bind(fails, lock, row.id).run();
    return c.json({ error: "invalid credentials" }, 401);
  }
  if (usingBootstrap) {
    await c.env.DB.prepare(`UPDATE admins SET password_hash=? WHERE id=?`).bind(
      await bcrypt.hash(c.env.ADMIN_INITIAL_PASSWORD, 10), row.id
    ).run();
  }
  await c.env.DB.prepare(`UPDATE admins SET failed_attempts=0, locked_until=NULL WHERE id=?`).bind(row.id).run();
  await audit(c, row.id, "login", "admin", row.id, null, { account: row.account });
  const token = await signJWT({ sub: row.id, role: "admin", exp: 0 }, c.env.JWT_SECRET, 7200);
  return c.json({ token, role: row.role });
});

// ─── 鉴权中间件 ───
route.use("*", async (c, next) => {
  const token = (c.req.header("authorization") ?? "").replace(/^Bearer /, "");
  const payload = token ? await verifyAdmin(token, c.env.JWT_SECRET) : null;
  if (!payload) return c.json({ error: "unauthorized" }, 401);
  (c as any).set("adminId", payload.sub);
  await next();
});

async function verifyAdmin(token: string, secret: string) {
  const { verifyJWT } = await import("./util");
  const p = await verifyJWT(token, secret);
  return p?.role === "admin" ? p : null;
}

// ─── 剧本：新建（DRAFT） ───
route.post("/scripts", async (c) => {
  const adminId = (c as any).get("adminId") as string;
  const body = await c.req.json<Record<string, any>>();
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO scripts (id, title, synopsis, category, episodes, price, copyright_hash, state, created_by) VALUES (?,?,?,?,?,?,?,?,?)`
  )
    .bind(id, body.title, body.synopsis ?? null, body.category ?? null, body.episodes ?? null, String(body.price), body.copyright_hash ?? null, "DRAFT", adminId)
    .run();
  await audit(c, adminId, "script.create", "script", id, null, { title: body.title, price: body.price });
  return c.json({ id, state: "DRAFT" }, 201);
});

// ─── 剧本列表（四态筛选） ───
route.get("/scripts", async (c) => {
  const state = c.req.query("state");
  const q = state
    ? c.env.DB.prepare(`SELECT * FROM scripts WHERE state=? ORDER BY created_at DESC`).bind(state)
    : c.env.DB.prepare(`SELECT * FROM scripts ORDER BY created_at DESC`);
  return c.json({ scripts: await q.all() });
});

// ─── 状态流转：统一守卫（状态不符 409）+ 审计 ───
async function transition(c: any, id: string, from: string[], to: string, action: string, extraValidate?: (s: any) => Promise<string | null>) {
  const adminId = (c as any).get("adminId") as string;
  const row = await c.env.DB.prepare(`SELECT * FROM scripts WHERE id=?`).bind(id).first();
  if (!row) return c.json({ error: "not found" }, 404);
  if (!from.includes(row.state)) return c.json({ error: `illegal transition from ${row.state}`, expect: from }, 409);

  if (extraValidate) {
    const err = await extraValidate(row);
    if (err) return c.json({ error: err }, 400);
  }
  await c.env.DB.prepare(`UPDATE scripts SET state=?, updated_at=datetime('now') WHERE id=?`).bind(to, id).run();
  await audit(c, adminId, `script.${action}`, "script", id, { state: row.state }, { state: to });
  return c.json({ id, state: to });
}

route.post("/scripts/:id/submit", (c) => transition(c, c.req.param("id"), ["DRAFT"], "REVIEWING", "submit"));

route.post("/scripts/:id/approve", (c) =>
  transition(
    c,
    c.req.param("id"),
    ["REVIEWING"],
    "LISTED",
    "approve",
    async (s) => {
      // 上架校验：版权哈希 64 位十六进制必填 + 定价落在非待确认档位区间
      if (!/^[0-9a-fA-F]{64}$/.test(s.copyright_hash ?? "")) return "copyright_hash 必须为 64 位十六进制";
      const t = tierFor(Number(s.price));
      if (!t || (t as any).pending) return `定价 ${s.price} 未落在有效档位区间`;
      return null;
    }
  )
);

route.post("/scripts/:id/remove", (c) => transition(c, c.req.param("id"), ["LISTED"], "REMOVED", "remove"));

// ─── 场次创建（时间规则由 shared.SESSION_RULES 校验；仅可选已上架剧本） ───
route.post("/sessions", async (c) => {
  const adminId = (c as any).get("adminId") as string;
  const b = await c.req.json<{ script_id: string; zone: string; start_at: string; tier_min: string; tier_max: string; capacity: number }>();
  const { SESSION_RULES, feeFor } = await import("@dramax/shared");

  const script = await c.env.DB.prepare(`SELECT state FROM scripts WHERE id=?`).bind(b.script_id).first<any>();
  if (!script || script.state !== "LISTED") return c.json({ error: "仅已上架剧本可创建场次" }, 400);

  const timeErr = SESSION_RULES.validate(b.zone, b.start_at);
  if (timeErr) return c.json({ error: timeErr }, 400);

  const fee = feeFor(Number(b.tier_min));
  if (!fee || fee.pending) return c.json({ error: "该档位待确认，不可创建" }, 400);

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO sessions (id, script_id, zone, start_at, tier_min, tier_max, fee, capacity, status) VALUES (?,?,?,?,?,?,?,?, 'SCHEDULED')`
  )
    .bind(id, b.script_id, b.zone, b.start_at, b.tier_min, b.tier_max, fmt(fee.fee!), b.capacity)
    .run();
  await audit(c, adminId, "session.create", "session", id, null, { script_id: b.script_id, zone: b.zone, start_at: b.start_at, fee: fmt(fee.fee!) });
  return c.json({ id, fee: fmt(fee.fee!) }, 201);
});

// ─── 看板（三生死线） ───
route.get("/dashboard", async (c) => {
  // TODO: 聚合 D1 实时指标；先返回规则常量与占位
  const { ECONOMICS } = await import("@dramax/shared");
  return c.json({ economics: ECONOMICS, tiers: TIERS });
});

route.get("/audit-logs", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  return c.json({ logs: await c.env.DB.prepare(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?`).bind(limit).all() });
});
