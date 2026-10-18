FROM node:22-alpine AS site
WORKDIR /app
ENV ASTRO_TELEMETRY_DISABLED=1
# The social preview's SVG text needs fonts only in the builder.
RUN apk add --no-cache font-dejavu
COPY apps/site/package*.json ./
RUN npm ci
COPY apps/site/ ./
ARG PHOSPHOR_WEB_ENABLED=false
RUN case "$PHOSPHOR_WEB_ENABLED" in true|false) ;; *) exit 1 ;; esac \
    && npm run check && PUBLIC_PHOSPHOR_WEB_ENABLED="$PHOSPHOR_WEB_ENABLED" npm run build

FROM node:22-alpine AS control
WORKDIR /app
COPY apps/control/package*.json ./apps/control/
RUN npm ci --prefix apps/control
COPY apps/control/src/ ./apps/control/src/
COPY apps/control/scripts/ ./apps/control/scripts/
COPY apps/control/tsconfig.json ./apps/control/
COPY libs/shared/src/ ./libs/shared/src/
COPY tsconfig.base.json ./
RUN node apps/control/scripts/build.mjs

FROM node:22-alpine AS web
WORKDIR /app
# Source-library/tooling install only. Never run Desktop's native postinstall.
COPY package*.json ./
COPY libs/shared/package.json ./libs/shared/
COPY libs/session-runtime/package.json ./libs/session-runtime/
COPY libs/pi-extensions/package.json ./libs/pi-extensions/
COPY libs/host-client/package.json ./libs/host-client/
COPY libs/client-ui/package.json ./libs/client-ui/
RUN npm ci --ignore-scripts
COPY apps/web/package*.json ./apps/web/
RUN npm ci --prefix apps/web --ignore-scripts
COPY apps/web/ ./apps/web/
COPY libs/shared/src/ ./libs/shared/src/
COPY libs/host-client/src/ ./libs/host-client/src/
COPY libs/client-ui/src/ ./libs/client-ui/src/
# These self-contained wire helpers are shared with the UI, not a pi runtime.
COPY libs/pi-extensions/pi-ext/lane-reload.ts libs/pi-extensions/pi-ext/swarm.ts libs/pi-extensions/pi-ext/subagent-snapshot.ts ./libs/pi-extensions/pi-ext/
COPY tsconfig.base.json ./
ARG PHOSPHOR_BUILD_SHA=local
RUN PHOSPHOR_BUILD_SHA="$PHOSPHOR_BUILD_SHA" npm run build --prefix apps/web

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=control /app/apps/control/dist/server.mjs ./server.mjs
COPY --from=site /app/dist ./site
COPY --from=web /app/apps/web/dist ./web
USER 1000:1000
EXPOSE 5015
CMD ["node", "server.mjs"]
