# だれでも避難ナビ TOKYO — Cloud Run 用 Next.js(standalone) イメージ
# マルチステージ: deps → build → run（最小の実行イメージ）

FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 本番ビルド（output: "standalone" で .next/standalone に server.js を生成）
RUN npm run build

FROM node:20-slim AS run
WORKDIR /app
ENV NODE_ENV=production
# PORTは固定せず、Cloud Runが注入する$PORT(既定8080)をserver.jsが尊重する
# 非rootで実行
RUN groupadd -r nodejs && useradd -r -g nodejs nextjs
COPY --from=build /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
