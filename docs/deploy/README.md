# 部署指南

> **当前状态（M6a，2026-11-18）：还不能上线。** 阿里云短信与 OSS 适配器已写（用假服务测试，**没有对真实服务联调**）；百炼 AI 适配器也已写（M6b，假 fetch 测试，**未对真实模型联调、未评测**）。所以代码层面生产配置可以装配，但在真实服务上跑通之前不能上线（见 §1）。本文把已验证的部分、没验证的部分和上线前必须做的事分开写。
> 图例同 [验证矩阵](../verification-matrix.md)：✅ 本机真实运行验证 ｜ 🧪 仅模拟 ｜ ⏳ 需要真实环境/真机。
> 合规与备案见 [icp-and-compliance.md](./icp-and-compliance.md)；剩余限制见 [../limitations.md](../limitations.md)。

## 1. 先看这三个事实

1. **生产模式的启动保护（✅）**：`NODE_ENV=production` 且 `APP_MODE=demo` 时 Web 与 worker 拒绝启动；`APP_MODE=production` 时模拟 AI/短信/存储、开发登录、示例或不足 32 字符的密钥都会被拒绝（`src/lib/env.ts`，单元测试 12 项）。
2. **真实适配器的状态（⏳）**：短信（`src/server/sms/aliyun.ts`）、OSS（`src/server/storage/oss.ts`）、百炼（`src/server/ai/bailian.ts`）适配器都已写，单测通过（短信与 OSS 另有“真实官方 SDK 对本地假服务”的接线测试），**但全部没有对真实服务联调过，百炼的提示词也没有评测过**。`container.ts` 现在不再抛“尚未实现”。M5c 实测（当时三个适配器都没写）：按生产模式、全部真实提供方、完整环境变量启动，`GET /api/health` 返回 200，而页面返回 500。**所以健康检查通过不代表应用可用**；适配器已写之后，装配或凭据错误仍然是第一次使用时才暴露，不是启动即失败（改成启动即失败是行为变更，需要你确认）。
3. **演示模式不能放进生产环境**：容器里 `NODE_ENV=production`，此时 `APP_MODE=demo` 会拒绝启动。需要在线演示时应单独部署一套 `NODE_ENV=development` 的环境，并明确标注，不能连真实用户数据。

## 2. 镜像（⏳ 未在 Docker 里构建过）

[Dockerfile](../../Dockerfile) 是一个镜像、两个启动命令：

| 进程 | 命令 | 说明 |
|---|---|---|
| Web | `npm start`（镜像默认） | 端口 3000；探测 `GET /api/health`（只证明进程活着，**不检查数据库**） |
| Worker | `npm run worker` | 没有 HTTP 端口；启动时若库未就绪会每 2 秒重试至多 60 次 |
| 迁移（一次性） | `npm run db:deploy` | `prisma migrate deploy`；发版时**先于** Web/Worker 执行 |
| 创建管理员（一次性） | `npm run admin:create -- <手机号>` | 之后用验证码登录；生产没有演示登录 |

本机没有 Docker，所以镜像**没有构建过**。已验证的是镜像背后的每一步（2026-11-18）：
- ✅ `next build` 在没有 `.env`、没有 `DATABASE_URL` 的环境下通过（构建阶段不校验运行时变量，见 `src/instrumentation.ts`）。
- ✅ `next start` 在生产模式下启动、`/api/health` 返回 `{"status":"ok"}`。
- ✅ `npm run worker`、`prisma migrate deploy`、`npm run admin:create` 在开发库实测过（M0–M1）。
- ⏳ `npm ci` 在干净环境、Debian slim 基础镜像、非 root 用户下的行为；镜像体积；Prisma 引擎在该基础镜像上的兼容性。
- 没有使用 Next 的 `output: "standalone"`：worker（tsx 直接跑源码）与迁移（prisma CLI）要完整依赖，拆成两个镜像省不了多少，只多一份要维护的 Dockerfile。

首次构建请这样自查：
```bash
docker build -t relationship:local .
docker run --rm relationship:local node -v          # 期望 v24.x
docker run --rm relationship:local id                # 期望 uid=1000(node)，不是 root
docker run --rm -e NODE_ENV=production -e APP_MODE=demo -e DATABASE_URL=postgresql://x \
  -e AUTH_SECRET=x -e PHONE_HMAC_KEY=x -e PHONE_ENC_KEY=x relationship:local npm start
# 期望：启动阶段报“生产环境（NODE_ENV=production）不允许 APP_MODE=demo”并退出
```

