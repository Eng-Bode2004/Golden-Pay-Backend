# Golden Pay backend: all services in one container. The Identity API listens on $PORT
# (default 4001) and is the only public entry; the other services stay internal.
FROM oven/bun:1.3.14-debian

# All Debian security and point-release updates are installed first (the base image
# can lag behind them), then the packages the reports need.
# LibreOffice turns client Word layouts into PDF reports; Chromium prints the standard
# layout. The fonts cover Arabic and stand in for the Office fonts the client files use.
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends \
     libreoffice-writer-nogui chromium \
     fonts-noto-core fonts-noto-ui-core fonts-dejavu-core fonts-liberation2 \
     fonts-crosextra-carlito fonts-crosextra-caladea fonts-kacst-one fonts-arabeyes fonts-hosny-amiri \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=4001 \
    CHROME_PATH=/usr/bin/chromium \
    SOFFICE_PATH=/usr/bin/soffice \
    UPLOAD_DIR=/tmp/golden-pay-storage \
    TMPDIR=/tmp \
    HOME=/tmp \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

WORKDIR /app
COPY Shared/package.json Shared/bun.lock Shared/
COPY IdentityAcess_Services/package.json IdentityAcess_Services/bun.lock IdentityAcess_Services/
RUN cd Shared && bun install --frozen-lockfile --production \
  && cd ../IdentityAcess_Services && bun install --frozen-lockfile --production

COPY . .
# Thalmet Cloud runs containers unprivileged on a read-only filesystem: run as the image's
# non-root user, and write only to /tmp (report conversion, Chromium and LibreOffice
# profiles). Uploaded and generated files go to the cloud bucket (STORAGE_*).
RUN chown -R bun:bun /app

# Checks the final image itself: the build stops if any Debian update is still pending or
# perl-base is older than the release that fixes CVE-2026-13221, -42496 and -8376.
RUN apt-get update \
  && pending="$(apt-get -s upgrade | grep '^Inst ' || true)" \
  && if [ -n "$pending" ]; then echo "Security updates still pending:"; echo "$pending"; exit 1; fi \
  && perl_version="$(dpkg-query -W -f='${Version}' perl-base)" \
  && dpkg --compare-versions "$perl_version" ge "5.40.1-6+deb13u1" \
  && dpkg-query -W -f='${Package} ${Version}\n' perl-base chromium libreoffice-writer-nogui fonts-noto-core fonts-kacst-one \
  && rm -rf /var/lib/apt/lists/* \
  && echo "perl-base $perl_version: fixed; no pending Debian updates"
USER bun
EXPOSE 4001
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 4001) + '/health'); process.exit(r.ok ? 0 : 1)"
CMD ["bun", "start.ts"]
