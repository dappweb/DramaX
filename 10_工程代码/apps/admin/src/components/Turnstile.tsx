"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Cloudflare Turnstile 人机验证（登录门）。
 * - NEXT_PUBLIC_TURNSTILE_SITEKEY 未配置时不渲染（与后端 TURNSTILE_SECRET 为空跳过校验对称，本地开发无感）。
 * - onToken 回调把 token 交给登录流程；登录失败时调用 resetTurnstile() 换新题。
 */
declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

const SITEKEY = process.env.NEXT_PUBLIC_TURNSTILE_SITEKEY;
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";

// 模块级 reset：登录失败后由 Shell 调用换新题
let widgetId: string | null = null;
export function resetTurnstile() {
  if (widgetId !== null) window.turnstile?.reset(widgetId);
}

export function Turnstile({ onToken, onExpire }: { onToken: (token: string) => void; onExpire?: () => void }) {
  const holderRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(typeof window !== "undefined" && !!window.turnstile);
  // 用 ref 固定回调，避免 effect 因回调引用变化而重渲染 widget
  const onTokenRef = useRef(onToken);
  const onExpireRef = useRef(onExpire);
  onTokenRef.current = onToken;
  onExpireRef.current = onExpire;

  useEffect(() => {
    if (!SITEKEY || ready) return;
    if (!document.querySelector(`script[src="${SCRIPT_SRC}"]`)) {
      const s = document.createElement("script");
      s.src = SCRIPT_SRC;
      s.async = true;
      s.defer = true;
      s.onload = () => setReady(true);
      s.onerror = () => console.error("Turnstile 脚本加载失败");
      document.head.appendChild(s);
    } else {
      const t = setInterval(() => {
        if (window.turnstile) {
          clearInterval(t);
          setReady(true);
        }
      }, 100);
      return () => clearInterval(t);
    }
  }, [ready]);

  useEffect(() => {
    if (!SITEKEY || !ready || !holderRef.current || widgetId !== null) return;
    widgetId = window.turnstile!.render(holderRef.current, {
      sitekey: SITEKEY,
      theme: "light",
      callback: (token: string) => onTokenRef.current(token),
      "expired-callback": () => onExpireRef.current?.(),
      "error-callback": () => onExpireRef.current?.(),
    }) as unknown as string;
    return () => {
      if (widgetId !== null) {
        window.turnstile?.remove(widgetId);
        widgetId = null;
      }
    };
  }, [ready]);

  if (!SITEKEY) return null;
  return <div ref={holderRef} style={{ margin: "10px 0", display: "flex", justifyContent: "center" }} />;
}
