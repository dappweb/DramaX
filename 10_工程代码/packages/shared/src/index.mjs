// DramaX 业务规则单一事实源
// 依据：《商业逻辑总结 V2.1》《技术架构设计 V1.0》《钱包支付整改方案 V1.0》
// 所有端（mobile / admin / workers-api）必须 import 本模块，禁止各自硬编码口径。

// ─── 链上常量（BSC 单链） ───
export const CHAIN = {
  ID: 56, // BSC mainnet
  NAME: "BSC",
  USDT: "0x55d398326f99059fF775485246999027B3197955",
  CONFIRMATIONS: 15, // ≈45s @ 3s/block
};

// ─── 资产口径 ───
export const ASSETS = {
  DRAMA_USD: 1, // 1 Drama = 1 USDT
  CREDIT_RATE: 1, // 生态积分转换 1:1，不可兑回 Drama/USDT
};

// ─── 持有与增长 ───
export const GROWTH = {
  HOLD_DAYS: 7,
  DAILY_RATE: { NORMAL: 0.02, INNOVATION: 0.03 },
  // 账面价 = 本金 × (1+日增长)^已持有天数（HOLDING 按已持有天数，MATURED 按 7 天满期）
  bookValue(principal, zone, days) {
    const r = GROWTH.DAILY_RATE[zone];
    if (!r) throw new Error(`unknown zone: ${zone}`);
    const days2 = Math.min(Math.max(0, Math.floor(days)), GROWTH.HOLD_DAYS);
    const v = principal * Math.pow(1 + r, days2);
    return Math.round(v * 100) / 100;
  },
  growthOf(principal, zone, days) {
    return Math.round((GROWTH.bookValue(principal, zone, days) - principal) * 100) / 100;
  },
};

// ─── 卖出与挂单 ───
export const SELL = {
  OCCUPANCY_RATE: 0.85, // 卖出需占用 Drama = 增长 × 85%
  LIST_PREMIUM: 1.03, // 挂单价 = 账面价 × 1.03
  occupancyOf(growth) {
    return Math.round(growth * SELL.OCCUPANCY_RATE * 100) / 100;
  },
  listPriceOf(bookValue) {
    return Math.round(bookValue * SELL.LIST_PREMIUM * 100) / 100;
  },
};

// ─── 结算瀑布：增长拆分 70/15/15 ───
export const SETTLE = {
  FEE: 0.7,
  CASH: 0.15,
  CREDIT: 0.15,
  split(growth) {
    const fee = Math.round(growth * SETTLE.FEE * 100) / 100;
    const cash = Math.round(growth * SETTLE.CASH * 100) / 100;
    const credit = Math.round((growth - fee - cash) * 100) / 100; // 尾差归积分，保证合计=增长
    return { fee, cash, credit };
  },
};

// ─── 返佣：1-3 代 7% / 4-10 代 2%（占手续费 35%，留存 65%） ───
export const COMMISSION = {
  rateFor(depth) {
    if (depth >= 1 && depth <= 3) return 0.07;
    if (depth >= 4 && depth <= 10) return 0.02;
    return 0;
  },
  of(feePart, depth) {
    const rate = COMMISSION.rateFor(depth);
    return { rate, amount: Math.round(feePart * rate * 100) / 100 };
  },
};

// ─── 档位表（禁止杜撰区间；300–1,000 待确认） ───
export const TIERS = [
  { min: 300, max: 1000, fee: null, pending: true },
  { min: 1000, max: 5000, fee: 75 },
  { min: 5000, max: 12000, fee: 240 },
  { min: 12000, max: 35000, fee: 450 },
];

export function tierFor(amount) {
  return TIERS.find((t) => amount >= t.min && amount <= t.max) || null;
}

export function feeFor(amount) {
  const t = tierFor(amount);
  if (!t) return null;
  if (t.pending) return { pending: true, fee: null };
  return { pending: false, fee: t.fee };
}