## 3. 环境变量

校验规则全部在 `src/lib/env.ts`；`.env.example` 与本表必须与代码一致（单元测试 `tests/unit/config-drift.test.ts` 守卫变量名）。

| 变量 | 生产要求 | 说明 |
|---|---|---|
| `NODE_ENV` | `production` | 镜像已设定 |
| `APP_MODE` | `production` | 未设置时默认按生产处理；`demo` 在生产环境被拒绝 |
| `DATABASE_URL` | 必填 | 托管 PostgreSQL。开发/测试用 PostgreSQL 18（embedded-postgres）；**托管库版本与权限需核实 ⏳**（pg-boss 需要能创建 `pgboss` schema 与表） |
| `AI_PROVIDER` | `bailian` | 适配器未实现 |
| `STORAGE_PROVIDER` | `oss` | 适配器未实现 |
| `SMS_PROVIDER` | `aliyun` | 适配器未实现 |
| `DEV_LOGIN_ENABLED` | 不得为 `true` | 仅 demo 模式有效 |
| `STORAGE_LOCAL_DIR` | 不使用 | 仅本地模拟存储；Web 与 worker 必须指向同一目录，所以本地存储不能用于多容器 |
| `TRUSTED_PROXY_HOPS` | 按实际层数 | 见 §5 |
| `AUTH_SECRET`、`PHONE_HMAC_KEY`、`PHONE_ENC_KEY` | 各 ≥32 字符、不得含 dev-only/change-me/example/placeholder | `openssl rand -hex 32`。**`PHONE_HMAC_KEY` 与 `PHONE_ENC_KEY` 一旦使用就不能更换**：更换后已有手机号无法匹配/解密，需要迁移方案（未实现） |
| `DASHSCOPE_API_KEY` | AI 为 bailian 时必填 | 百炼密钥 |
| `DASHSCOPE_TEXT_MODEL`、`DASHSCOPE_VISION_MODEL` | AI 为 bailian 时必填 | 文本（分析）与视觉（截图识别）模型名。**代码里没有默认值**：请在百炼控制台核实当前可用、适合的模型后填写；模型名会写入用量记录与分析快照。更换模型后应重新评测 |
| `DASHSCOPE_BASE_URL` | 可选 | 覆盖 OpenAI 兼容接口地址，默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`（**凭记忆写入，未核实 ⏳**）。生产模式必须是 https |
| `ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET` | OSS 或短信时必填 | 建议 RAM 子账号、最小权限（见 §6） |
| `OSS_BUCKET`、`OSS_REGION` | OSS 时必填 | 私有桶 |
| `SMS_SIGN_NAME`、`SMS_TEMPLATE_CODE` | 短信时必填 | 签名与模板需先通过运营商审核 |
| `SMS_TEMPLATE_PARAM_NAME` | 可选，默认 `code` | 审核通过的模板里验证码变量的名字（模板是 `${code}` 就填 code）；与模板不一致时短信会发不出去 |

密钥只走环境变量/平台的密钥管理，不写进镜像、不进仓库（`.dockerignore` 已排除 `.env*`）。校验失败的报错不含取值。

## 4. 拓扑

```
用户 → [SLB/CDN/反向代理：HTTPS、追加 X-Forwarded-For] → Web 容器(s)
                                                         ↘
                                          托管 PostgreSQL ← Worker 容器（建议先单副本）
                                          OSS（私有桶）   百炼  短信
