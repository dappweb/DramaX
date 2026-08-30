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

## 部署（✅ 2026-08-29 已上线 Cloudflare）

**线上地址**：
- API：https://dramax-api.dappweb.workers.dev（/health 200，/auth/nonce + /admin/auth/nonce 均验证通过）
- 移动端：https://dramax-mobile.pages.dev（Pages 项目 dramax-mobile）
- Admin：https://dramax-admin.pages.dev（Pages 项目 dramax-admin）

**已创建资源**：D1 `dramax`（id 2ad552ed…，17 表 + kv 表）、KV `INTENTS`、Queues `dramax-chain-events`(+dlq)、secrets JWT_SECRET / BSC_RPC_URL（公共端点 bsc-dataseed）/ ADMIN_INITIAL_PASSWORD。

**KV → D1 迁移（0002_kv_to_d1.sql）**：账号免费版 KV 写配额（1,000/天，账号级共享）被其他项目 cron 打满，
nonce put 失败导致登录 500 → nonce/支付意图/扫描游标全部改落 D1 `kv` 表（kvPut/kvGet/kvDel/kvSweep，util.ts）。
构建注入：`NEXT_PUBLIC_API_BASE=https://dramax-api.dappweb.workers.dev npm run build`（Pages 部署 out/）。

**已知限制**：
1. **Cron 未启用 → GitHub Actions 替代（✅ 2026-08-30）**：账号免费版 cron 配额 19/5 超限。Indexer 触发走
   `.github/workflows/indexer.yml`（schedule */5 + workflow_dispatch，GHA 侧 curl `POST /internal/cron`，
   `x-internal-token` = repo secret `DRAMAX_CRON_TOKEN`；public 仓库免费无限量，Mac 关机也照跑）。
   `/internal/*` 豁免区域屏蔽；INTERNAL_CRON_TOKEN secret 未配置时端点 503 关闭。
   本机 launchd（com.dramax.indexer，60s）作为备份仍在跑，直连 workers.dev 需本机代理在线，否则 curl 超时无害。
   Workers Paid（$5/月）后可改回原生 Cron。GHA 实际调度常有 3~10 分钟延迟：支付确认延迟 = 调度延迟 + 15 确认 ≈ 45s。
   **BSC RPC 选型坑**：bnb 官方 dataseed（主/测试网）对 eth_getLogs 一律返回 -32005 limit exceeded（单块也拒）；
   publicnode(allnodes) 按 IP 限流，Cloudflare Workers 共享出口 IP 被限。**现用：主网 NodeReal demo key、
   测试网 bsc-testnet-rpc.publicnode.com**（均 secret 注入；生产正式放量前建议注册 NodeReal/dRPC 免费 key 换掉 demo key）。
2. **自定义域未绑**：dramax.ai 域名未接入此 CF 账号（现有 zone：dappweb.ai 等 9 个）。临时用 pages.dev 域，
   ALLOWED_ORIGIN/TURNSTILE_HOSTNAMES 已包含 pages.dev；域名接入后加 CNAME 指向 Pages 项目即可。
3. **BLOCKED_COUNTRIES = "CN"**：大陆访问返回 451（合规设计）；自测需挂代理（/internal/* 豁免）。
4. ~~PLATFORM_ADDRESSES 未配置~~ ✅ 已配置 0xb7940a57…9e09（owner 钱包，用户充值 USDT 归集）；ADMIN_OWNER_WALLET 同地址已配。
5. **SIWE 真实签名 E2E 已通过（✅ 2026-08-30）**：`scripts/siwe-e2e.mjs`（一次性钱包 → nonce → EIP-4361 签名 → 登录 →
   JWT 鉴权读 /holdings /listings → refresh → nonce 重放 401 → 无 token 401，9 项全 PASS）。
   复跑：`cd 10_工程代码/scripts && node siwe-e2e.mjs`（node_modules symlink 已建，指 workers-api 依赖）。
   种子挂单实际 ID 为 demo-l1/demo-l2（挂价 15201.24 / 945.90，demo-h4/h5 为历史误记）。
   mobile/admin testnet 页面渲染正常（Playwright 快照验证；未连接钱包时主体留白为设计行为，console 仅 favicon 404）。
6. **全业务链路 E2E 已通过（✅ 2026-08-30）**：`scripts/business-e2e.mjs`（场次 → 预约负向 402/401/400 → 只读账户端点 →
   撮合种子挂单 → P2P 支付意图 → Admin 负向 401/403，17 项）。GHA 双 workflow 执行：`.github/workflows/e2e.yml`
   （workflow_dispatch，runner 直连 workers.dev；本机 workers.dev 被墙时用它跑）+ smoke。run 33293631893：28 项全 PASS。
   **顺带修复 4 个真 bug（testnet + 生产均已部署）**：
   ① reserve 手续费单位错配（feeFor 元 vs toCents 分，fee>0 场次永远 fee mismatch）；
   ② match INSERT 漏 NOT NULL 列 payee_addr/salt_amount 必 500（现撮合时预生成收款地址+盐，intent 复用同 payee/盐）；
   ③ 支付超时 EXPIRED 死代码：ISO 时间（"…T…Z"）与 datetime('now')（"… …"）字符串比较 'T'>' ' 恒假，
      超时释放/回滚从未生效（现统一绑 ISO 参数；同时把回滚移到链上扫描之前，RPC 故障不阻塞）；
   ④ EXPIRED 只置 matches 不回滚 listings/holdings（卡死 MATCHED，现三条 SQL 原子恢复）。
   payment_intents 过期检查同步修（原 expires_at > datetime('now') 恒真，过期盐仍可匹配入账——安全隐患）。
7. **Admin 管理链路 E2E 已通过 + e2e 定时化（✅ 2026-08-30）**：business-e2e.mjs 追加 Admin 段（密码登录 401/200 →
   dashboard → 剧本 DRAFT→submit→LISTED（跳步 409、无版权哈希 400 负向）→ 建场次（时间规则 400 负向、fee=75.00）→
   用户端可见新场次 → audit-logs 断言）。密码经 repo secret `DRAMAX_E2E_ADMIN_PASS` 注入（testnet D1 直插 e2e-admin 行）。
   run 33295009580：SIWE 11 + Business/Admin 17 项全 PASS。e2e.yml 现每 2 小时 schedule 自动跑（cron 17 */2 * * *），
   步骤含「先 POST /internal/cron 释放过期撮合」；连续手动 dispatch 撞 15min 撮合窗口时自动 SKIP 撮合段。
   顺带修 2 个 bug：⑤ admin 建场次 fee 又见元/分错配（fmt(元)→"0.75"，改 toFixed(2)）；
   ⑥ /admin/audit-logs 返回 D1Result 而非数组。

