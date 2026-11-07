# Golden Pay backend: all services in one container. The Identity API listens on $PORT
# (default 4001) and is the only public entry; the other services stay internal.
FROM oven/bun:1.3.14-debian

# LibreOffice turns client Word layouts into PDF reports; Chromium prints the standard
# layout. The fonts cover Arabic and stand in for the Office fonts the client files use.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     libreoffice-writer-nogui chromium \
     fonts-noto-core fonts-noto-ui-core fonts-dejavu-core fonts-liberation2 \
     fonts-crosextra-carlito fonts-crosextra-caladea fonts-kacst-one fonts-arabeyes fonts-hosny-amiri \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=4001 \
    CHROME_PATH=/usr/bin/chromium \
    SOFFICE_PATH=/usr/bin/soffice \
    UPLOAD_DIR=/app/storage

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
USER bun
EXPOSE 4001
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 4001) + '/api/v1/health'); process.exit(r.ok ? 0 : 1)"
CMD ["bun", "start.ts"]
