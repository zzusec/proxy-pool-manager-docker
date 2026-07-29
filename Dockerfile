# Stage 1: Build (compile better-sqlite3 native module)
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --production

# Stage 2: Pinned sing-box runtime for Hysteria2/VLESS/VMess/Trojan/SS inspection.
FROM ghcr.io/sagernet/sing-box:v1.13.12 AS sing-box

# Stage 3: Runtime
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=sing-box /usr/local/bin/sing-box /usr/local/bin/sing-box
COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/healthz || exit 1
CMD ["node", "src/index.js"]
