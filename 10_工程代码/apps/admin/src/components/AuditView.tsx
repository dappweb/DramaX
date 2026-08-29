"use client";

import { useCallback, useEffect, useState } from "react";
import { adminApi, type AuditRow } from "@/lib/api";

export function AuditView() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await adminApi<{ logs: { results: AuditRow[] } }>("/admin/audit-logs?limit=100");
      setRows(res.logs.results ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const fmt = (v: string | null) => {
    if (!v) return "—";
    try {
      const o = JSON.parse(v) as Record<string, unknown>;
      return JSON.stringify(o);
    } catch {
      return v;
    }
  };

  return (
    <>
      <div className="section-head">
        <h2>操作日志（audit_log）</h2>
        <button className="btn" onClick={load}>刷新</button>
      </div>
      {err && <div className="card err">{err}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th style={{ width: 150 }}>时间</th><th style={{ width: 150 }}>操作人</th><th style={{ width: 120 }}>动作</th><th>对象</th><th>变更前 → 变更后</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={5} style={{ color: "var(--muted)", textAlign: "center", padding: 30 }}>暂无记录</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id}>
                  <td className="num">{r.created_at}</td>
                  <td className="mono">{r.admin_id.slice(0, 8)}…</td>
                  <td><span className="tag">{r.action}</span></td>
                  <td className="mono">{r.entity}{r.entity_id ? `/${r.entity_id.slice(0, 8)}…` : ""}</td>
                  <td className="mono">{fmt(r.before)} → {fmt(r.after)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
