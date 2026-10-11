# SPDX-License-Identifier: AGPL-3.0-or-later
# exit0-sync with the exit 0 web app bundled, so one container serves both on port 8080.
#   docker compose up -d        (see compose.yaml)
# The web app is copied from the published app image (GPL-3.0, github.com/krink192/exit0-linux-essentials).
ARG APP_IMAGE=ghcr.io/krink192/exit0:latest
FROM ${APP_IMAGE} AS app

FROM node:24-alpine
LABEL org.opencontainers.image.title="exit0-sync" \
      org.opencontainers.image.description="Self-hosted progress sync for exit 0, with the web app bundled" \
      org.opencontainers.image.source="https://github.com/krink192/exit0-sync" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

WORKDIR /srv/exit0-sync
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY --from=app /usr/share/nginx/html /srv/web
RUN chmod +x bin/exit0-sync.js && ln -s /srv/exit0-sync/bin/exit0-sync.js /usr/local/bin/exit0-sync \
 && mkdir -p /data && chown node:node /data

ENV EXIT0_DB=/data/exit0.db \
    EXIT0_APP_DIR=/srv/web \
    PORT=8080 \
    NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "bin/exit0-sync.js", "serve"]
