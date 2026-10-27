FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/agent/package.json packages/agent/
COPY packages/web/package.json packages/web/
RUN npm ci
COPY packages packages
RUN npm run build && node packages/agent/build/pack-cli.mjs /app/cli && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    REDLINE_DATA_DIR=/data \
    REDLINE_WEB_DIR=/app/packages/web/dist \
    REDLINE_CLI_DIR=/app/cli
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist
COPY --from=build /app/cli cli
VOLUME /data
EXPOSE 3000 3001
CMD ["node", "packages/server/dist/main.js"]
