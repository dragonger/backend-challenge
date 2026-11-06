# API image: Bun runs the TypeScript sources directly (no build step needed).
FROM oven/bun:1.4
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production \
    PORT=3000
EXPOSE 3000

USER bun
CMD ["bun", "src/main.ts"]
