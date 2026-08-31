"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type ListingRow, type PaymentIntent } from "@/lib/api";
import { PaymentSheet } from "./PaymentSheet";
import { ScriptCover, WorkLink } from "./ScriptCover";

export function MarketView() {
  const [listings, setListings] = useState<ListingRow[]>([]);
  const [premium, setPremium] = useState("1.03");
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [intent, setIntent] = useState<PaymentIntent | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ listings: ListingRow[]; premium: number }>("/listings");
      setListings(res.listings);
      setPremium(String(res.premium ?? "1.03"));
    } catch {
      setListings([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 撮合：锁单 → 生成 P2P 支付意图（15 分钟广播窗口）→ PaymentSheet 链上直付
  async function match(id: string) {
    setMsg("");
    try {
      const m = await api<{ matchId: string; price: string; broadcastWindowMin: number }>(`/listings/${id}/match`, { method: "POST" });
      const it = await api<PaymentIntent>("/payments/intent", {
        method: "POST",
        body: { orderType: "P2P", orderId: m.matchId, baseAmount: m.price },
      });
      setIntent(it);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "撮合失败");
    }
  }

  return (
    <>
      <div className="section-title">转让市场 <span className="tag">挂单价 = 账面价 × {premium}</span></div>
      {loading ? (
        <div className="center-tip">加载中…</div>
      ) : listings.length === 0 ? (
        <div className="card risk-note">暂无在售转让。卖家挂单后会展示在此。</div>
      ) : (
        listings.map((l) => (
          <div className="card listing" key={l.id}>
            <ScriptCover coverUrl={l.cover_url} title={l.title} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="sess-name">{l.title || "剧本权益"}</div>
              <div className="sess-meta num">
                <span className="tag" style={{ marginRight: 6 }}>{l.zone === "NORMAL" ? "普通区" : "创新区"}</span>
                本金 {l.principal}
              </div>
              <div className="sess-meta"><WorkLink workUrl={l.work_url} /></div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="price num">¥{l.list_price}</div>
              <button className="btn ghost" style={{ marginTop: 6 }} onClick={() => match(l.id)}>购买</button>
            </div>
          </div>
        ))
      )}
      {msg && <div className="card risk-note">{msg}</div>}
    </>
  );
}
