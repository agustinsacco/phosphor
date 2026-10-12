FROM node:22-alpine AS site
WORKDIR /app
ENV ASTRO_TELEMETRY_DISABLED=1
# The social preview's SVG text needs fonts only in the builder.
RUN apk add --no-cache font-dejavu
COPY apps/site/package*.json ./
RUN npm ci
COPY apps/site/ ./
RUN npm run check && npm run build

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

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=control /app/apps/control/dist/server.mjs ./server.mjs
COPY --from=site /app/dist ./site
USER 1000:1000
EXPOSE 5015
CMD ["node", "server.mjs"]
