"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type PaymentIntent, type SessionRow } from "@/lib/api";
import { PaymentSheet } from "./PaymentSheet";

// 档位与手续费口径展示（参照 shared.TIERS；300-1,000 待拍板）
const TIERS = [
  { label: "300 - 1,000", fee: "待确认", pending: true },
  { label: "1,000 - 5,000", fee: "75" },
  { label: "5,000 - 12,000", fee: "240" },
  { label: "12,000 - 35,000", fee: "450" },
];

export function HomeView() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState("1000");
  const [active, setActive] = useState<SessionRow | null>(null);
  const [msg, setMsg] = useState("");
  const [intent, setIntent] = useState<PaymentIntent | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ sessions: SessionRow[] }>("/sessions");
      setSessions(res.sessions);
    } catch {
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function reserve() {
    if (!active) return;
    setMsg("");
    try {
      await api(`/sessions/${active.id}/reserve`, { method: "POST", body: { amount } });
      setMsg("预约成功，持仓已建立");
      setActive(null);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 402) {
        // 余额不足 → 引导充值（DEPOSIT 意图）
        try {
          const it = await api<PaymentIntent>("/payments/intent", {
            method: "POST",
            body: { orderType: "DEPOSIT", orderId: crypto.randomUUID(), baseAmount: String(e.data.need ?? amount) },
          });
          setIntent(it);
        } catch {
          setMsg(`余额不足（需 ${String(e.data.need ?? "")}），请先到「我的」充值`);
        }
      } else {
        setMsg(e instanceof Error ? e.message : "预约失败");
      }
    }
  }

  const zoneTag = (z: string) => (z === "NORMAL" ? "普通区" : "创新区");

  return (
    <>
      <div className="stat-hero">
        <div className="label">场次以平台日程公示为准 · BSC 链上结算</div>
        <div className="value num">普通区每日 16:00</div>
        <div className="label" style={{ marginTop: 4 }}>创新区 周二/四/六 15:00 &amp; 17:00</div>
      </div>

      <div className="section-title">今日场次</div>
      {loading ? (
        <div className="center-tip">加载中…</div>
      ) : sessions.length === 0 ? (
        <div className="card risk-note">暂无开放场次。预约成功后按所选档位支付即锁定名额。</div>
      ) : (
        sessions.map((s) => (
          <div className="card sess" key={s.id}>
            <div>
              <div className="sess-name">
                <span className="tag" style={{ marginRight: 6 }}>{zoneTag(s.zone)}</span>
                档位 {s.tier_min} - {s.tier_max}
              </div>
              <div className="sess-meta num">
                手续费 ¥{s.fee} · {s.taken}/{s.capacity} 已约 · {s.start_at}
              </div>
            </div>
            <button className="btn primary" disabled={s.taken >= s.capacity} onClick={() => setActive(s)}>
              {s.taken >= s.capacity ? "已满" : "抢购"}
            </button>
          </div>
        ))
      )}

      {msg && <div className="card risk-note">{msg}</div>}

      {active && (
        <div className="sheet-mask" onClick={() => setActive(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>确认预约</h3>
            <div className="pay-row"><span className="k">档位区间</span><span className="num">{active.tier_min} - {active.tier_max}</span></div>
            <div className="pay-row"><span className="k">预约金额</span>
              <input
                className="num" style={{ width: 110, textAlign: "right", border: "none", fontWeight: 700, fontSize: 15 }}
                value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal"
              />
            </div>
            <div className="pay-row"><span className="k">手续费</span><span className="num">¥{active.fee}</span></div>
            <p className="risk-note" style={{ margin: "10px 0" }}>
              支付成功即锁定名额并生成持仓；增长以平台规则按自然日计算，详见《用户玩法指南》。
            </p>
            <button className="btn primary block" onClick={reserve}>确认预约</button>
          </div>
        </div>
      )}

      <div className="section-title">档位与手续费</div>
      <div className="card">
        {TIERS.map((t) => (
          <div className="pay-row" key={t.label}>
            <span className="k num">{t.label}</span>
            <span className="num">{t.pending ? <em className="tag amber">待确认</em> : `¥${t.fee}`}</span>
          </div>
        ))}
      </div>

      {intent && <PaymentSheet intent={intent} onClose={() => { setIntent(null); load(); }} />}
    </>
  );
}
