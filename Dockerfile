# Tesla YouTube Drive — single container: frontend + backend + WebSocket.
#
# Base: Node 22 on Debian bookworm (slim). Debian's ffmpeg ships the
# mpeg1video and libmp3lame encoders this app requires. yt-dlp is the
# self-contained PyInstaller binary from the official GitHub releases
# (pinned via YT_DLP_VERSION; no Python needed in the image).
FROM node:22-bookworm-slim

ARG YT_DLP_VERSION=2026.10.26

ENV NODE_ENV=production \
    PORT=8742 \
    HOST=0.0.0.0 \
    YT_DLP=/usr/local/bin/yt-dlp

WORKDIR /app

# ffmpeg (mpeg1video + libmp3lame), curl (yt-dlp download + healthcheck),
# ca-certificates for HTTPS to YouTube / googlevideo.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp_linux" \
 && chmod 0755 /usr/local/bin/yt-dlp \
 && yt-dlp --version \
 && ffmpeg -hide_banner -encoders 2>/dev/null | grep -E 'mpeg1video|libmp3lame'

# Dependencies first (layer cache), production only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App: server + static frontend (youtube-client, probe).
COPY server ./server
COPY public ./public

# /config holds the optional yt-dlp cookies.txt (mounted as a volume).
RUN mkdir -p /config && chown -R node:node /app /config

USER node

EXPOSE 8742

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8742/ >/dev/null || exit 1

CMD ["node", "server/server.js"]
