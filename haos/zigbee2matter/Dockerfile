# 빌드 컨텍스트: haos/zigbee2matter/ (소스는 haos/prepare-local.* 가 app/ 에 복사).
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.22

# 1) TypeScript 컴파일(dist)
FROM alpine:3.22 AS build
ENV CI=true
WORKDIR /app
RUN apk add --no-cache nodejs npm jq make gcc g++ python3 linux-headers
COPY app/package.json app/pnpm-lock.yaml app/pnpm-workspace.yaml ./
RUN npm install -g $(jq -r '.packageManager' package.json) && pnpm install --frozen-lockfile
COPY app/tsconfig.json app/index.js ./
COPY app/lib ./lib
RUN pnpm run build

# 2) production 의존성(serialport 는 현재 아키텍처에서 재빌드)
FROM alpine:3.22 AS deps
ENV CI=true NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache nodejs npm jq make gcc g++ python3 linux-headers
COPY app/package.json app/pnpm-lock.yaml app/pnpm-workspace.yaml ./
RUN npm install -g $(jq -r '.packageManager' package.json) &&     pnpm install --frozen-lockfile --prod --no-optional &&     rm -rf $(find ./node_modules/.pnpm/ -wholename "*/@serialport/bindings-cpp/prebuilds" -type d) &&     pnpm rebuild @serialport/bindings-cpp

# 3) add-on 런타임
FROM ${BUILD_FROM}
ENV NODE_ENV=production
RUN apk add --no-cache nodejs tzdata eudev
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY app/package.json app/LICENSE app/index.js ./
COPY app/data/configuration.example.yaml ./
COPY rootfs /
RUN chmod a+x /etc/services.d/zigbee2matter/run /etc/services.d/zigbee2matter/finish

ARG BUILD_VERSION
LABEL io.hass.version="${BUILD_VERSION}" io.hass.type="addon" io.hass.name="Zigbee2Matter"
