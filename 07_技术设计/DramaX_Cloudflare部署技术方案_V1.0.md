# DramaX Cloudflare 部署技术方案 V1.0

> 决策：全栈 Cloudflare（Pages + Workers + D1/KV/Queues/R2），BSC 单链上线，移动端 H5 DApp + Admin 端。
> 日期：2026-08-29

---

## 1. 总体架构

```
                    Cloudflare 边缘
┌──────────────────────────────────────────────────────────┐
│  WAF：中国大陆 region 拦截 + Bot 管理 + Turnstile 防刷      │
│                                                          │
│  Pages(静态导出)          Workers(Hono API)                │
│  ├─ 移动端 H5 DApp  ────→ ├─ /auth（SIWE 验签 + JWT）      │
│  └─ Admin端(独立项目) ──→ ├─ /payments（支付意图/状态）      │
│                           ├─ /sessions /holdings /listings │
│                           ├─ /credits /team /ledger        │
│                           └─ /admin（owner 登录/剧本上架）   │
│                                                          │
│  D1(业务主库)   KV(意图/会话)   Queues(事件削峰)   R2(封面)  │
│  Cron Triggers + Workers Indexer（轮询 BSC getLogs）        │
└──────────────────────────────────────────────────────────┘
                         │
                    BSC RPC（官方 USDT 合约 Transfer 事件）
```

## 2. 技术选型清单

| 层 | 选型 | 理由 |
|---|---|---|
| 移动端 H5 | **Next.js 14 App Router 静态导出 → Cloudflare Pages** | 钱包交互全在客户端（wagmi + viem），静态导出零 SSR 负担；与 metachina.ai 同款管线（wrangler 部署，团队已验证） |
| Admin 端 | **独立 Pages 项目**（同 Next.js 静态导出） | 与用户端物理隔离，WAF 规则单独配（admin 路径可加 Access/IP 白名单） |
| API | **Workers + Hono**（TypeScript） | Workers-native、路由轻量、中间件生态（JWT/CORS）成熟 |
| 业务主库 | **D1**（SQLite） | P0 单库强一致；账本表只追加 + batch 原子写；NUMERIC 用 `TEXT` 存字符串金额（防浮点）；预留 Hyperdrive + Postgres 升级路径（账本量级上来后迁 Neon） |
| 支付意图/会话 | **KV**（TTL 30min / JWT 黑名单） | 原生 TTL 匹配意图生命周期 |
| 链上事件处理 | **Queues** | Indexer 拉到 Transfer 事件 → 入队 → 入账引擎消费，削峰 + 重试 + 幂等（tx_hash 唯一索引兜底） |
| Indexer | **Workers + Cron Triggers（每 30s）** | Workers 无长连接订阅 → Cron 轮询 `eth_getLogs`（15 确认 ≈45s，30s 轮询满足时效）；每次按 last_scanned_block 增量拉取 |
| 定时任务 | **Cron Triggers** | 每日增长结算（00:05）、到期扫描（每小时）、支付广播超时扫描（每分钟）、每日三方对账 |
| 素材存储 | **R2** | 剧本封面/预告素材，零出口流量费 |
| 防刷 | **Turnstile** | Admin 登录 + 抢购接口前置 |
| 区域屏蔽 | **WAF Custom Rule**（country ≠ 允许名单 → 403 拦截页） | 中国大陆 9.24 合规硬约束，边缘层直接执行，零代码 |
| 密钥 | wrangler secrets（BSC RPC key、JWT secret、owner 初始凭证） | 不入库不入仓 |

## 3. 关键实现要点

### 3.1 前端（两套 Pages 项目）
- monorepo（pnpm workspace）：`apps/mobile`、`apps/admin`、`apps/workers-api`。
- wagmi/viem 做 BSC 链交互（chainId 56 硬编码 + `wallet_switchEthereumChain` 引导）；SIWE 签名 → Workers `/auth/verify` 验签换 JWT。
- 静态导出 `next export`（output: 'export'），`wrangler pages deploy`；部署流程沿用 `pnpm content:deploy`（ship check + lint + build + wrangler deploy + verify-live），**严禁直接 push**。

### 3.2 Indexer（Workers Cron）
```
Cron 30s：
  1. eth_getLogs(fromBlock=last_scanned+1, address=USDT, topic=Transfer)
  2. 过滤 to ∈ (平台归集地址池 ∪ 卖家收款地址池)
  3. 写 chain_events(status=PENDING, tx_hash 唯一索引 → 冲突即跳过)
  4. Queue.enqueue(eventId)
Consumer：
  1. 等待 15 确认（查 block number 差值）
  2. 金额盐/合约事件反查 payment_intent → 订单
  3. D1 batch 原子入账（双账本 + 状态机推进）
```
- D1 batch = 原子事务，保证「账本 + 余额 + 状态」三表一致性。
- reorg：`chain_events.block_hash` 变化检测 → 回滚未入账事件并告警。

### 3.3 Admin 端（owner 上架剧本）
- 独立 Pages 项目 + 独立 Workers 路由（`/admin/*`），owner 账号密码 bcrypt + Turnstile + 可选 TOTP。
- 剧本上架状态机：草稿 → 待审核 → 已上架（进场次销售池）→ 已下架；全部操作写 audit_log（D1）。
- 上架校验：字段完整 + 版权哈希（SHA-256）必填 + 定价落在档位区间。

## 4. 环境与域名规划

| 环境 | 域名 | 说明 |
|---|---|---|
| 生产 | m.dramax.ai（移动端）/ admin.dramax.ai（Admin）/ api.dramax.ai（Workers） | WAF 区域屏蔽作用于全部域名 |
| 预发 | preview-*.pages.dev | CI 自动预发 |
| RPC | 自建/QuickNode BSC 端点（secrets 注入） | 禁止用公共免费 RPC 跑生产 Indexer |

## 5. 与 KolMarket 经验复用
- wrangler 部署管线、Workers Cron 轮询模式（judgment runner 同款）、multisig 治理、D1/KV/Queues 组合均已在 kolmarket.ai 验证过，直接复用运维经验。
- 差异点：DramaX 账本一致性要求更高 → D1 batch 原子写 + 每日三方对账 Job + Hyperdrive/Postgres 升级预案。

## 6. 限制与对策

| Cloudflare 限制 | 对策 |
|---|---|
| Workers CPU 时间（付费版 ≤30s） | Indexer 只做 getLogs + 入队，重活在 Queue Consumer |
| D1 无长事务 | batch 原子批次 + 账本只追加设计 |
| Workers 无 WebSocket 长连接（Indexer 场景） | Cron 30s 轮询 getLogs，时效够用 |
| 静态导出无 SSR/ISR | 全部数据客户端拉 API；SEO 需求 P0 不存在（合规区屏蔽） |
