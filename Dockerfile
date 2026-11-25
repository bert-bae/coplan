# Coplan daemon for self-hosting (docs/SELF-HOSTING.md).
#   docker build -t coplan .
#   docker run -d -p 127.0.0.1:4321:4321 -e COPLAN_TOKEN=... -v coplan-data:/data coplan
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /src
COPY . .
# `prepare` runs the build; dist/ is self-contained, so nothing else ships.
RUN pnpm install --frozen-lockfile

FROM node:24-slim
ENV CC_HARNESS_HOME=/data \
    COPLAN_BIND=0.0.0.0 \
    COPLAN_PORT=4321 \
    COPLAN_SELF_HOSTED=1
WORKDIR /app
COPY --from=build /src/dist ./dist
COPY --from=build /src/package.json ./
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4321/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/daemon/main.js"]