```
- **Worker 先单副本**：pg-boss 设计上支持多个 worker，但本项目没有测过多副本并发（定时清理任务、认领语义），**⏳ 未验证**，上线先用 1 个。
- **Web 可多副本**的前提是存储用 OSS（本地存储是单机目录）。会话在数据库里，不依赖粘性会话；限流在数据库里（PG 表 + advisory lock）。
- 区域：阿里云中国大陆（产品方案 D 系列既定）；跨境传输不在设计内。

## 5. 反向代理与 IP 限流（⏳）

- 必须部署在会**向 `X-Forwarded-For` 右侧追加真实客户端 IP** 的代理/负载均衡之后，并把 `TRUSTED_PROXY_HOPS` 设为代理层数（直连 SLB 一般为 1，前面再套 CDN 则为 2；**以实际抓包为准**，不要照抄）。
- 填 0（默认）时不信任该头，所有请求共用一个 IP 限流桶：不会被伪造绕过，但会让一个人的行为限制所有人。填得比实际层数大则可能被伪造头绕过限流。
- 必须终止 TLS；应用本身不处理 HTTPS。会话 Cookie 在 `NODE_ENV=production` 时带 Secure 属性（`src/server/session.ts`），因此**生产必须走 HTTPS，否则浏览器不会带回 Cookie、无法登录**；HSTS 等安全响应头本项目没有设置，需在代理层加 ⏳。

## 6. 数据与存储

- **迁移**：`prisma/migrations` 是唯一的建表来源，发版先 `npm run db:deploy`。迁移只向前；没有写回滚脚本。涉及 `ALTER TYPE ... ADD VALUE` 的迁移（M5a）在部分托管库版本里不能与其他语句同事务，需在目标库先试 ⏳。
- **备份与恢复 ⏳**：托管库的备份策略、保留周期、恢复演练都**未核实**。**恢复备份会让已删除的数据复活**：账户删除只保证在线数据，因此恢复后必须重放删除记录——目前审计只留“用户 ID 已删除”，没有自动重放工具（限制，见 limitations §隐私）。
- **OSS**：私有桶；原图只通过短时签名链接访问；历史版本（版本控制）开关、服务端加密、生命周期规则 ⏳ 待核实。建议 RAM 子账号仅授予该桶的读写删权限。
- **加密（有意识的风险接受）**：手机号用 HMAC 索引 + 应用层加密；**聊天正文不做应用层加密**（需要用于分析），依赖托管库与 OSS 的静态加密。需要在部署前确认库和桶确实开启了静态加密 ⏳。
- **日志**：应用日志不含聊天正文、验证码、密钥（设计与代码约束，未做自动扫描）；保留 30 天是策略目标，需要在日志服务里配置 ⏳。

## 7. 上线前检查清单（每项都要有人勾）

**代码/配置**
- [ ] 真实适配器已写并通过联调：百炼视觉、百炼文本（须上报 token：`ctx.reportUsage`，否则成本页显示“无法估算”）、阿里云短信、OSS。
- [ ] `config/cost.json` 填入已核实的单价并把 `pricesVerified` 改为 `true`。
- [ ] 真实模型评测完成（见 [最终评测报告](../evals/final-ai-eval-report.md) §5），再决定评分规则是否转 `active`。
- [ ] 同意文案里“服务商留存条件尚未核实”核实后才可改写（改写须升 `CONSENT_VERSION` 评估）。

**环境**
- [ ] 三个密钥各自随机生成并备份到安全位置（丢失 `PHONE_*` 密钥 = 无法识别老用户）。
- [ ] `TRUSTED_PROXY_HOPS` 已按实际层数核对。
- [ ] 数据库、OSS 静态加密、备份、日志保留已核实。
- [ ] 首个管理员已创建；确认生产登录页没有“演示登录”按钮、没有“演示模式”横幅。

**合规**（见 [icp-and-compliance.md](./icp-and-compliance.md)）
- [ ] ICP 备案完成；短信签名与模板通过审核；法务确认了“待核实”清单。

**验收**
- [ ] 手机端与微信内置浏览器真机验收通过（[清单](../acceptance/mobile-wechat-checklist.md)）。
- [ ] 一次完整的“注册 → 导入 → 分析 → 导出 → 删除账户”演练，并在库里确认数据已清空。

## 8. 运维要点

- 后台页：任务状态（卡住 >15 分钟的任务）、成本、用户反馈、审计（只读，无内容）。**没有告警**：需要自己接监控（例如盯 `/admin/tasks` 的卡住数或直接查库）。
- worker 在写回结果与额度结算之间崩溃，依赖 15 分钟清扫任务退还额度；账户删除中断时每 5 分钟清扫继续。
- 应急：会话令牌存在数据库里（`AUTH_SECRET` 目前只用于派生本地模拟存储的文件签名密钥，**不**签发会话），所以更换它不会让会话失效；要让全部会话失效只能清空会话表，目前没有后台按钮。`PHONE_*` 密钥不要动。
