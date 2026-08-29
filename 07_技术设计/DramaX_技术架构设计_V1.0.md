# DramaX 技术架构设计 V1.0

> 依据《DramaX 商业逻辑总结 V2.1 合并版》《链路线与USDT入金》编写
> 定位：ER 建模 + 状态机 + 账本 + API 的工程需求输入
> 日期：2026-08-28

---

## 1. 总体架构（三阶段演进）

```
阶段一（上线）          阶段二（中期）            阶段三（海外）
┌─────────────┐   ┌─────────────────┐   ┌──────────────────┐
│ Next.js/NestJS │   │ 联盟链版权存证    │   │ BSC 迁移          │
│ PostgreSQL DB │ → │ (剧本指纹+合同哈希)│ → │ Drama→BEP-20      │
│ 双账本(链下)   │   │ DB 仍是资金事实源 │   │ 权益→ERC-1155     │
│ USDT 入金核验  │   │                 │   │ Escrow/Referral   │
└─────────────┘   └─────────────────┘   └──────────────────┘
```

- **原则**：资金事实源始终在链下 DB + 双账本；链上只做存证与（远期）结算，不做投机属性暴露。
- **合规**：USDT 直接入金 → 平台需海外主体 + 中国大陆区域屏蔽 + VASP/MSB 评估（见 V2.1 §16）。

## 2. ER 模型（核心 10 表）

```
users ──┬── deposits ──────── (txid 唯一索引, chain, confirmations)
        ├── holdings ──┬── reservations ── sessions (场次+档位)
        │              ├── listings ──── matches (60min txid 核验窗口)
        │              └── growth_events (每日增长流水, 复利快照)
        ├── drama_ledger (Drama 账本: 余额/冻结/占用)
        ├── credit_ledger (生态积分账本: 来源A/来源B)
        ├── referral_relations (10级树, inviter_path)
        └── commission_records (1-3代7% / 4-10代2%, 关联手续费流水)
```

| 表 | 关键字段 | 约束/说明 |
|---|---|---|
| `users` | id, region, kyc_level, drama_balance, drama_frozen, credit_balance | 区域屏蔽字段 `region` 用于合规 |
| `deposits` | user_id, txid(**UNIQUE**), chain(enum: TRC20/BSC), amount, confirmations, status | 假币校验：仅白名单 USDT 合约（TRC-20 `TR7NHqje…Lj6t` ≥19 确认 / BSC `0x55d3…7955` ≥15 确认）；1 Drama = 1 USDT |
| `sessions` | zone(enum: NORMAL/INNOVATION), start_at, tier_min, tier_max, fee, capacity, status | 档位：1,000–5,000→75 / 5,000–12,000→240 / 12,000–35,000→450；300–1,000 待确认；普通区场次 16:00，创新区周二/四/六双场 |
| `reservations` | user_id, session_id, amount, fee, status(PENDING/CONFIRMED/FAILED) | 唯一约束 (user_id, session_id) |
| `holdings` | user_id, principal, daily_rate(0.02/0.03), matured_at, state, book_value_snapshot | 日增长普通区 2% / 创新区 3%，7 天复利 Pn = P0×(1+r)^n |
| `growth_events` | holding_id, day_no, growth_amount, book_value_after | 每日增长流水，复利依据 |
| `listings` | holding_id, list_price(账面×1.03), status, buyer_id | 卖出前置：占用 = 增长×85%，从 drama_frozen 扣 |
| `matches` | listing_id, seller_id, buyer_id, price, verify_deadline(+60min), buyer_txid, status | P2P 转售，txid 链上自动核验，超时未核验 → 申诉/回滚 |
| `drama_ledger` | user_id, type(入金/抢购/冻结/解冻/占用/结算), amount, balance_after, ref_type, ref_id | **只追加不修改**，balance_after 做余额校验链 |
| `credit_ledger` | user_id, source(A_交易/B_行为), amount, rate(1:1), ref_id | 生态积分链下闭环，禁止兑回 Drama |
| `referral_relations` | user_id, inviter_id, depth(1-10), path | path 物化路径，深度>10 不计佣 |
| `commission_records` | order_id, beneficiary_id, depth, rate, amount | 结算：70% 手续费池中分佣，1-3 代 7% / 4-10 代 2%（合计 35% 手续费，留存 65%） |

## 3. 状态机（持仓生命周期）

```
HOLDING(7天复利倒计时)
   → MATURED(账面价=本金×(1+r)^7, 可申请卖出)
       ├─ 校验 drama_balance ≥ 增长×85% → 扣占用 → READY_TO_LIST
       └─ 不足 → DAO_INSUFFICIENT(待补充: 需占用/可用/缺口) → 补足后重试
   READY_TO_LIST → LISTED(挂单价=账面×1.03, 可撤单回 READY_TO_LIST)
   LISTED → MATCHED(撮合成功, 买家60分钟 txid 核验窗口)
       ├─ 核验通过 → SOLD(瀑布结算 70/15/15, 占用释放, 积分 1:1 入账)
       └─ 超时未核验 → 申诉仲裁 / 自动回滚 LISTED
```

