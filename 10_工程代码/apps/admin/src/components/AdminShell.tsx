"use client";

import { useState } from "react";
import { getAdminToken } from "@/lib/api";
import { DashboardView } from "./DashboardView";
import { ScriptsView } from "./ScriptsView";
import { SessionsView } from "./SessionsView";
import { AuditView } from "./AuditView";
import { Turnstile, resetTurnstile } from "./Turnstile";

type Page = "scripts" | "sessions" | "dashboard" | "audit";

const NAV: { key: Page; label: string; desc: string }[] = [
  { key: "scripts", label: "剧本管理", desc: "新建 / 四态流转 / 上架校验" },
  { key: "sessions", label: "场次管理", desc: "按场次规则创建（普通区 16:00 · 创新区周二四六 15:00 & 17:00）" },
  { key: "dashboard", label: "看板与参数", desc: "经济参数只读 · 变更需多签 + 审计" },
  { key: "audit", label: "操作日志", desc: "who / when / what / before → after" },
];

export function AdminShell() {
  const [page, setPage] = useState<Page>("scripts");
  const [loginErr, setLoginErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [tsToken, setTsToken] = useState("");
  const [tick, setTick] = useState(0); // 触发重渲染读取 token

  async function login() {
    setLoginErr("");
    setBusy(true);
    try {
      // 动态引入，避免 SSR 阶段触碰 window
      const { connectWallet, adminWalletLogin } = await import("@/lib/wallet");
      const address = await connectWallet();
      await adminWalletLogin(address, tsToken || undefined);
      setTsToken("");
      setTick((t) => t + 1);
    } catch (e) {
      setTsToken("");
      resetTurnstile(); // 换新题，旧 token 已被服务端消耗
      setLoginErr(e instanceof Error ? e.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    import("@/lib/api").then((m) => m.setAdminToken(null));
    setTick((t) => t + 1);
  }

  if (!getAdminToken()) {
    return (
      <div className="center-tip">
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>
          Drama<em style={{ color: "var(--primary)", fontStyle: "normal" }}>X</em> Admin
        </h1>
        <p>owner 钱包签名登录（SIWE · BSC）</p>
        <p style={{ fontSize: 12, marginTop: 6 }}>仅 ADMIN_OWNER_WALLET 或已登记管理员钱包可登录</p>
        <button className="btn primary" style={{ padding: "10px 26px", fontSize: 14 }} onClick={login} disabled={busy}>
          {busy ? "等待钱包签名…" : "连接钱包并登录"}
        </button>
        <Turnstile onToken={setTsToken} onExpire={() => setTsToken("")} />
        {loginErr && <p className="err">{loginErr}</p>}
      </div>
    );
  }

  const nav = NAV.find((n) => n.key === page)!;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="logo">
          Drama<em>X</em> Admin
        </div>
        {NAV.map((n) => (
          <button key={n.key} className={`nav-item ${page === n.key ? "active" : ""}`} onClick={() => setPage(n.key)}>
            {n.label}
          </button>
        ))}
        <div className="foot">
          BSC · chainId {process.env.NEXT_PUBLIC_CHAIN_ID ?? 56}<br />
          参数变更需多签 + 审计
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <h1>{nav.label}</h1>
          <button className="wallet-chip on" onClick={logout}>
            退出登录
          </button>
        </div>
        <p className="desc" style={{ marginBottom: 14 }}>{nav.desc}</p>

        {page === "scripts" && <ScriptsView />}
        {page === "sessions" && <SessionsView />}
        {page === "dashboard" && <DashboardView />}
        {page === "audit" && <AuditView />}
      </main>
    </div>
  );
}
