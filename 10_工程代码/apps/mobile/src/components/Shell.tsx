"use client";

import { useState } from "react";
import { useAccount, useConnect, useSignMessage } from "wagmi";
import { getToken, setToken } from "@/lib/api";
import { loginWithWallet } from "@/lib/siwe";
import { HomeView } from "./HomeView";
import { MarketView } from "./MarketView";
import { HoldingsView } from "./HoldingsView";
import { ProfileView } from "./ProfileView";

type Tab = "home" | "market" | "holdings" | "profile";

const TABS: { key: Tab; ico: string; label: string }[] = [
  { key: "home", ico: "🏠", label: "首页" },
  { key: "market", ico: "🏪", label: "市场" },
  { key: "holdings", ico: "📜", label: "持仓" },
  { key: "profile", ico: "👤", label: "我的" },
];

export function Shell() {
  const [tab, setTab] = useState<Tab>("home");
  const [authError, setAuthError] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { signMessageAsync } = useSignMessage();

  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";

  async function signIn() {
    if (!address) return;
    setSigningIn(true);
    setAuthError("");
    try {
      await loginWithWallet(address, (msg) => signMessageAsync({ message: msg }));
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : "登录失败");
    } finally {
      setSigningIn(false);
    }
  }

  function logout() {
    setToken(null);
    setTab("home");
  }

  const connected = isConnected;
  const loggedIn = connected && !!getToken();

  return (
    <div className="shell">
      <div className="page">
        <div className="topbar">
          <div className="brand">
            Drama<em>X</em>
          </div>
          {connected ? (
            <button className="wallet-chip on" onClick={loggedIn ? logout : signIn}>
              {loggedIn ? short : signingIn ? "签名中…" : "钱包登录"}
            </button>
          ) : (
            <button className="wallet-chip" onClick={() => connect({ connector: connectors[0] })}>
              连接钱包
            </button>
          )}
        </div>

        {!connected && (
          <div className="center-tip">
            连接浏览器钱包（MetaMask / OKX / TokenPocket）<br />后即可参与场次与交易
          </div>
        )}

        {connected && !loggedIn && (
          <div className="center-tip">
            <button className="btn primary block" onClick={signIn} disabled={signingIn}>
              {signingIn ? "等待钱包签名…" : "SIWE 钱包签名登录"}
            </button>
            {authError && <p style={{ color: "var(--up)", marginTop: 10, fontSize: 12 }}>{authError}</p>}
          </div>
        )}

        {loggedIn && (
          <>
            {tab === "home" && <HomeView />}
            {tab === "market" && <MarketView />}
            {tab === "holdings" && <HoldingsView />}
            {tab === "profile" && <ProfileView />}
          </>
        )}
      </div>

      <div className="tabbar">
        {TABS.map((t) => (
          <button key={t.key} className={`tab-item ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
            <span className="t-ico">{t.ico}</span>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
