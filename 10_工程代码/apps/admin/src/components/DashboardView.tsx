"use client";

import { useEffect, useState } from "react";
import { adminApi } from "@/lib/api";

interface DashboardData {
  economics: {
    NORMAL_DAILY?: number;
    INNOVATION_DAILY?: number;
    HOLD_DAYS?: number;
    SELL_OCCUPANCY_RATE?: number;
    LIST_PREMIUM?: number;
    SETTLE?: { fee?: number; cash?: number; credit?: number };
    COMMISSION?: Record<string, unknown>;
    [k: string]: unknown;
  };
  tiers: { min?: number; max?: number; fee?: number; pending?: boolean }[];
}

export function DashboardView() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    adminApi<DashboardData>("/admin/dashboard")
      .then(setData)
      .catch((e) => setErr(e instanceof Error ? e.message : "加载失败"));
  }, []);

  if (err) return <div className="card err">{err}</div>;
  if (!data) return <div className="center-tip">加载中…</div>;

  const e = data.economics;
  const tiers = data.tiers ?? [];

  return (
    <>
      <div className="section-head">
        <h2>经济参数（只读）</h2>
        <span className="readonly-chip">P0 · 变更需多签 + 审计</span>
      </div>
      <div className="kpi-grid">
        <div className="kpi"><div className="k">普通区历史日增</div><div className="v num">{(Number(e.NORMAL_DAILY ?? 0.02) * 100).toFixed(0)}%</div></div>
        <div className="kpi"><div className="k">创新区历史日增</div><div className="v num">{(Number(e.INNOVATION_DAILY ?? 0.03) * 100).toFixed(0)}%</div></div>
        <div className="kpi"><div className="k">持有期</div><div className="v num">{e.HOLD_DAYS ?? 7} 天</div></div>
        <div className="kpi"><div className="k">卖出占用</div><div className="v num">{(Number(e.SELL_OCCUPANCY_RATE ?? 0.85) * 100).toFixed(0)}% × 增长</div></div>
        <div className="kpi"><div className="k">挂单溢价</div><div className="v num">×{e.LIST_PREMIUM ?? 1.03}</div></div>
        <div className="kpi"><div className="k">结算拆分</div><div className="v num">{e.SETTLE?.fee ?? 70}/{e.SETTLE?.cash ?? 15}/{e.SETTLE?.credit ?? 15}</div></div>
        <div className="kpi"><div className="k">1-3 代返佣</div><div className="v num">{String(e.COMMISSION?.l1_3 ?? "7%")}</div></div>
        <div className="kpi"><div className="k">4-10 代返佣</div><div className="v num">{String(e.COMMISSION?.l4_10 ?? "2%")}</div></div>
      </div>

      <div className="section-head"><h2>档位手续费表</h2><span className="readonly-chip">P0 · 只读</span></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>档位区间 (USDT)</th><th className="num">手续费 (USDT)</th><th>备注</th></tr></thead>
          <tbody>
            {tiers.map((t, i) => (
              <tr key={i}>
                <td className="num">{t.min} - {t.max}</td>
                <td className="num">{t.pending ? <span className="tag amber">待确认</span> : `¥${t.fee}`}</td>
                <td className="desc">{t.pending ? "费率待拍板，暂不可创建场次" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
