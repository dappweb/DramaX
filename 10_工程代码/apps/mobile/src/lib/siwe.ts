"use client";

import { createSiweMessage } from "viem/siwe";
import { api, setToken } from "./api";

/**
 * SIWE 登录闭环：
 * 1. GET /auth/nonce → 服务端 nonce（KV 5min TTL）
 * 2. viem createSiweMessage（domain/uri 取当前页面，chainId 56）——注意 nonce 服务端只允许字母数字
 * 3. 钱包 personal_sign → POST /auth/login → Bearer JWT（localStorage）
 * 服务端会校验：签名恢复地址、消息内 nonce/domain 一致、domain ∈ ALLOWED_ORIGIN 白名单。
 */
export async function loginWithWallet(
  address: `0x${string}`,
  signMessage: (msg: string) => Promise<string>,
  turnstileToken?: string
): Promise<{ token: string; userId: string }> {
  const { nonce } = await api<{ nonce: string }>("/auth/nonce");
  const message = createSiweMessage({
    domain: window.location.host,
    uri: window.location.origin,
    address,
    statement: "Sign in to DramaX",
    version: "1",
    chainId: 56,
    nonce,
  });
  const signature = await signMessage(message);
  const res = await api<{ token: string; userId: string }>("/auth/login", {
    method: "POST",
    body: { address, message, nonce, signature, turnstileToken },
  });
  setToken(res.token);
  return res;
}
