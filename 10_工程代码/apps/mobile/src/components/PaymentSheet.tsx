"use client";

import { useEffect, useRef, useState } from "react";
import { useWriteContract } from "wagmi";
import { erc20Abi, parseUnits } from "viem";
import { api, type PaymentIntent } from "@/lib/api";

/**
 * 支付弹层：展示盐值金额 → USDT.transfer 直付 payee → 轮询到账状态。
 * 金额含系统识别码（盐），Indexer 扫到后按盐反查订单，15 确认自动入账；
 * 广播窗口 15 分钟，超时订单 EXPIRED（重新下单会生成新盐值）。
 */
export function PaymentSheet({ intent, onClose }: { intent: PaymentIntent; onClose: () => void }) {
  const { writeContractAsync } = useWriteContract();
  const [hash, setHash] = useState<`0x${string}` | null>(null);
  const [status, setStatus] = useState<"pending" | "broadcast" | "crediting" | "done" | "failed">("pending");
  const [err, setErr] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // 已广播 → 轮询 /payments/:id/status 直到 CREDITED
  useEffect(() => {
    if (status !== "broadcast" || !hash) return;
    timer.current = setInterval(async () => {
      try {
        const s = await api<{ status: string }>(`/payments/${intent.intentId}/status`);
        if (s.status === "CREDITED") {
          setStatus("done");
          stopPolling();
        }
      } catch { /* 下一轮重试 */ }
    }, 5000);
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, hash, intent.intentId]);

  function stopPolling() {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }

  useEffect(() => stopPolling, []);

  async function pay() {
    setErr("");
    try {
      setStatus("pending");
      const h = await writeContractAsync({
        address: intent.usdt as `0x${string}`,
        abi: erc20Abi,
        functionName: "transfer",
        args: [intent.payee as `0x${string}`, parseUnits(intent.saltAmount, 18)],
      });
      setHash(h);
      setStatus("broadcast");
    } catch (e) {
      setStatus("failed");
      setErr(e instanceof Error ? e.message : "支付失败");
    }
  }

  const step = (s: number, on: boolean, label: string) => (
    <div className={`step ${on ? "on" : ""}`}>
      <span className="dot">{on ? "✓" : s}</span>
      {label}
    </div>
  );

  return (
    <div className="sheet-mask" onClick={status === "done" || status === "failed" ? onClose : undefined}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>链上支付</h3>
        <div className="pay-row"><span className="k">应付金额（含识别码）</span><span className="num" style={{ fontWeight: 800 }}>{intent.saltAmount} USDT</span></div>
        <div className="pay-row"><span className="k">收款地址</span><span className="num">{intent.payee.slice(0, 10)}…{intent.payee.slice(-8)}</span></div>
        <div className="pay-row"><span className="k">网络</span><span className="num">BSC (chainId {intent.chainId})</span></div>
        <div className="pay-row"><span className="k">自动入账确认数</span><span className="num">{intent.confirmations}</span></div>
        <div className="pay-row"><span className="k">订单有效期</span><span className="num">{new Date(intent.expiresAt).toLocaleTimeString()}</span></div>

        <div className="steps">
          {step(1, !!hash, "钱包签名并广播转账")}
          {step(2, status === "crediting" || status === "done", status === "done" ? "已入账" : "等待链上确认（约 45 秒 / 15 确认）")}
          {step(3, status === "done", "Drama 自动入账")}
        </div>

        {hash && <p className="risk-note num" style={{ wordBreak: "break-all" }}>Tx: {hash}</p>}
        {err && <p className="risk-note" style={{ color: "var(--up)" }}>{err}</p>}
        <p className="risk-note" style={{ margin: "8px 0" }}>
          请严格按上方金额支付：金额尾数是系统识别订单的唯一依据，勿手动改动小数位。
        </p>

        {status === "done" ? (
          <button className="btn primary block" onClick={onClose}>完成</button>
        ) : status === "broadcast" ? (
          <button className="btn ghost block" disabled>已广播，等待确认…</button>
        ) : (
          <button className="btn primary block" onClick={pay}>
            {hash ? "重试支付" : "打开钱包支付"}
          </button>
        )}
      </div>
    </div>
  );
}
