// Workers API 客户端：Bearer JWT + 统一错误（{ error, status, data }）

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";
const TOKEN_KEY = "dramax_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(message: string, status: number, data: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(String(data.error ?? res.statusText), res.status, data);
  return data as T;
}

// ─── 领域类型（与 workers-api 路由对齐） ───
export interface SessionRow {
  id: string;
  script_id: string;
  zone: "NORMAL" | "INNOVATION";
  start_at: string;
  tier_min: string;
  tier_max: string;
  fee: string;
  capacity: number;
  taken: number;
  status: string;
  script_title: string | null;
  cover_url: string | null;
  work_url: string | null;
}

export interface HoldingRow {
  id: string;
  zone: "NORMAL" | "INNOVATION";
  principal: string;
  state: string;
  created_at: string;
  bookValue: string;
  growth: string;
  occupancy: string;
  listPrice: string;
}

export interface ListingRow {
  id: string;
  list_price: string;
  status: string;
  created_at: string;
  title: string;
  cover_key: string | null;
  cover_url: string | null;
  work_url: string | null;
  zone: "NORMAL" | "INNOVATION";
  principal: string;
}

export interface PaymentIntent {
  intentId: string;
  payee: string;
  saltAmount: string;
  chainId: number;
  usdt: string;
  confirmations: number;
  expiresAt: string;
  memo: string;
}
