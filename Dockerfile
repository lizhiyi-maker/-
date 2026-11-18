# 关系工作台镜像：一个镜像、两个启动命令（web / worker）。
#
# ⚠ 本文件尚未在真实 Docker 里构建或运行过（开发机没有 Docker），见 docs/deploy/README.md §2、docs/verification-matrix.md（⏳）。
# 已在本机验证的只有它背后的命令：`npm ci`、`next build`、`npm start`、`npm run worker`、`prisma migrate deploy`。
#
# 构建：  docker build -t relationship:local .
# Web：   docker run --env-file prod.env -p 3000:3000 relationship:local
# Worker：docker run --env-file prod.env relationship:local npm run worker
# 迁移：  docker run --rm --env-file prod.env relationship:local npm run db:deploy   （一次性命令，发版时先于 web/worker 执行）
# 管理员：docker run --rm --env-file prod.env relationship:local npm run admin:create -- <手机号>
#
# 为什么不用 next 的 standalone 精简输出：worker 要用 tsx 直接跑 TypeScript 源码，迁移要用 prisma CLI，
# 这些都需要完整的 node_modules；web 与 worker 共用同一份依赖，拆开并不能省多少，只会多出一份要维护的 Dockerfile。

ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# 先只拷依赖清单与 prisma 模式：依赖没变时复用缓存层（postinstall 会运行 prisma generate，需要 schema）
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

COPY . .
# 构建阶段不校验运行时环境变量（见 src/instrumentation.ts），所以这里不需要任何密钥
RUN npm run build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

# 完整依赖 + 源码（worker 与迁移需要）+ 构建产物。不含 .env、.data、测试产物（见 .dockerignore）。
COPY --from=build --chown=node:node /app /app

# 不以 root 运行
USER node
EXPOSE 3000

# 默认启动 web。worker 用同一镜像、命令改为 `npm run worker`。
# 容器健康探测：GET /api/health（只说明 Web 进程活着，不检查数据库；worker 没有 HTTP 端口）
CMD ["npm", "start"]
