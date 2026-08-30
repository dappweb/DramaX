// MockUSDT 一次性部署 + mint（testnet）
// 用法：node deploy-mock-usdt.mjs   （私钥读 /tmp/dramax-e2e-key）
// 输出：合约地址写入 /tmp/dramax-mock-usdt.txt
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, createPublicClient, http, parseUnits, formatUnits } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import MockUSDT from "../contracts/MockUSDT.json" with { type: "json" };

const RPC = "https://bsc-testnet-rpc.publicnode.com";
const chain = {
  id: 97, name: "BSC Testnet",
  nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } }, testnet: true,
};
const pk = readFileSync("/tmp/dramax-e2e-key", "utf8").trim();
const account = privateKeyToAccount(pk);
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });
console.log("wallet:", account.address);
console.log("gas:", Number(formatUnits(await publicClient.getBalance({ address: account.address }), 18)).toFixed(4), "tBNB");

const addr = process.env.MOCK_USDT;
let usdtAddr;
if (addr) {
  usdtAddr = addr;
  console.log("using existing MockUSDT:", usdtAddr);
} else {
  const hash = await walletClient.deployContract({ abi: MockUSDT.abi, bytecode: MockUSDT.bytecode, args: [] });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash });
  usdtAddr = rcpt.contractAddress;
  console.log("MockUSDT deployed:", usdtAddr, "tx:", hash);
}
const usdt = getContract({ address: usdtAddr, abi: MockUSDT.abi, client: { public: publicClient, wallet: walletClient } });
const bal = await usdt.read.balanceOf([account.address]);
if (bal < parseUnits("200", 18)) {
  const h = await usdt.write.mint([account.address, parseUnits("200", 18)]);
  const r = await publicClient.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") { console.error("mint failed"); process.exit(1); }
  console.log("minted 200 USDT to", account.address);
} else {
  console.log("USDT balance sufficient:", formatUnits(bal, 18));
}
writeFileSync("/tmp/dramax-mock-usdt.txt", usdtAddr + "\n");
console.log("saved to /tmp/dramax-mock-usdt.txt");
