// Admin 端 API 客户端：Bearer JWT（token 与用户端隔离存 localStorage）

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";
const TOKEN_KEY = "dramax_admin_token";

export function getAdminToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setAdminToken(token: string | null): void {
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

export async function adminApi<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getAdminToken();
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

// ─── 领域类型（与 workers-api /admin 路由对齐） ───
export interface ScriptRow {
  id: string;
  title: string;
  synopsis: string | null;
  category: string | null;
  episodes: number | null;
  price: string;
  copyright_hash: string | null;
  state: "DRAFT" | "REVIEWING" | "LISTED" | "REMOVED";
  created_by: string;
  created_at: string;
}

export interface AuditRow {
  id: number;
  admin_id: string;
  action: string;
  entity: string;
  entity_id: string | null;
  before: string | null;
  after: string | null;
  created_at: string;
}
