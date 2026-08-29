"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type PaymentIntent } from "@/lib/api";
import { PaymentSheet } from "./PaymentSheet";

interface CommissionRow {
  id?: string;
  level?: number;
  amount?: string;
  from_user?: string;
  created_at?: string;
}

export function ProfileView() {
  const [amount, setAmount] = useState("1000");
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [msg, setMsg] = useState("");
  const [credits, setCredits] = useState<string | null>(null);
  const [commissions, setCommissions] = useState<CommissionRow[]>([]);

  const load = useCallback(async () => {
    try {
      const c = await api<{ credit_balance?: string; balance?: string } | { credits: { credit_balance?: string } }>("/credits");
      const bal = (c as { credit_balance?: string }).credit_balance ?? (c as { credits?: { credit_balance?: string } }).credits?.credit_balance ?? null;
      setCredits(bal);
    } catch { /* 静默 */ }
    try {
      const t = await api<{ commissions?: CommissionRow[] } | CommissionRow[]>("/team/commissions");
      setCommissions(Array.isArray(t) ? t : (t.commissions ?? []));
    } catch { /* 静默 */ }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 充值：生成 DEPOSIT 意图 → PaymentSheet（金额盐绑定，15 确认自动入账）
  async function deposit() {
    setMsg("");
    try {
      const it = await api<PaymentIntent>("/payments/intent", {
        method: "POST",
        body: { orderType: "DEPOSIT", orderId: crypto.randomUUID(), baseAmount: amount },
      });
      setIntent(it);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "充值失败");
    }
  }

  return (
    <>
      <div className="section-title">钱包与充值</div>
      <div className="card">
        <div className="pay-row"><span className="k">充值金额（USDT）</span>
          <input
            className="num" style={{ width: 110, textAlign: "right", border: "none", fontWeight: 700, fontSize: 15 }}
            value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal"
          />
        </div>
        <p className="risk-note" style={{ margin: "8px 0" }}>
          每笔充值金额附带唯一识别码（盐值），链上到账并满足 {15} 确认后自动入账为 Drama 余额；1 Drama ≈ ¥1。
        </p>
        <button className="btn primary block" onClick={deposit}>生成充值订单</button>
        {msg && <p className="risk-note" style={{ marginTop: 8, color: "var(--up)" }}>{msg}</p>}
      </div>

      <div className="section-title">团队返佣</div>
      <div className="card">
        {commissions.length === 0 ? (
          <div className="risk-note">1-3 代 7% / 4-10 代 2%，来源为团队成员订阅场次的手续费部分，以 Drama 发放；暂无返佣记录。</div>
        ) : (
          commissions.slice(0, 10).map((r, i) => (
            <div className="pay-row num" key={r.id ?? i}>
              <span className="k">第 {r.level ?? "-"} 代</span>
              <span>+{r.amount ?? "-"}</span>
            </div>
          ))
        )}
      </div>

      <div className="section-title">生态积分</div>
      <div className="card">
        <div className="pay-row"><span className="k">积分余额</span><span className="num">{credits ?? "—"}</span></div>
        <p className="risk-note" style={{ marginTop: 8 }}>积分按 1:1 产出、不可兑回；场次结算产出（来源A）与生态行为（来源B）发放。</p>
      </div>

      {intent && <PaymentSheet intent={intent} onClose={() => { setIntent(null); load(); }} />}
    </>
  );
}
