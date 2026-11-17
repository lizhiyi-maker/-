# 关系工作台（MVP）

私人关系分析与对象对比网站。方案与规则见 [docs/00-product-brief.md](docs/00-product-brief.md)，术语见 [GLOSSARY.md](GLOSSARY.md)，各功能验证状态见 [docs/verification-matrix.md](docs/verification-matrix.md)。

## 本地启动

要求 Node ≥ 22.18（已在 Node 26 验证）、npm。**无需 Docker 或本机 PostgreSQL**，开发数据库使用 `embedded-postgres`。

```bash
npm install
cp .env.example .env        # 本地默认 APP_MODE=demo（模拟短信/模型/存储）
npm run db:dev              # 终端 1：启动开发数据库（端口 54329，数据在 .data/pg）
npm run dev                 # 终端 2：Web  http://localhost:3000
npm run worker              # 终端 3：后台任务 worker（pg-boss）
```

首次启动需要为开发库建表：`DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/relationship npm run db:deploy`。
演示模式下登录页提供“演示用户 / 演示管理员登录”按钮；也可走完整的手机号验证码流程（验证码会显示在页面上，管理员后台可生成邀请码）。

生产环境没有演示登录，需用脚本创建首个管理员：`npm run admin:create -- <手机号>`，之后用验证码登录。

> **Windows 注意**：请在盘符大写的路径下运行命令（如 `C:\Ai_coding\relationship`）。小写盘符（`c:\...`）会导致 Vitest 报 "failed to find the current suite"。

## 检查与测试

```bash
npm run typecheck
npm run lint
npm test            # 单元 + 集成（集成测试自动启动临时 PostgreSQL）
npm run test:e2e    # Playwright：iPhone 14 (WebKit)、Pixel 7、桌面 Chrome；自动启动独立的临时数据库；首次需 `npx playwright install chromium webkit`
npm run build
```

## 演示模式与生产保护

- `APP_MODE=demo` 允许模拟短信、模拟模型、本地存储与开发登录，界面顶部显示"演示模式"横幅。
- **生产环境（`NODE_ENV=production`）下若 `APP_MODE=demo`，Web 与 worker 均拒绝启动**；`APP_MODE=production` 时模拟提供方、开发登录、示例/过短密钥同样会被拒绝。规则见 [src/lib/env.ts](src/lib/env.ts)，测试见 [tests/unit/env.test.ts](tests/unit/env.test.ts)。
- 未声明 `APP_MODE` 时默认按生产处理。
- **IP 限流依赖可信代理**：`TRUSTED_PROXY_HOPS=0`（默认）时不信任 `X-Forwarded-For`，所有请求共用一个 IP 限流桶；生产环境必须部署在会追加真实客户端 IP 的反向代理/负载均衡之后，并填写代理层数。

## 目录

| 路径 | 说明 |
|---|---|
| `src/app` | Next.js 页面与 API |
| `src/worker` | pg-boss 独立 worker 进程（其内部表在 `pgboss` schema，由 pg-boss 自己迁移，不入 Prisma） |
| `prisma/` | 业务数据模型与迁移 |
| `src/server/` | 服务层：auth、people、preferences、quota、admin（均以 userId 限定范围） |
| `src/domain/` | 与框架无关的领域定义（标签、校验） |
| `config/scoring/` | 评分规则配置（唯一数值来源，实验规则） |
| `docs/` | 方案、业务规范、评分规则、ADR |
| `tests/` | `unit`、`integration`、`e2e` |
| `scripts/` | 开发数据库等脚本 |
