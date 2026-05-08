FROM node:22-slim

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/opencae-core-cloud ./services/opencae-core-cloud

RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @opencae/core build \
  && pnpm --filter @opencae/solver-cpu build \
  && pnpm --filter @opencae/core-cloud build

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "services/opencae-core-cloud/dist/server.js"]
