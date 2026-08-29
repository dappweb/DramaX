// 工具层：金额（整数分）、JWT（HMAC-SHA256，Web Crypto，Workers 原生）、SIWE 验签（viem）
// 金额一律「分」为单位内部运算，DB 存十进制字符串（TEXT），杜绝浮点误差。

import { recoverMessageAddress } from "viem";
import { parseSiweMessage } from "viem/siwe";

export function toCents(s: string | number): number {
  return Math.round(Number(s) * 100);
}

export function fmt(cents: number): string {
  return (cents / 100).toFixed(2);
}

// ─── SIWE（EIP-4361）：nonce 生成 + 验签（用户端与 Admin 端共用） ───
// 注意：viem SIWE 正则要求 nonce 仅字母数字（randomUUID 带连字符会解析失败），故用 hex。
export function siweNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b) => "0123456789abcdef"[b % 16]).join("");
}

export interface SiweVerifyResult {
  ok: boolean;
  error?: string;
  address?: string; // 验签通过的小写钱包地址
}

/** 校验 SIWE 登录请求：消息字段一致性（nonce/domain/address）+ 签名恢复地址比对（本地验证，无 RPC 依赖）。 */
export async function verifySiwe(opts: {
  allowedOrigin: string; // 逗号分隔多域（移动端 / Admin 端不同 Pages 项目）；空/非法 URL = 开发环境不锁域
  message: string;
  nonce: string;
  signature: string;
}): Promise<SiweVerifyResult> {
  const { allowedOrigin, message, nonce, signature } = opts;
  if (!message || !nonce || !signature) return { ok: false, error: "missing fields" };

  const domains = allowedOrigin
    .split(",")
    .map((s) => { try { return new URL(s.trim()).host; } catch { return null; } })
    .filter((h): h is string => !!h);

  const siwe = parseSiweMessage(message);
  if (siwe.nonce !== nonce) return { ok: false, error: "nonce mismatch in message" };
  if (!siwe.address) return { ok: false, error: "address missing in message" };
  if (domains.length > 0 && (!siwe.domain || !domains.includes(siwe.domain))) {
    return { ok: false, error: "domain mismatch" };
  }

  const addr = siwe.address.toLowerCase();
  const recovered = await recoverMessageAddress({ message, signature: signature as `0x${string}` });
  if (recovered.toLowerCase() !== addr) return { ok: false, error: "signature verification failed" };
  return { ok: true, address: addr };
}

// ─── JWT（HS256，零依赖） ───
const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export interface JwtPayload {
  sub: string;
  role: string; // user / admin
  exp: number;
}

export async function signJWT(payload: JwtPayload, secret: string, ttlSec: number): Promise<string> {
  const key = await hmacKey(secret);
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })));
  const sig = b64url(await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${body}`)));
  return `${header}.${body}.${sig}`;
}

export async function verifyJWT(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(parts[2]) as unknown as BufferSource, enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as JwtPayload;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── BSC JSON-RPC ───
export async function rpc<T = any>(rpcUrl: string, method: string, params: any[]): Promise<T> {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j: any = await r.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result as T;
}

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export function padAddr(addr: string): string {
  return "0x" + "0".repeat(24) + addr.toLowerCase().replace(/^0x/, "");
}

// USDT(BSC) 18 decimals → 分
export function hexToCents(hexData: string): number {
  return Number((BigInt(hexData) * 100n) / 10n ** 18n);
}