状态迁移全部走 **事件表 + 乐观锁**（`holdings.state` + `version`），禁止前端直改。

## 4. 账本设计（双账本分离）

### 4.1 Drama 账本（价值资产）
- 入账：入金确认 → `+amount`
- 出账：抢购手续费（场次 fee）→ `−fee`
- 冻结：卖出申请 → 占用 = 增长×85% 转入 `drama_frozen`；撤单/回滚释放
- 结算（SOLD 瀑布，以增长 G 为例）：
  - 手续费部分 = GMV×70%（平台收入，佣金从此池分）
  - 现金部分 = GMV×15%（USDT 直付买家→卖家）
  - 积分部分 = GMV×15% → 按 **1:1** 计入生态积分（来源A）
- **积分不可兑回 Drama/USDT**，账本层面无对应出账类型（硬约束）。

### 4.2 生态积分账本（权益积分）
- 来源A：交易产出（上条 15%），来源B：行为奖励（有预算上限，见待确认规则）
- 消费场景：商城兑换等（链下闭环）
- 审计口径：积分负债 = Σcredit_ledger；监控「积分兑付线」（兑付成本+0.1% → 平衡 GMV +15%）

## 5. API 设计（REST，核心 18 端点）

| 模块 | 端点 | 说明 |
|---|---|---|
| 认证 | `POST /auth/login`、`POST /auth/refresh` | 手机号/邮箱 + 区域检测（中国大陆拒绝服务） |
| 入金 | `GET /deposits/address?chain=` | 按用户生成专属充值地址 |
| | `POST /deposits` (txid) | 提交转账凭证，触发链上核验 job |
| | `GET /deposits/:id` | 确认数轮询（TRC-20≥19 / BSC≥15） |
| 场次 | `GET /sessions?zone=&date=` | 场次日历 + 档位 |
| | `POST /sessions/:id/reserve` | 抢购（幂等键 = user+session） |
| 持仓 | `GET /holdings` | 含状态、账面价、占用校验预览 |
| | `POST /holdings/:id/sell-intent` | 校验占用 → 冻结 → READY_TO_LIST |
| | `POST /holdings/:id/topup` | 补足缺口（DAO_INSUFFICIENT → 重试） |
| 市场挂单 | `GET /listings` | P2P 市场列表 |
| | `DELETE /listings/:id` | 撤单（解冻占用） |
| 撮合 | `POST /matches/:id/verify` (txid) | 买家付款凭证核验，60 分钟窗口 |
| | `POST /matches/:id/appeal` | 申诉仲裁 |
| 积分 | `GET /credits`、`GET /credits/ledger` | 余额 + 来源明细（A/B 标注） |
| 团队 | `GET /team/commissions`、`GET /team/tree?depth=10` | 返佣明细 + 10 级树 |
| 账本 | `GET /ledger/drama` | Drama 流水（含冻结/占用） |

**横切**：所有金额接口返回 `tabular` 字符串（防浮点误差，DB 用 `NUMERIC(18,2)`）；写操作全部走幂等键。

## 6. 异步任务（Workers/Jobs）

| Job | 触发 | 逻辑 |
|---|---|---|
| 链上确认轮询 | deposits.status=PENDING | 每 30s 查确认数，达标 → 入账 + 幂等 |
| 每日增长结算 | 每日 00:05 | 遍历 HOLDING：growth_event 追加 + 快照复利 |
| 到期扫描 | 每小时 | HOLDING 满 7 天 → MATURED |
| 核验超时扫描 | 每分钟 | MATCHED 超过 60min 未核验 → 申诉态 |
| 佣金结算 | SOLD 事件后 | 10 代物化路径分佣（1-3 代 7% / 4-10 代 2%） |

## 7. 风控与三生死线监控

| 监控项 | 指标 | 阈值 |
|---|---|---|
| 流动性线 | 净入金 / 现金收益支付 | ≥ 1.5（最重要） |
| 积分兑付线 | 积分负债 / 商城毛利 | 兑付成本 +0.1% → 平衡 GMV +15% |
| 财务线 | 月净贡献（≈0.75%×GMV）vs 月固定 80 万 USDT | 平衡点月 GMV ≈ 1.07 亿 |

其余：txid 唯一索引防重复核验、假币白名单合约校验、`region` 区域屏蔽、占用冻结账实核对 job（每日 `Σfrozen` vs `Σledger`）。

## 8. 依赖待拍板项（来自 V2.1 §14，阻塞开发的标 ⛔）

- ⛔ 档位 300–1,000 费率（影响 sessions 表初始数据）
- ⛔ 来源B（行为奖励）发放上限与规则
- 普通区场次完整排期（当前仅定 16:00 场）
- 提现冷钱包审批链路 SLA
- 其余规则见《DramaX_商业逻辑总结_V2.1_合并版.md》§14
