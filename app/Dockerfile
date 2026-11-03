# syntax=docker/dockerfile:1.7
# Next.js demo app for a Runpod CPU pod. No secrets at build time: RUNPOD_API_KEY
# and DEMO_ACCESS_CODE are injected at runtime from Runpod Secrets.
#
#   docker buildx build --platform linux/amd64 -t <user>/flux-studio-app:<tag> --push app

FROM node:24.22.2-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# prebuild keeps the committed prices.generated.json (bench/ isn't in this context)
RUN npm run build

FROM node:24.22.2-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /src/.next/standalone ./
COPY --from=build /src/.next/static ./.next/static
COPY --from=build /src/public ./public
COPY start.mjs ./
# Starts as root only to prepare DATA_DIR on the mounted volume, then runs as `node`.
EXPOSE 3000
CMD ["node", "start.mjs"]
