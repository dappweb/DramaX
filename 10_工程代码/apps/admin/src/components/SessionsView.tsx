"use client";

import { useCallback, useEffect, useState } from "react";
import { adminApi, type ScriptRow } from "@/lib/api";

interface SessionRow {
  id: string;
  script_id: string;
  zone: string;
  start_at: string;
  tier_min: string;
  tier_max: string;
  fee: string;
  capacity: number;
  taken: number;
  status: string;
}

const TIERS = [
  { min: "300", max: "1000", fee: "待确认", pending: true },
  { min: "1000", max: "5000", fee: "75" },
  { min: "5000", max: "12000", fee: "240" },
  { min: "12000", max: "35000", fee: "450" },
];

export function SessionsView() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [scripts, setScripts] = useState<ScriptRow[]>([]);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [form, setForm] = useState({ script_id: "", zone: "NORMAL", start_at: "", tier: "1000-5000", capacity: "50" });

  const load = useCallback(async () => {
    try {
      const s = await adminApi<{ sessions: SessionRow[] }>("/sessions");
      setSessions(s.sessions);
    } catch { /* 静默 */ }
    try {
      const sc = await adminApi<{ scripts: { results: ScriptRow[] } }>("/admin/scripts?state=LISTED");
      setScripts(sc.scripts.results ?? []);
    } catch { /* 静默 */ }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setErr("");
    setMsg("");
    const [tier_min, tier_max] = form.tier.split("-");
    try {
      // start_at: datetime-local（本地时区）→ ISO；服务端 SESSION_RULES.validate 校验时间规则
      const startAtIso = form.start_at ? new Date(form.start_at).toISOString() : "";
      const r = await adminApi<{ id: string; fee: string }>("/admin/sessions", {
        method: "POST",
        body: { script_id: form.script_id, zone: form.zone, start_at: startAtIso, tier_min, tier_max, capacity: Number(form.capacity) },
      });
      setMsg(`场次已创建（手续费 ¥${r.fee}）`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "创建失败");
    }
  }

  const validTiers = TIERS.filter((t) => !t.pending);

  return (
    <>
      <div className="card">
        <div className="section-head">
          <h2>创建场次</h2>
          <span className="desc">普通区每日 16:00 · 创新区周二/四/六 15:00 &amp; 17:00（服务端校验）</span>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>剧本（仅已上架）</label>
            <select value={form.script_id} onChange={(e) => setForm({ ...form, script_id: e.target.value })}>
              <option value="">选择剧本…</option>
              {scripts.map((s) => (
                <option key={s.id} value={s.id}>{s.title}（¥{s.price}）</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>专区</label>
            <select value={form.zone} onChange={(e) => setForm({ ...form, zone: e.target.value })}>
              <option value="NORMAL">普通区（2% · 每日 16:00）</option>
              <option value="INNOVATION">创新区（3% · 周二四六 15:00 &amp; 17:00）</option>
            </select>
          </div>
          <div className="field"><label>开始时间</label><input type="datetime-local" value={form.start_at} onChange={(e) => setForm({ ...form, start_at: e.target.value })} /></div>
          <div className="field">
            <label>档位</label>
            <select value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value })}>
              {TIERS.map((t) => (
                <option key={`${t.min}-${t.max}`} disabled={t.pending} value={`${t.min}-${t.max}`}>
                  {t.min} - {t.max}{t.pending ? "（待确认）" : `（手续费 ¥${t.fee}）`}
                </option>
              ))}
            </select>
          </div>
          <div className="field"><label>容量</label><input className="num" inputMode="numeric" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value.replace(/[^\d]/g, "") })} /></div>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={create} disabled={!form.script_id || !form.start_at || !validTiers.some((t) => `${t.min}-${t.max}` === form.tier)}>
            创建场次
          </button>
          {msg && <span className="tag green" style={{ alignSelf: "center" }}>{msg}</span>}
          {err && <span className="tag red" style={{ alignSelf: "center" }}>{err}</span>}
        </div>
      </div>

      <div className="section-head"><h2>已排场次</h2></div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>专区</th><th className="num">档位</th><th className="num">手续费</th><th className="num">已约/容量</th><th>开始时间</th><th>状态</th></tr>
          </thead>
          <tbody>
            {sessions.length === 0 ? (
              <tr><td colSpan={6} style={{ color: "var(--muted)", textAlign: "center", padding: 30 }}>暂无场次</td></tr>
            ) : (
              sessions.map((s) => (
                <tr key={s.id}>
                  <td><span className="tag">{s.zone === "NORMAL" ? "普通区" : "创新区"}</span></td>
                  <td className="num">{s.tier_min} - {s.tier_max}</td>
                  <td className="num">¥{s.fee}</td>
                  <td className="num">{s.taken}/{s.capacity}</td>
                  <td className="num">{s.start_at}</td>
                  <td><span className={`tag ${s.status === "OPEN" ? "green" : "gray"}`}>{s.status}</span></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
