# syntax=docker/dockerfile:1
#
# 多阶段构建：build 阶段产出客户端静态资源，runtime 阶段只跑服务端。
# ⚠️ 本机无 Docker / WSL —— 本文件照写留档，**未经本机验证**；首次真实验证在云主机上进行。

# ---------- stage 1: build ----------
FROM node:24 AS build
WORKDIR /app

RUN corepack enable pnpm && corepack prepare pnpm@12.11.2 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @app/client run build

# ---------- stage 2: runtime ----------
FROM node:24-slim AS runtime
WORKDIR /app

RUN corepack enable pnpm && corepack prepare pnpm@12.11.2 --activate

COPY --from=build /app ./

# 已知限制：runtime 阶段装的是全量依赖（含 devDependencies），因为 start 脚本依赖 tsx。
# 后续可改用 pnpm deploy 或预编译产物以缩小镜像。
RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    SERVE_STATIC=1 \
    LOG_LEVEL=info

EXPOSE 3000

CMD ["pnpm", "--filter", "@app/server", "run", "start"]
