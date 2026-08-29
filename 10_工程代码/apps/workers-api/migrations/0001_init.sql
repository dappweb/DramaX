-- DramaX D1 初始 Schema（依据《技术架构设计 V1.0》§2 ER 模型）
-- 约定：金额一律 TEXT 存十进制字符串（防浮点误差）；账本表只追加不修改。

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  wallet TEXT UNIQUE NOT NULL,            -- BSC 地址（小写）
  region TEXT NOT NULL DEFAULT '',        -- 区域屏蔽字段
  kyc_level INTEGER NOT NULL DEFAULT 0,
  drama_balance TEXT NOT NULL DEFAULT '0',
  drama_frozen TEXT NOT NULL DEFAULT '0', -- 卖出占用冻结
  credit_balance TEXT NOT NULL DEFAULT '0',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  account TEXT UNIQUE NOT NULL,           -- owner 登录标识（钱包登录时=钱包地址）
  wallet TEXT UNIQUE,                     -- SIWE 钱包登录；owner 首登自举建档
  password_hash TEXT,                     -- bcrypt（密码登录后备；钱包管理员可为空）
  totp_secret TEXT,
  role TEXT NOT NULL DEFAULT 'owner',     -- owner / staff(只读)
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,                   -- who/when/what/before→after
  entity TEXT NOT NULL,
  entity_id TEXT,
  before TEXT,
  after TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 剧本：草稿 → 待审核 → 已上架 → 已下架
CREATE TABLE IF NOT EXISTS scripts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  cover_key TEXT,                          -- R2 object key
  synopsis TEXT,
  category TEXT,
  episodes INTEGER,
  price TEXT NOT NULL,                     -- USDT 计价
  copyright_hash TEXT,                     -- SHA-256，上架前必填
  state TEXT NOT NULL DEFAULT 'DRAFT',     -- DRAFT/REVIEWING/LISTED/REMOVED
  review_note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 场次：普通区 16:00；创新区周二/四/六 15:00 与 17:00
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL REFERENCES scripts(id),
  zone TEXT NOT NULL CHECK (zone IN ('NORMAL','INNOVATION')),
  start_at TEXT NOT NULL,                  -- ISO datetime，业务层校验时间规则
  tier_min TEXT NOT NULL,
  tier_max TEXT NOT NULL,
  fee TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  taken INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'SCHEDULED' -- SCHEDULED/OPEN/FULL/CLOSED
);
CREATE INDEX IF NOT EXISTS idx_sessions_zone_time ON sessions(zone, start_at);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  amount TEXT NOT NULL,
  fee TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING/CONFIRMED/FAILED
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, session_id)
);

-- 持仓：状态机 HOLDING→MATURED→READY_TO_LIST→LISTED→MATCHED→SOLD（分支 DAO_INSUFFICIENT）
CREATE TABLE IF NOT EXISTS holdings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  script_id TEXT NOT NULL REFERENCES scripts(id),
  zone TEXT NOT NULL CHECK (zone IN ('NORMAL','INNOVATION')),
  principal TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'HOLDING',
  state_version INTEGER NOT NULL DEFAULT 0, -- 乐观锁
  matured_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_holdings_user ON holdings(user_id, state);

-- 每日增长流水（复利快照，只追加）
CREATE TABLE IF NOT EXISTS growth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holding_id TEXT NOT NULL REFERENCES holdings(id),
  day_no INTEGER NOT NULL,
  growth_amount TEXT NOT NULL,
  book_value_after TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (holding_id, day_no)
);

CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  holding_id TEXT NOT NULL REFERENCES holdings(id),
  seller_id TEXT NOT NULL REFERENCES users(id),
  list_price TEXT NOT NULL,                -- 账面价 × 1.03
  buyer_id TEXT,
  status TEXT NOT NULL DEFAULT 'LISTED',   -- LISTED/MATCHED/SOLD/CANCELLED
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- P2P 撮合：15 分钟支付广播窗口，Indexer 自动核验
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id),
  seller_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  price TEXT NOT NULL,
  payee_addr TEXT NOT NULL,
  salt_amount TEXT NOT NULL,               -- 含盐金额（订单绑定 P0 方案）
  broadcast_deadline TEXT NOT NULL,        -- 买家点击支付 +15min
  buyer_txid TEXT,                         -- Indexer 回写（用户不再手填）
  status TEXT NOT NULL DEFAULT 'PAYING',   -- PAYING/VERIFIED/SOLD/EXPIRED/DISPUTED
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Drama 账本（只追加；balance_after 做余额校验链）
CREATE TABLE IF NOT EXISTS drama_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,    -- DEPOSIT/RESERVE_FEE/FREEZE/UNFREEZE/OCCUPY/SETTLE_CASH...
  amount TEXT NOT NULL,
  balance_after TEXT NOT NULL,
  frozen_after TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_drama_ledger_user ON drama_ledger(user_id, id);

-- 生态积分账本（只追加；来源A交易产出 / 来源B行为奖励；无兑回出口）
CREATE TABLE IF NOT EXISTS credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  source TEXT NOT NULL CHECK (source IN ('A_TRADE','B_BEHAVIOR')),
  amount TEXT NOT NULL,
  balance_after TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 10 级返佣物化路径
CREATE TABLE IF NOT EXISTS referral_relations (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  inviter_id TEXT REFERENCES users(id),
  depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 10),
  path TEXT NOT NULL                       -- 物化路径 /root/.../user
);

CREATE TABLE IF NOT EXISTS commission_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  beneficiary_id TEXT NOT NULL REFERENCES users(id),
  depth INTEGER NOT NULL,
  rate TEXT NOT NULL,
  amount TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 链上事件原始表（tx_hash 唯一索引 = 天然幂等）
CREATE TABLE IF NOT EXISTS chain_events (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_no INTEGER NOT NULL,
  block_hash TEXT NOT NULL,                -- reorg 检测
  contract_addr TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  amount TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING/CONFIRMED/ROLLED_BACK/CREDITED
  intent_id TEXT,
  PRIMARY KEY (tx_hash, log_index)
);

-- 支付意图（KV 为主存，此处留审计副本）
CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY,
  order_type TEXT NOT NULL CHECK (order_type IN ('DEPOSIT','P2P')),
  order_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  payee_addr TEXT NOT NULL,
  base_amount TEXT NOT NULL,
  salt_amount TEXT NOT NULL,               -- 应付金额 = base + 盐
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING/BROADCAST/CONFIRMED/CREDITED/EXPIRED
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 入金记录（1 Drama = 1 USDT；DApp 模式下 tx_hash 由 Indexer 回写）
CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  payment_intent_id TEXT,
  tx_hash TEXT,                            -- 废弃的手动提交字段保留兼容
  chain TEXT NOT NULL DEFAULT 'BSC',
  amount TEXT NOT NULL,
  confirmations INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING/BROADCAST/CONFIRMED/CREDITED
  credited_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id, status);
