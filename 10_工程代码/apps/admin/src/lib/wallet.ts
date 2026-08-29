"use client";

import { createSiweMessage } from "viem/siwe";
import { adminApi, setAdminToken } from "./api";

// EIP-1193 浏览器注入钱包（MetaMask / OKX / TokenPocket），不引入 wagmi（Admin 只需登录+签名）
interface EthProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export function getProvider(): EthProvider | null {
  if (typeof window === "undefined") return null;
  const eth = (window as unknown as { ethereum?: EthProvider }).ethereum;
  return eth ?? null;
}

export async function connectWallet(): Promise<string> {
  const provider = getProvider();
  if (!provider) throw new Error("未检测到浏览器钱包插件");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.length) throw new Error("钱包未授权账户");
  return accounts[0].toLowerCase();
}

/**
 * Admin 钱包登录（owner SIWE）：
 * GET /admin/auth/nonce → createSiweMessage → personal_sign → POST /admin/auth/login
 * 服务端校验签名与 admins.wallet；ADMIN_OWNER_WALLET 配置的 owner 钱包首登自举建档（role=owner）。
 */
// 链由构建时 NEXT_PUBLIC_CHAIN_ID 决定（56 mainnet 默认 / 97 testnet 演示）
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 56);
export const ADMIN_CHAIN_ID = CHAIN_ID;

export async function adminWalletLogin(
  address: string,
  turnstileToken?: string
): Promise<{ token: string; role: string }> {
  const provider = getProvider();
  if (!provider) throw new Error("未检测到浏览器钱包插件");

  const { nonce } = await adminApi<{ nonce: string }>("/admin/auth/nonce");
  const message = createSiweMessage({
    domain: window.location.host,
    uri: window.location.origin,
    address: address as `0x${string}`,
    statement: "Sign in to DramaX Admin",
    version: "1",
    chainId: CHAIN_ID,
    nonce,
  });
  const signature = (await provider.request({
    method: "personal_sign",
    params: [message, address],
  })) as string;

  const res = await adminApi<{ token: string; role: string }>("/admin/auth/login", {
    method: "POST",
    body: { message, nonce, signature, turnstileToken },
  });
  setAdminToken(res.token);
  return res;
}
