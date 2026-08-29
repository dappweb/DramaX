"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type HoldingRow, type PaymentIntent } from "@/lib/api";
import { PaymentSheet } from "./PaymentSheet";

const STATE_META: Record<string, { label: string; cls: string }> = {
  HOLDING: { label: "持有中", cls: "" },
  MATURED: { label: "可卖出", cls: "green" },
  READY_TO_LIST: { label: "待挂单", cls: "amber" },
  LISTED: { label: "已挂单", cls: "" },
  MATCHED: { label: "已撮合", cls: "amber" },
  SOLD: { label: "已售出", cls: "gray" },
  DAO_INSUFFICIENT: { label: "占用不足", cls: "red" },
};

export function HoldingsView() {
  const [rows, setRows] = useState<HoldingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [intent, setIntent] = useState<PaymentIntent | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ holdings: HoldingRow[] }>("/holdings");
      setRows(res.holdings);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 卖出意向：MATURED → 冻结占用（增长×85%）→ READY_TO_LIST；402 = 占用不足（缺口可补足）
  async function sellIntent(h: HoldingRow) {
    setMsg("");
    try {
      const r = await api<{ state: string; occupancy: string; listPrice: string }>(`/holdings/${h.id}/sell-intent`, { method: "POST" });
      setMsg(`占用已冻结 ¥${r.occupancy}，可挂单价 ¥${r.listPrice}`);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 402 && e.data.state === "DAO_INSUFFICIENT") {
        // 占用不足：补足缺口生成 DEPOSIT 意图
        try {
          const it = await api<PaymentIntent>(`/holdings/${h.id}/topup`, { method: "POST" });
          setIntent(it);
        } catch {
          setMsg(`占用不足：需 ¥${String(e.data.need)} / 可用 ¥${String(e.data.have)}，缺口 ¥${String(e.data.gap)}（请先充值）`);
        }
      } else {
        setMsg(e instanceof Error ? e.message : "操作失败");
      }
    }
  }

  async function list(h: HoldingRow) {
    setMsg("");
    try {
      const r = await api<{ listingId: string; listPrice: string }>(`/holdings/${h.id}/list`, { method: "POST" });
      setMsg(`已挂单，挂单价 ¥${r.listPrice}`);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "挂单失败");
    }
  }

  const total = rows.reduce((s, h) => s + Number(h.bookValue), 0);

  return (
    <>
      <div className="stat-hero">
        <div className="label">持仓总值（{rows.length} 笔）</div>
        <div className="value num">¥{total.toFixed(2)}</div>
      </div>

      {loading ? (
        <div className="center-tip">加载中…</div>
      ) : rows.length === 0 ? (
        <div className="card risk-note">暂无持仓。到首页参与场次即可建立持仓。</div>
      ) : (
        rows.map((h) => {
          const meta = STATE_META[h.state] ?? { label: h.state, cls: "gray" };
          return (
            <div className="card holding-card" key={h.id}>
              <div className="row1">
                <div className="title">
                  <span className="tag" style={{ marginRight: 6 }}>{h.zone === "NORMAL" ? "普通区" : "创新区"}</span>
                  本金 ¥{h.principal}
                </div>
                <span className={`tag ${meta.cls}`}>{meta.label}</span>
              </div>
              <div className="grid2 num">
                <div className="kv"><div className="k">当前账面</div><div className="v">¥{h.bookValue}</div></div>
                <div className="kv"><div className="k">累计增长</div><div className="v up">+¥{h.growth}</div></div>
                <div className="kv"><div className="k">卖出占用（85%）</div><div className="v">¥{h.occupancy}</div></div>
                <div className="kv"><div className="k">预计挂单价</div><div className="v">¥{h.listPrice}</div></div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                {h.state === "MATURED" && (
                  <button className="btn primary" style={{ flex: 1 }} onClick={() => sellIntent(h)}>卖出意向</button>
                )}
                {h.state === "READY_TO_LIST" && (
                  <button className="btn primary" style={{ flex: 1 }} onClick={() => list(h)}>按 ¥{h.listPrice} 挂单</button>
                )}
                {h.state === "DAO_INSUFFICIENT" && (
                  <button className="btn ghost" style={{ flex: 1 }} onClick={() => sellIntent(h)}>补足占用</button>
                )}
              </div>
            </div>
          );
        })
      )}
      {msg && <div className="card risk-note">{msg}</div>}
      <p className="risk-note">增长与占用数字为页面展示口径，实际结算以链上台账为准；卖出占用 = 累计增长 × 85%，挂单价 = 当前账面 × 1.03。</p>

      {intent && <PaymentSheet intent={intent} onClose={() => { setIntent(null); load(); }} />}
    </>
  );
}
