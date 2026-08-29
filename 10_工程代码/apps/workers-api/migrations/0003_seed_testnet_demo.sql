-- 0003: Testnet 演示数据（仅 dramax-testnet 库使用，勿在生产库执行）
-- owner 钱包：0xb7940a57d5fb0288776f95047467e3d72eed9e09
-- 场次时间规则仅为演示（普通区 16:00 / 创新区周二四六 15:00 & 17:00），直插 SQL 绕过业务校验

-- ─── Admin owner（钱包登录自举的等价建档） ───
INSERT OR IGNORE INTO admins (id, account, wallet, role)
VALUES ('admin-owner', '0xb7940a57d5fb0288776f95047467e3d72eed9e09', '0xb7940a57d5fb0288776f95047467e3d72eed9e09', 'owner');

-- ─── 演示用户（3 个：余额/持仓/挂单用于市场与团队演示） ───
INSERT OR IGNORE INTO users (id, wallet, drama_balance, credit_balance) VALUES
  ('demo-user-1', '0x1111111111111111111111111111111111111111', '5000.00', '120.00'),
  ('demo-user-2', '0x2222222222222222222222222222222222222222', '12000.00', '350.00'),
  ('demo-user-3', '0x3333333333333333333333333333333333333333', '3000.00', '80.00');

INSERT OR IGNORE INTO drama_ledger (user_id, type, amount, balance_after, frozen_after, ref_type, ref_id) VALUES
  ('demo-user-1', 'TOPUP', '5000.00', '5000.00', '0.00', 'deposit', 'demo-topup-1'),
  ('demo-user-2', 'TOPUP', '12000.00', '12000.00', '0.00', 'deposit', 'demo-topup-2'),
  ('demo-user-3', 'TOPUP', '3000.00', '3000.00', '0.00', 'deposit', 'demo-topup-3');

INSERT OR IGNORE INTO referral_relations (user_id, inviter_id) VALUES
  ('demo-user-2', 'demo-user-1'),
  ('demo-user-3', 'demo-user-2');

-- ─── 剧本（LISTED ×4 / REVIEWING / DRAFT 演示四态） ───
INSERT OR IGNORE INTO scripts (id, title, synopsis, category, episodes, price, copyright_hash, state, created_by) VALUES
  ('script-01', '闪婚老公是首富', '落魄千金闪婚神秘大佬，婚后才发现对方是全城首富。', '都市甜宠', 68, '300.00', '3a1f2b7c9d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8', 'LISTED', 'admin-owner'),
  ('script-02', '重生之商界女王', '被闺蜜背叛惨死的女总裁重生回到十年前，一步步收回属于自己的一切。', '都市逆袭', 82, '500.00', '4b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a', 'LISTED', 'admin-owner'),
  ('script-03', '隐世神医在都市', '深山学医二十年的少年下山，一手银针搅动都市风云。', '战神医仙', 75, '400.00', '5c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b', 'LISTED', 'admin-owner'),
  ('script-04', '千亿婚宠：夫人马甲又掉了', '人人以为她是乡下灰姑娘，直到马甲一个个掉落……', '马甲爽文', 90, '600.00', '6d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c', 'LISTED', 'admin-owner'),
  ('script-05', '我的AI恋人', '程序员与自己训练的大模型之间，一段跨越比特与原子的爱情。', '科幻悬疑', 40, '350.00', '7e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d', 'REVIEWING', 'admin-owner'),
  ('script-06', '长夜将明', '民国乱世，戏班女儿与革命者的家国绝恋。', '年代群像', 55, '450.00', '8f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e', 'DRAFT', 'admin-owner');

-- ─── 场次（普通区 16:00 / 创新区周二四六 15:00 & 17:00，均在未来） ───
INSERT OR IGNORE INTO sessions (id, script_id, zone, start_at, tier_min, tier_max, fee, capacity, taken, status) VALUES
  ('sess-01', 'script-01', 'NORMAL',     datetime('now', '+1 day', 'start of day', '+16 hours'), '300',  '1000',  '0',    50, 3,  'OPEN'),
  ('sess-02', 'script-02', 'INNOVATION', datetime('now', '+2 day', 'start of day', '+15 hours'), '1000', '5000',  '75',   30, 5,  'OPEN'),
  ('sess-03', 'script-03', 'NORMAL',     datetime('now', '+2 day', 'start of day', '+16 hours'), '300',  '1000',  '0',    50, 0,  'OPEN'),
  ('sess-04', 'script-04', 'INNOVATION', datetime('now', '+3 day', 'start of day', '+17 hours'), '5000', '12000', '240',  20, 2,  'OPEN'),
  ('sess-05', 'script-02', 'INNOVATION', datetime('now', '+4 day', 'start of day', '+15 hours'), '12000','35000', '450',  10, 0,  'OPEN'),
  ('sess-06', 'script-01', 'NORMAL',     datetime('now', '-2 day', 'start of day', '+16 hours'), '300',  '1000',  '0',    50, 50, 'CLOSED');

-- ─── 持仓与挂单（市场页演示数据） ───
INSERT OR IGNORE INTO holdings (id, user_id, script_id, zone, principal, state, matured_at, created_at) VALUES
  ('demo-h1', 'demo-user-1', 'script-01', 'NORMAL',     '1000.00',  'HOLDING', NULL,                              datetime('now', '-1 day')),
  ('demo-h2', 'demo-user-1', 'script-02', 'INNOVATION', '3000.00',  'MATURED', datetime('now', '-1 day'),         datetime('now', '-8 day')),
  ('demo-h3', 'demo-user-2', 'script-03', 'NORMAL',     '5000.00',  'HOLDING', NULL,                              datetime('now', '-2 day')),
  ('demo-h4', 'demo-user-2', 'script-04', 'INNOVATION', '12000.00', 'LISTED',  datetime('now', '-2 day'),         datetime('now', '-9 day')),
  ('demo-h5', 'demo-user-3', 'script-05', 'NORMAL',     '800.00',   'LISTED',  datetime('now', '-3 day'),         datetime('now', '-10 day')),
  ('demo-h6', 'demo-user-3', 'script-06', 'INNOVATION', '1500.00',  'MATURED', datetime('now', '-1 day'),         datetime('now', '-8 day'));

-- 账面价 = 本金×(1+日增长)^7；挂单价 = 账面价×1.03
-- demo-h2: 3000×1.03^7=3689.62 → 3800.31；demo-h4: 12000×1.03^7=14758.49 → 15201.24
-- demo-h5: 800×1.02^7=918.35 → 945.90；demo-h6: 1500×1.03^7=1844.81 → 1900.15
INSERT OR IGNORE INTO listings (id, holding_id, seller_id, list_price, status, created_at) VALUES
  ('demo-l1', 'demo-h4', 'demo-user-2', '15201.24', 'LISTED', datetime('now', '-1 day')),
  ('demo-l2', 'demo-h5', 'demo-user-3', '945.90',   'LISTED', datetime('now', '-1 day'));

-- 每日增长流水（快照演示）
INSERT OR IGNORE INTO growth_events (holding_id, day_no, growth_amount, book_value_after, created_at) VALUES
  ('demo-h1', 1, '20.00', '1020.00', datetime('now', '-1 day')),
  ('demo-h3', 1, '100.00', '5100.00', datetime('now', '-1 day')),
  ('demo-h3', 2, '102.00', '5202.00', datetime('now'));
