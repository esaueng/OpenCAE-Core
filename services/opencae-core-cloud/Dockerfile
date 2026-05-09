FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY services/opencae-core-cloud/package.json ./package.json
COPY services/opencae-core-cloud/dist ./dist

EXPOSE 8080

CMD ["node", "dist/server.bundle.js"]
