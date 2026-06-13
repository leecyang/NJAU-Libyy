FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.server.json ./
COPY apps ./apps
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "60";\n' > /etc/apt/apt.conf.d/80-retries \
    && apt-get update && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && npm ci --omit=dev
RUN set -eux; \
    for attempt in 1 2 3; do \
      if npx playwright install --with-deps chromium; then break; fi; \
      if [ "$attempt" = "3" ]; then exit 1; fi; \
      sleep 5; \
    done; \
    chmod -R a+rX /ms-playwright; \
    npm cache clean --force
RUN groupadd --gid 1001 appuser \
    && useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash appuser
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY migrations ./migrations
COPY scripts/docker-entrypoint.sh /usr/local/bin/njau-libyy-entrypoint
RUN chmod +x /usr/local/bin/njau-libyy-entrypoint \
    && mkdir -p /data/playwright-profiles && chown -R appuser:appuser /app /data
EXPOSE 3000
ENTRYPOINT ["njau-libyy-entrypoint"]
CMD ["node", "dist/server/node/server.js"]
