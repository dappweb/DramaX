# DramaX 工程代码（monorepo）

> BSC 单链 + Cloudflare 全栈。依据《07_技术设计/Cloudflare部署技术方案》《技术架构设计 V1.0》搭建。
> 状态：**核心逻辑 + 认证安全已实现**——支付意图/盐值、抢购入账、Indexer、入账引擎、Admin 状态机、
> SIWE 验签（viem）、bcrypt 管理员登录均落地；待真实环境联调（D1/KV/Queue 资源创建 + BSC RPC secrets）。

## 结构

```
├── package.json              # pnpm workspace 根 + content:deploy 流水线
├── pnpm-workspace.yaml
├── packages/shared/          # 业务规则单一事实源（★ 最重要的包）
│   └── src/index.mjs         # 链常量/档位/复利/占用/拆分/返佣/场次校验/金额盐/账本校验链/自检
└── apps/workers-api/         # Cloudflare Workers API（Hono）
    ├── wrangler.toml         # D1/KV/Queues/Cron 完整绑定
    ├── src/index.ts          # 认证+支付意图+抢购入账+Indexer+入账引擎（已实现）
    ├── src/admin.ts          # Admin 钱包登录(SIWE)+密码后备+剧本四态状态机+audit_log（已实现）
    ├── src/trading.ts        # 卖出/挂单/撮合/积分/团队/账本 + settleMatch 结算（已实现）
    ├── src/util.ts           # 整数分金额运算 / 零依赖 HS256 JWT / BSC JSON-RPC / SIWE 验签
    └── migrations/0001_init.sql  # 16 表 DDL（账本只追加 + tx_hash 幂等）
└── apps/mobile/              # 移动端 H5 DApp（Next.js 14 静态导出 + wagmi/viem）
    ├── next.config.mjs       # output:export → out/ → Cloudflare Pages
    └── src/                  # 4 Tab：首页(场次/抢购) · 市场(挂单/撮合) · 持仓(全状态机) · 我的(充值/返佣/积分)
        ├── lib/              # wagmi(BSC+injected) / api 客户端 / SIWE 登录
        └── components/       # Shell(钱包连接+SIWE 登录门) / PaymentSheet(USDT 直付+轮询入账) 等
```

## 已实现的核心流程

| 流程 | 实现 |
|---|---|
| SIWE 登录 | nonce(KV TTL 5min) → viem 验签（parseSiweMessage 字段校验 + recoverMessageAddress 签名恢复，domain 锚定 ALLOWED_ORIGIN）→ 单次有效焚毁 nonce → 签发 HS256 JWT |
| Admin 登录 | **钱包登录（主路径）**：GET /admin/auth/nonce → POST /admin/auth/login（同一 SIWE 验签路径）→ admins.wallet 匹配 → 签发 admin JWT；ENV `ADMIN_OWNER_WALLET` 配置的 owner 钱包首登自举建档（role=owner）。密码登录保留为后备（bcrypt） |
| 支付意图 | orderId 盐值（哈希分位，冲突重试 5 次）+ KV TTL 30min + D1 审计副本 |
| 抢购入账 | D1 batch 原子：余额 CAS + 容量守卫 + 预约 + 持仓 + 两行账本（本金/手续费） |
| Indexer | 每分钟增量 eth_getLogs（安全深度内 ≤500 块）→ 盐值反查 intent → 入队 |
| 入账引擎 | Queue：确认数 ≥15 → reorg 块哈希校验 → D1 batch（事件/意图/入金/账本/余额 CAS） |
| 超时/到期 | 广播窗口 15min PAYING→EXPIRED；HOLDING 满 7 天→MATURED |
| Admin 剧本 | DRAFT→REVIEWING→LISTED→REMOVED 全守卫（409 非法流转/400 校验失败）+ 四要素审计 |
| 上架校验 | 版权哈希 64 位十六进制必填 + 定价落在非待确认档位 |

## 快速开始

