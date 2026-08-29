"use client";

import { createConfig, http } from "wagmi";
import { bsc, bscTestnet } from "wagmi/chains";
import { injected } from "wagmi/connectors";

// 链由构建时 NEXT_PUBLIC_CHAIN_ID 决定：56=BSC mainnet（默认），97=BSC testnet（演示环境）
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 56);
// as typeof bsc：构建期三元的联合类型会让 transports 要求同时提供 56/97 两键，收敛为单链
export const CHAIN = (CHAIN_ID === 97 ? bscTestnet : bsc) as typeof bsc;
export const CHAIN_ID_EXPORT = CHAIN.id;

// 钱包走浏览器注入（MetaMask / OKX / TokenPocket 等）
export const wagmiConfig = createConfig({
  chains: [CHAIN],
  connectors: [injected({ shimDisconnect: true })],
  transports: { [CHAIN.id]: http() },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