## BSC Testnet 演示环境（✅ 2026-08-29 已部署，chainId 97）

**线上地址**：
- API：https://dramax-api-testnet.dappweb.workers.dev（env=testnet，chain 97，testnet USDT）
- 移动端：https://dramax-mobile-testnet.pages.dev
- Admin：https://dramax-admin-testnet.pages.dev

**资源**：D1 `dramax-testnet`（id 466f37be…，18 表 + 演示数据）、复用主 KV、Queues `dramax-chain-events-testnet`(+dlq)、
secrets JWT_SECRET / BSC_RPC_URL（bsc-testnet-rpc.publicnode.com）/ ADMIN_INITIAL_PASSWORD / INTERNAL_CRON_TOKEN。
vars：CHAIN_ID=97、USDT_CONTRACT=0x3376…6c7（testnet USDT）、CHAIN_CONFIRMATIONS=5、
PLATFORM_ADDRESSES=0xb7940a57d5fb0288776f95047467e3d72eed9e09、BLOCKED_COUNTRIES=""（演示不屏蔽）。

**演示数据（0003_seed_testnet_demo.sql）**：owner 管理员（0xb794…）+ 3 个演示用户（余额 5000/12000/3000）+
6 个剧本（LISTED×4：闪婚老公是首富 300 / 重生之商界女王 500 / 隐世神医在都市 400 / 千亿婚宠 600；REVIEWING / DRAFT 各 1）+
6 个场次（普通区×3、创新区×3，含 1 个 CLOSED 满员）+ 6 个持仓 + 2 个挂单 + 3 条增长流水。

**演示流程**：钱包切 BSC testnet（水龙头 https://testnet.bnbchain.org 领 testnet BNB/USDT）→
移动端连接钱包 SIWE 登录 → 浏览市场挂单/场次；Admin 用 owner 钱包（0xb794…）登录管理剧本与场次。

**部署命令**：worker `npm run deploy:testnet`（= `wrangler deploy -e testnet`）；
前端 `npm run deploy:testnet`（= 注入 NEXT_PUBLIC_CHAIN_ID=97 + API base 后构建并部署 Pages）。

## 下一迭代（按优先级）

1. ~~SIWE 验签接 viem + bcrypt 管理员登录~~ ✅ 已实现（tsc --strict 0 错误 + 真钱包签名冒烟 5 项 PASS）：
   SIWE = parseSiweMessage(nonce/domain/address 一致性) + recoverMessageAddress 签名恢复（本地验证，登录路径无 RPC 依赖），nonce 改为字母数字；
   admin = bcryptjs compare，bootstrap 首登自愈固化哈希
2. ~~卖出/挂单/撮合/积分/团队路由~~ ✅ 已实现（src/trading.ts，tsc --strict 0 错误）：sell-intent 冻结占用 / topup 缺口生成支付意图 / 挂单·撤单（CAS 解冻）/ 撮合 15min 窗口 / settleMatch 瀑布结算+10 代返佣记账 / credits·team·ledger 只读
3. ~~apps/mobile~~ ✅ 已实现（Next.js 14 静态导出 + wagmi/viem）：钱包连接 → SIWE 登录 → 场次抢购 → 持仓全状态机（卖出意向/补足占用/挂单）→ 市场撮合 → PaymentSheet USDT 直付（盐值金额 + 轮询 15 确认入账）。构建：`cd apps/mobile && npm install && npm run build`，产物 out/ 部署 Pages（`npm run deploy`）；`NEXT_PUBLIC_API_BASE` 指向 Workers API
4. ~~apps/admin~~ ✅ 已实现（Next.js 14 静态导出，无 wagmi——EIP-1193 直连 + viem SIWE）：钱包登录（owner 自举）→ 剧本管理（新建/提交/审核上架/下架，状态过滤）→ 场次创建（普通区 16:00 · 创新区周二四六 15:00&17:00 校验）→ 看板与参数（经济常量只读 + 档位表）→ 操作日志（audit_log）。构建 93.6 kB First Load；部署 `npm run deploy`（Pages 项目 dramax-admin）
5. ~~Turnstile 代码接线 + 区域屏蔽~~ ✅ 已实现（服务端 siteverify fail-closed + mobile/admin Turnstile 组件随登录提交 token + 失败换新题 + `request.cf.country` 451 中间件；sitekey/secret 未配置时 dev 自动跳过）；**widget 创建待用户创建 `Account.Turnstile:Edit` API token**；超额支付处理策略（待拍板）落 consumer；持仓转移语义（买家新 HOLDING / 重置周期）待拍板