```bash
pnpm install
pnpm test                 # 业务规则自检（QA 基准数字，已验证 ALL OK）
# Workers 本地开发
cd apps/workers-api
wrangler d1 execute dramax --local --file=./migrations/0001_init.sql
wrangler dev
```

类型检查（无需 pnpm install，临时挂 node_modules 即可）：
```bash
# node_modules 来源：~/.workbuddy/binaries/node/workspace/dramax-deps（viem/bcryptjs/tsc + 链接 hono/@cloudflare）
ln -sfn <deps>/node_modules apps/workers-api/node_modules
node_modules/.bin/tsc --noEmit --strict --target es2022 --module esnext --moduleResolution bundler \
  --types @cloudflare/workers-types --skipLibCheck \
  src/index.ts src/admin.ts src/trading.ts src/util.ts src/shared.d.ts   # 当前 0 错误
```

⚠️ SIWE 关键坑（已修）：EIP-4361 nonce 仅允许字母数字（viem 正则 `[a-zA-Z0-9]+`），
**不要用 randomUUID**（连字符导致 parseSiweMessage 丢字段）；消息字段必须是 `Chain ID:`（大写 D）。

## 部署

根目录 `pnpm content:deploy`（test → lint → build → wrangler deploy → verify-live）。
**严禁直接 push。** 首次部署前：`wrangler d1 create dramax`、`wrangler kv namespace create INTENTS`、
`wrangler queues create dramax-chain-events`（+dlq），把 id 填入 `wrangler.toml` TODO 处；
secrets 用 `wrangler secret put` 注入（JWT_SECRET / BSC_RPC_URL / ADMIN_INITIAL_PASSWORD）；
`PLATFORM_ADDRESSES` 写入平台归集地址池（vars）；`ADMIN_OWNER_WALLET` 填 owner 钱包地址（Admin 钱包登录自举）。

## 下一迭代（按优先级）

1. ~~SIWE 验签接 viem + bcrypt 管理员登录~~ ✅ 已实现（tsc --strict 0 错误 + 真钱包签名冒烟 5 项 PASS）：
   SIWE = parseSiweMessage(nonce/domain/address 一致性) + recoverMessageAddress 签名恢复（本地验证，登录路径无 RPC 依赖），nonce 改为字母数字；
   admin = bcryptjs compare，bootstrap 首登自愈固化哈希
2. ~~卖出/挂单/撮合/积分/团队路由~~ ✅ 已实现（src/trading.ts，tsc --strict 0 错误）：sell-intent 冻结占用 / topup 缺口生成支付意图 / 挂单·撤单（CAS 解冻）/ 撮合 15min 窗口 / settleMatch 瀑布结算+10 代返佣记账 / credits·team·ledger 只读
3. ~~apps/mobile~~ ✅ 已实现（Next.js 14 静态导出 + wagmi/viem）：钱包连接 → SIWE 登录 → 场次抢购 → 持仓全状态机（卖出意向/补足占用/挂单）→ 市场撮合 → PaymentSheet USDT 直付（盐值金额 + 轮询 15 确认入账）。构建：`cd apps/mobile && npm install && npm run build`，产物 out/ 部署 Pages（`npm run deploy`）；`NEXT_PUBLIC_API_BASE` 指向 Workers API
4. ~~apps/admin~~ ✅ 已实现（Next.js 14 静态导出，无 wagmi——EIP-1193 直连 + viem SIWE）：钱包登录（owner 自举）→ 剧本管理（新建/提交/审核上架/下架，状态过滤）→ 场次创建（普通区 16:00 · 创新区周二四六 15:00&17:00 校验）→ 看板与参数（经济常量只读 + 档位表）→ 操作日志（audit_log）。构建 93.6 kB First Load；部署 `npm run deploy`（Pages 项目 dramax-admin）
5. Turnstile 接入 + WAF 区域屏蔽规则下发；超额支付处理策略（待拍板）落 consumer；持仓转移语义（买家新 HOLDING / 重置周期）待拍板