// ─── 场次规则 ───
export const SESSION_RULES = {
  NORMAL_HOURS: [16], // 普通区 16:00
  INNOVATION_DAYS: [2, 4, 6], // 周二/四/六（1=周一）
  INNOVATION_HOURS: [15, 17],
  // 校验场次时间合法性；返回 null=合法，否则为错误信息
  validate(zone, date) {
    const d = new Date(date);
    const dow = d.getDay() === 0 ? 7 : d.getDay();
    const hour = d.getHours();
    if (zone === "NORMAL") {
      if (hour !== SESSION_RULES.NORMAL_HOURS[0]) return "普通区场次固定 16:00";
      return null;
    }
    if (zone === "INNOVATION") {
      if (!SESSION_RULES.INNOVATION_DAYS.includes(dow)) return "创新区场次仅周二/四/六";
      if (!SESSION_RULES.INNOVATION_HOURS.includes(hour)) return "创新区场次仅 15:00 或 17:00";
      return null;
    }
    return `unknown zone: ${zone}`;
  },
};

// ─── 支付（钱包连接 DApp 直付） ───
export const PAYMENT = {
  BROADCAST_WINDOW_MIN: 15, // 支付广播监听窗口（原 60min txid 模式已废除）
  INTENT_TTL_MIN: 30,
  SALT_DECIMALS: 2, // 金额盐：应付金额 + 唯一分位盐
};

// ─── 盈亏基准（财务线） ───
export const ECONOMICS = {
  NET_CONTRIBUTION_RATE: 0.0075, // ≈0.75% × GMV
  MONTHLY_FIXED_COST: 800000, // 80 万 USDT/月
  BREAKEVEN_MONTHLY_GMV: 107000000, // ≈1.07 亿
  LIQUIDITY_LINE: 1.5, // 净入金 / 现金收益支付 ≥ 1.5
};

// ─── 自检（QA 基准数字） ───
export function selftest() {
  const assert = (name, actual, expected) => {
    if (Math.abs(actual - expected) > 0.011) throw new Error(`${name}: ${actual} != ${expected}`);
  };
  assert("matured-800", GROWTH.bookValue(800, "NORMAL", 7), 918.95);
  assert("growth-800", GROWTH.growthOf(800, "NORMAL", 7), 118.95);
  assert("occupy-118.95", SELL.occupancyOf(118.95), 101.11);
  assert("holding-d3-2000", GROWTH.bookValue(2000, "NORMAL", 3), 2122.42);
  assert("list-918.95", SELL.listPriceOf(918.95), 946.52);
  const s = SETTLE.split(300);
  assert("split-fee", s.fee, 210);
  assert("split-cash", s.cash, 45);
  assert("split-credit", s.credit, 45);
  assert("sum-300", s.fee + s.cash + s.credit, 300);
  assert("occ-60", SELL.occupancyOf(60), 51);
  assert("comm-d2", COMMISSION.of(210, 2).amount, 14.7);
  assert("comm-d5", COMMISSION.of(210, 5).amount, 4.2);
  assert("fee-1500", feeFor(1500).fee, 75);
  assert("fee-8000", feeFor(8000).fee, 240);
  assert("fee-20000", feeFor(20000).fee, 450);
  if (feeFor(500).pending !== true) throw new Error("300-1000 should be pending");
  return "ALL OK";
}

// ─── 支付意图：金额盐（订单绑定 P0 方案） ───
PAYMENT.saltFor = function (baseAmount, orderId) {
  // 盐 = orderId 哈希取 0..99，拼到分位；与活动意图冲突时由调用方计数重试
  let h = 0;
  const s = String(orderId);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const cents = h % 100;
  const salted = Math.round(baseAmount * 100) / 100 + cents / 100;
  return { cents, saltAmount: Math.round(salted * 100) / 100 };
};

// ─── 账本余额校验链：逐行验证 balance_after 连续性 ───
export const LEDGER = {
  // rows: [{amount, balance_after}] 按序；start 为期初余额
  assertChain(rows, start) {
    let bal = start;
    for (const [i, r] of rows.entries()) {
      bal = Math.round((bal + Number(r.amount)) * 100) / 100;
      if (Math.abs(bal - Number(r.balance_after)) > 0.011) {
        return { ok: false, at: i, expected: bal, got: Number(r.balance_after) };
      }
    }
    return { ok: true, final: bal };
  },
};
