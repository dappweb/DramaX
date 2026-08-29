"use client";

import { useCallback, useEffect, useState } from "react";
import { adminApi, ApiError, type ScriptRow } from "@/lib/api";

// 剧本四态：DRAFT →(submit) REVIEWING →(approve) LISTED →(remove) REMOVED
const STATE_META: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: "草稿", cls: "gray" },
  REVIEWING: { label: "审核中", cls: "amber" },
  LISTED: { label: "已上架", cls: "green" },
  REMOVED: { label: "已下架", cls: "gray" },
};

export function ScriptsView() {
  const [rows, setRows] = useState<ScriptRow[]>([]);
  const [stateFilter, setStateFilter] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: "", price: "", copyright_hash: "", synopsis: "", category: "", episodes: "" });

  const load = useCallback(async () => {
    try {
      const res = await adminApi<{ scripts: { results: ScriptRow[] } }>(`/admin/scripts${stateFilter ? `?state=${stateFilter}` : ""}`);
      setRows(res.scripts.results ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
    }
  }, [stateFilter]);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setErr("");
    setMsg("");
    try {
      await adminApi("/admin/scripts", {
        method: "POST",
        body: {
          title: form.title,
          price: form.price,
          copyright_hash: form.copyright_hash,
          synopsis: form.synopsis || undefined,
          category: form.category || undefined,
          episodes: form.episodes ? Number(form.episodes) : undefined,
        },
      });
      setMsg(`已创建草稿《${form.title}》`);
      setCreating(false);
      setForm({ title: "", price: "", copyright_hash: "", synopsis: "", category: "", episodes: "" });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "创建失败");
    }
  }

  async function transition(s: ScriptRow, action: "submit" | "approve" | "remove") {
    setErr("");
    setMsg("");
    try {
      const r = await adminApi<{ state: string }>(`/admin/scripts/${s.id}/${action}`, { method: "POST" });
      setMsg(`《${s.title}》→ ${STATE_META[r.state]?.label ?? r.state}`);
      await load();
    } catch (e) {
      if (e instanceof ApiError) {
        setErr(action === "approve" && e.status === 400
          ? `${e.message}（版权哈希需 64 位十六进制；定价须落在非待确认档位）`
          : e.message);
      } else {
        setErr("操作失败");
      }
    }
  }

  return (
    <>
      <div className="section-head">
        <select
          className="wallet-chip"
          style={{ cursor: "pointer" }}
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
        >
          <option value="">全部状态</option>
          <option value="DRAFT">草稿</option>
          <option value="REVIEWING">审核中</option>
          <option value="LISTED">已上架</option>
          <option value="REMOVED">已下架</option>
        </select>
        <button className="btn primary" onClick={() => setCreating(true)}>＋ 新建剧本</button>
        {msg && <span className="tag green">{msg}</span>}
        {err && <span className="tag red">{err}</span>}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>标题</th><th className="num">定价 (USDT)</th><th>版权哈希</th><th>状态</th><th>创建时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={6} style={{ color: "var(--muted)", textAlign: "center", padding: 30 }}>暂无剧本</td></tr>
            ) : (
              rows.map((s) => {
                const meta = STATE_META[s.state] ?? { label: s.state, cls: "gray" };
                return (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 700 }}>{s.title}</td>
                    <td className="num">{s.price}</td>
                    <td className="mono">{s.copyright_hash ? `${s.copyright_hash.slice(0, 10)}…${s.copyright_hash.slice(-6)}` : "—"}</td>
                    <td><span className={`tag ${meta.cls}`}>{meta.label}</span></td>
                    <td className="num">{s.created_at}</td>
                    <td>
                      {s.state === "DRAFT" && <button className="btn" onClick={() => transition(s, "submit")}>提交审核</button>}
                      {s.state === "REVIEWING" && <button className="btn primary" onClick={() => transition(s, "approve")}>审核上架</button>}
                      {s.state === "LISTED" && <button className="btn danger" onClick={() => transition(s, "remove")}>下架</button>}
                      {s.state === "REMOVED" && <span className="desc">—</span>}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {creating && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="section-head"><h2>新建剧本（DRAFT）</h2><span className="desc">版权哈希与档位校验在「审核上架」时执行</span></div>
          <div className="form-grid">
            <div className="field"><label>标题 *</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
            <div className="field"><label>定价 (USDT) *</label><input className="num" inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value.replace(/[^\d.]/g, "") })} /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label>版权哈希（sha256，64 位十六进制）*</label>
              <input className="mono" value={form.copyright_hash} onChange={(e) => setForm({ ...form, copyright_hash: e.target.value.trim() })} placeholder="0123…def" />
            </div>
            <div className="field"><label>分类</label><input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></div>
            <div className="field"><label>集数</label><input className="num" inputMode="numeric" value={form.episodes} onChange={(e) => setForm({ ...form, episodes: e.target.value.replace(/[^\d]/g, "") })} /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label>简介</label><textarea rows={2} value={form.synopsis} onChange={(e) => setForm({ ...form, synopsis: e.target.value })} /></div>
          </div>
          <div className="actions">
            <button className="btn primary" onClick={create} disabled={!form.title || !form.price || !form.copyright_hash}>创建</button>
            <button className="btn" onClick={() => setCreating(false)}>取消</button>
          </div>
        </div>
      )}
    </>
  );
}
