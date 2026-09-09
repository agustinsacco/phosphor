# Stage 1: build the static site
FROM node:22-alpine AS builder
WORKDIR /app
ENV ASTRO_TELEMETRY_DISABLED=1

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: serve it with nginx, as an unprivileged user on a read-only root
FROM nginx:alpine
RUN rm /etc/nginx/conf.d/default.conf \
    && sed -i 's#^pid .*#pid /tmp/nginx.pid;#' /etc/nginx/nginx.conf \
    && chown -R nginx:nginx /var/cache/nginx /etc/nginx/conf.d
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

USER 101:101
EXPOSE 5015
CMD ["nginx", "-g", "daemon off;"]
