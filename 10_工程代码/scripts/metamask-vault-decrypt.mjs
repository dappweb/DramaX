#!/usr/bin/env node
// MetaMask vault 解密 + SRP 派生目标地址私钥（本机一次性使用，凭据不落盘到工作区）
// 用法：node metamask-vault-decrypt.mjs "< metamask 密码>" [目标地址0x...] [vault文件]
// 不传目标地址则只打印钱包列表（不输出任何私钥）。
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const PASSWORD = process.argv[2] ?? "";
const TARGET = (process.argv[3] ?? "").toLowerCase();

// 1. 提取完整 vault JSON（leveldb 里 key 是 "vault"，value 是转义 JSON；扫 Default + Profile 1）
const PROFILES = ["Default", "Profile 1"];
let vaults = [];
for (const prof of PROFILES) {
  const LDB_DIR_P = `/Users/dappweb/Library/Application Support/Google/Chrome/${prof}/Local Extension Settings/nkbihfbeogaeaoehlefnkodbefgpgknn`;
  let files;
  try { files = execSync(`ls "${LDB_DIR_P}"`, { encoding: "utf8" }).trim().split("\n"); } catch { continue; }
  for (const f of files) {
    if (!/\.(ldb|log)$/.test(f)) continue;
    const out = execSync(`strings "${LDB_DIR_P}/${f}"`, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
    for (const line of out.split("\n")) {
      const idx = line.indexOf('{"vault":"');
      if (idx < 0) continue;
      const rest = line.slice(idx + 10);
      const end = rest.lastIndexOf('"}');
      if (end < 0) continue;
      const inner = rest.slice(0, end + 1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      try {
        let v;
        try {
          v = JSON.parse(inner);
        } catch (e) {
          const m = String(e.message).match(/position (\d+)/);
          if (m) v = JSON.parse(inner.slice(0, Number(m[1])));
          else throw e;
        }
        if (v.data && v.iv) vaults.push({ ...v, _file: `${prof}/${f}` });
      } catch {}
    }
  }
}
// 去重（按 data）
vaults = [...new Map(vaults.map((v) => [v.data, v])).values()];
console.log(`found ${vaults.length} vault candidate(s)`);
if (!vaults.length) process.exit(1);

// 2. 逐个尝试解密（兼容 salt 内嵌 / keyMetadata 迭代数）
function decrypt(v, password) {
  const data = Buffer.from(v.data, "base64");
  const iv = Buffer.from(v.iv, "base64");
  const salt = v.salt ? Buffer.from(v.salt, "base64") : null;
  const iterations = v.keyMetadata?.iterations ?? 600000;
  if (!salt) throw new Error("no salt");
  const key = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  // encryptor v3: 最后 16 字节为 auth tag；内容为 UTF-8 JSON
  const tag = data.subarray(data.length - 16);
  const cipher = data.subarray(0, data.length - 16);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(cipher), d.final()]).toString("utf8");
}

let decrypted = null, usedVault = null;
for (const v of vaults) {
  for (const iter of [v.keyMetadata?.iterations ?? 600000, 5000]) {
    try {
      const vv = iter === (v.keyMetadata?.iterations ?? 600000) ? v : { ...v, keyMetadata: { iterations: iter } };
      decrypted = decrypt(vv, PASSWORD);
      usedVault = { file: v._file, iterations: iter };
      break;
    } catch {}
  }
  if (decrypted) break;
}
if (!decrypted) { console.error("DECRYPT FAILED — 密码不对或 vault 格式不兼容"); process.exit(2); }
console.log(`decrypted OK (vault from ${usedVault.file}, ${usedVault.iterations} iterations)`);

const parsed = JSON.parse(decrypted);
const keyrings = parsed.keyrings ?? parsed.data?.keyrings ?? [];
const srps = [];
if (parsed.data?.mnemonic) srps.push(parsed.data.mnemonic);
for (const kr of keyrings) {
  if (kr.type?.includes("HD Key Tree") && kr.data?.mnemonic) srps.push(kr.data.mnemonic);
  if (Array.isArray(kr.accounts)) console.log("keyring accounts:", kr.accounts.join(", "));
}
if (!srps.length) { console.error("no SRP found in decrypted vault"); process.exit(3); }

// 3. 派生：只看目标地址，或只列出前 5 个地址
const { HDKey } = await import("@scure/bip32");
const { mnemonicToSeedSync, validateMnemonic, mnemonicToEntropy } = await import("@scure/bip39");
const { HDNodeWallet } = await import("ethers");
const { ethers } = await import("ethers");

for (const phrase of srps) {
  const words = typeof phrase === "string" ? phrase : phrase.join?.(" ") ?? "";
  if (!validateMnemonic(words.trim())) { console.log("invalid mnemonic (skip)"); continue; }
  const wallet = ethers.HDNodeWallet.fromPhrase(words.trim(), undefined, "m/44'/60'/0'/0");
  for (let i = 0; i < 25; i++) {
    const w = wallet.deriveChild(i);
    if (!TARGET) {
      if (i < 5) console.log(`  account[${i}] = ${w.address.toLowerCase()}`);
    } else if (w.address.toLowerCase() === TARGET) {
      console.log(`MATCH ${w.address}`);
      // 写入 /tmp（600），供 E2E 使用；不打印到终端
      writeFileSync("/tmp/dramax-e2e-key", w.privateKey.startsWith("0x") ? w.privateKey : "0x" + w.privateKey, { mode: 0o600 });
      console.log("private key written to /tmp/dramax-e2e-key (0600)");
      process.exit(0);
    }
  }
  if (!TARGET) console.log(`  ...derived 25 accounts from this SRP`);
}
console.log(TARGET ? `address ${TARGET} not found in first 25 indexes of any SRP` : "done");
