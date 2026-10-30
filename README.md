# Tesla YouTube Drive

YouTube in the Tesla browser **while the car is in Drive** — search, trending,
and playback with a custom player — using the architecture of
[tesla-video-drive](https://github.com/madpowah/tesla-video-drive) by madpowah
(MIT License), retargeted from Twitch live streams to YouTube videos.

> **Safety warning:** Watching or operating video while **driving** is
> dangerous and illegal in most jurisdictions. This is for **passengers
> only** while the car is moving. The driver must never watch or interact
> with it. You are responsible for complying with your local laws.

## Why a normal YouTube page does not work in Drive

Tesla's browser is QtWebEngine (embedded Chromium), and Tesla hooks the
`<video>` element **at the OS/browser level**: in Drive, every `<video>`
element is immediately paused (the last frame freezes; `drawImage(video)`
to a canvas yields black). No page JavaScript can override that — it is
not a website policy, it is the car's browser build.

TeslaPlay and similar services get around the parked-only Theater apps by
keeping playback inside the ordinary browser, but a plain embedded
YouTube player still uses a `<video>` element underneath, so it is still
subject to that pause. This project uses a different render path entirely.

## Architecture (the bypass)

```
 YouTube ──► yt-dlp (resolve stream URL, server-side)
                 │
                 ├─ video ─► ffmpeg ─► MPEG1-TS ─► WebSocket ─► JSMpeg
                 │           (mpeg1video, 30 fps,    (binary)     (JS/WebGL
                 │            scaled 360/480/720/1080p)                 decoder)
                 │                                                    │
                 │                                                 <canvas>
                 └─ audio ─► ffmpeg ─► MP3 ─► HTTP ─► <audio> element
                              (libmp3lame, 48k,
                               22050 Hz, mono)
```

- **No `<video>` element is ever used for playback.** Video frames arrive
  as an MPEG-1 transport stream over a WebSocket and are decoded in
  JavaScript/WebGL by [JSMpeg](https://github.com/cycjimmy/jsmpeg-player)
  (bundled, MIT License) and painted onto a `<canvas>`. Canvas and
  WebSocket are not restricted in Drive, so nothing gets paused.
- **Audio is a separate, parallel pipe** because JSMpeg's own audio path
  is not used for this stream (video is sent with `-an`): a second ffmpeg
  transcodes the best-audio track to low-bitrate MP3 and serves it over
  plain HTTP to a native `<audio>` element, which Tesla does *not* block.
  The client starts audio first and only launches the video stream once
  audio is playing (with a 10-second forced-start timeout), then nudges
  audio forward to compensate for the audio endpoint's ~5 s buffer delay;
  a **Sync +2s** button corrects residual drift.
- **Search and trending are server-side** (`yt-dlp ytsearch20:` and the
  trending feed, with public Piped/Invidious trending as fallback), so the
  Tesla browser never has to talk to a third-party resolver directly, and
  thumbnails come straight from YouTube's image CDN
  (`i.ytimg.com/vi/<id>/hqdefault.jpg`) in the client.
- The server kills its ffmpeg child as soon as a WebSocket closes or an
  audio request disconnects — no orphan transcodes.

## One repo, one container: frontend + backend together

**Yes — the home server runs both.** There is a single Node/Express
process, and a single Docker container built from this repo, serving
everything on **one port (8742)**:

```
                    ┌────────────── tesla-drive container ──────────────┐
  Tesla browser ───►│  Express (one process, port 8742)                 │
                    │   GET  /                  → YouTube-style front   │
                    │                             page (static files) │
                    │   GET  /api/search|trending|info → yt-dlp       │
                    │   GET  /api/audio         → ffmpeg → MP3 stream │
                    │   WS   /ws/mpeg1          → ffmpeg → MPEG1-TS   │
                    └─────────────────────────────────────────────────────┘
```

Because the front page and the APIs/WebSocket are **same-origin**, there
is no CORS to configure, and a single reverse-proxy rule (or none, on a
plain LAN) covers the page, the APIs and the `wss://` upgrade at once.

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| WS | `/ws/mpeg1?v=VIDEOID&quality=360\|480\|720\|1080` | MPEG1-TS video over WebSocket. Text frames are JSON `{type:"status"\|"error", ...}`. Also accepts `?url=<direct media URL>` (validated) for testing/other sources. |
| GET | `/api/audio?v=VIDEOID` | MP3 audio stream (`audio/mpeg`) for the same video. Also accepts `?url=`. |
| GET | `/api/search?q=QUERY` | JSON `{ok, results:[{id,title,channel,duration,viewCount}]}` (yt-dlp `ytsearch20:`) |
| GET | `/api/trending?region=US` | Same JSON shape; yt-dlp trending feed first, Piped/Invidious fallback; the `source` field says which path answered |
| GET | `/api/info?v=VIDEOID` | `{ok, title, channel, duration, viewCount, isLive}` |
| GET | `/` | Redirects to the YouTube client below |
| GET | `/youtube-client/` | The YouTube-style front page (trending grid, search, category chips) + watch view with the canvas player |
| GET | `/probe/` | Tesla browser capability probe (adapted from the original repo, MIT) |
| POST | `/api/probe-report` | Probe report receiver (as in the original repo) |

## Quick start (Docker)

The image bundles Node, ffmpeg and yt-dlp — nothing else to install:

```bash
git clone <this-repo> tesla-drive-server   # or copy the folder over
cd tesla-drive-server
docker compose up -d --build
# open http://<your-server>:8742/
```

`docker-compose.yml` runs one service (`tesla-drive`), publishes
`8742:8742`, sets `HOST=0.0.0.0` **inside the container only** (the code's
bare-metal default stays `127.0.0.1`), and mounts `./config` to `/config`
for the optional yt-dlp `cookies.txt`.

## Unraid

**Path 1 — Compose Manager plugin (recommended, no registry needed):**
install the *Compose Manager* plugin from Community Apps, create a new
stack, and point it at this repo (clone it onto the server, e.g. under
`/mnt/user/appdata/tesla-drive-src`, or paste the compose contents). It
builds the image locally from the `Dockerfile`. Before starting, edit the
volume line in `docker-compose.yml` to
`/mnt/user/appdata/tesla-drive:/config`.

**Path 2 — Docker tab template:** Unraid's Docker tab can only *pull*
images, so first build and push one:

```bash
docker build -t ghcr.io/YOUR-USERNAME/tesla-drive:latest .
docker push ghcr.io/YOUR-USERNAME/tesla-drive:latest
```

Then add `unraid/tesla-drive.xml` from this repo to
`/boot/config/plugins/dockerMan/templates-user/`, replace the
`YOUR-USERNAME` placeholder in its `<Repository>`, and add the container
from the Docker tab. The template maps port 8742, `/config` →
`/mnt/user/appdata/tesla-drive`, and the `PORT` / `HOST` /
`YT_DLP_COOKIES` variables.

**Cookies (optional):** if YouTube bot-blocks your IP, export a Netscape
`cookies.txt` from a signed-in browser and drop it in the appdata folder
as `cookies.txt` (see `config/cookies.txt.example`). The server only
passes it to yt-dlp when the file exists.

**Remote access / reverse proxy:** because everything is same-origin on
one port, Nginx Proxy Manager, SWAG, or any single proxy host rule covers
the page, APIs and WebSocket — just enable WebSocket support (the
`wss://` upgrade) on that host. **Do not expose this to the public
internet without authentication**: anyone who can reach it can make your
server fetch and transcode video. Prefer LAN-only, or reach it remotely
over Tailscale / a VPN.

## Install (bare metal, no Docker)

Requirements: **Node.js 18+**, **ffmpeg** with `mpeg1video` and
`libmp3lame` encoders (stock ffmpeg builds have both), and **yt-dlp**.

```bash
# Debian/Ubuntu
sudo apt install ffmpeg nodejs
pip install yt-dlp        # or: python3 -m venv .venv && .venv/bin/pip install yt-dlp

cd tesla-drive-server
npm install
cp .env.example .env      # optional; defaults are fine locally
npm start                 # http://127.0.0.1:8742/
```

Verify your tools: `node -v`, `ffmpeg -version | head -1`, `yt-dlp --version`.
If yt-dlp lives somewhere unusual, set `YT_DLP=/path/to/yt-dlp` in `.env`.

## Running it for a car

The server binds to **127.0.0.1 by default** (same as the original repo) —
it is meant to run on a home machine / home server and be exposed through
an HTTPS reverse proxy:

- **Tesla needs WSS if the page is HTTPS.** Browsers block plain `ws://`
  from an `https://` page, so if you serve the client over HTTPS your
  proxy must also upgrade `/ws/mpeg1` to `wss://`. Apache example (from
  the original repo):

```
ProxyPass / http://127.0.0.1:8742/
RewriteCond %{HTTP:Upgrade} =websocket [NC]
RewriteCond %{HTTP:Connection} =upgrade [NC]
RewriteRule /(.*) ws://127.0.0.1:8742/$1 [P,L]
ProxyTimeout 300
```

- A tunnel (Cloudflare Tunnel, Tailscale Funnel, ngrok, …) works the same
  way, as long as it passes WebSocket upgrades through.
- **Built-in HTTPS (alternative to a proxy):** set both `TLS_CERT` and
  `TLS_KEY` to PEM file paths and the server itself serves HTTPS + WSS
  on the same port (in Docker, drop `cert.pem`/`key.pem` into the
  mounted `config/` folder and use `/config/cert.pem`,
  `/config/key.pem`). A self-signed cert is fine for LAN testing —

  ```
  openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes
  ```

  — but the Tesla browser may refuse self-signed certificates, which is
  why a proxy/tunnel with a publicly trusted cert remains the
  recommended route for the car. The client picks `wss://`
  automatically whenever the page itself is loaded over `https://`.
- Serving it from a **residential/home connection is strongly
  recommended** — see the bot-block note below.

## Quality presets

| `quality` | Scale | Canvas | Video bitrate |
|-----------|-------|--------|---------------|
| 360 | 640×360 | 640×360 | 700k |
| 480 (default) | 854×480 | 854×480 | 1100k |
| 720 | 1280×720 | 1280×720 | 1800k |
| 1080 | 1920×1080 | 1920×1080 | 3500k |

All at 30 fps, MPEG-1 (`-bf 0`, `-q:v 5`). 1080p is opt-in and heavy:
it roughly triples the 720p bitrate and is the most demanding preset
for both the server's encoder and the car's JS decoder — expect it to
be the first preset to stutter on weak hardware or a slow uplink.
MPEG-1 is old but that is the
point: JSMpeg can decode it in JS/WebGL at 30 fps in the Tesla browser,
which modern codecs (needing MSE/WebCodecs — limited/absent in
QtWebEngine) cannot do here.

## Known limits

- **Audio sync:** the client defaults to *Sync audio* (combined) mode —
  the server muxes audio (MP2) into the same MPEG-TS as the video and
  JSMpeg decodes both from the same timestamps, so lip sync is exact by
  construction. The original two-pipe design remains as *Compat audio*
  mode (separate MP3 pipe, ~5 s buffer delay, Sync +2s compensation) in
  case a browser won't play JSMpeg/WebAudio sound. Also note **Stop is a
  restart-pause**: it remembers the position and **Resume** restarts the
  stream at that position; resuming takes a few seconds, like a seek.
- **YouTube bot-blocks datacenter IPs.** From a cloud VM, yt-dlp often
  gets *"Sign in to confirm you're not a bot"* (LOGIN_REQUIRED) and no
  stream can be resolved — search/info/audio all fail the same way. The
  server classifies this and returns `bot-blocked` so the client can say
  so. Remedies: run the server from a home/residential IP, or export
  cookies from a browser where you are signed in to YouTube and set
  `YT_DLP_COOKIES=/path/to/cookies.txt` in `.env` (passed to yt-dlp as
  `--cookies`). Keep that file private — it is a login credential.
- **VOD, not live-optimized:** this YouTube version resolves `bestvideo`
  for a video ID and transcodes as a forward stream. Seeking is
  *restart seeking*: both stream endpoints accept `?t=SECONDS`
  (`/ws/mpeg1?v=…&t=642`, `/api/audio?v=…&t=642`), which the server passes
  to ffmpeg as an input seek (`-ss` before `-i`), and the client tracks a
  virtual timeline (progress bar, ±10 s buttons) on top. A jump therefore
  takes a few seconds (new resolve + transcode start) and nothing is
  downloaded or cached in full. Seeking is disabled for live streams and
  when the duration is unknown. Live streams resolve too, but latency
  will be higher than the Twitch original.
- **ffmpeg CPU:** MPEG-1 transcoding is done in software; 720p needs a
  reasonably modern CPU core per concurrent viewer, and 1080p needs
  noticeably more — on both the server and the car's decoder.
- **Tesla can change things:** any Tesla software update can alter the
  browser's restrictions. The `/probe/` page exists to re-check what the
  car still allows.

## Security

Clean-room server code (the original repo's Twitch server was **not**
copied; it uses shell-string `exec` in places — this one does not):

- yt-dlp and ffmpeg are always invoked with **argument arrays**
  (`spawn`/`execFile`), never shell string interpolation.
- Video IDs are validated against `/^[A-Za-z0-9_-]{11}$/`; search text is
  length-capped and passed as a single argument.
- Direct `?url=` inputs must be http(s), parse as a URL, and must not
  point at loopback/private/link-local hosts.
- Binds to 127.0.0.1 by default. Anyone who can reach this server can
  make it fetch and transcode video — do not expose it unauthenticated to
  the open internet without understanding that.

## Pushing this local repo to GitHub

This repo is a plain local git repository (no remote configured). To
publish it under your own account:

```bash
# Option A — GitHub CLI
gh repo create tesla-drive-server --private --source=. --push

# Option B — manual: create an empty repo on github.com first, then
git remote add origin git@github.com:YOUR-USERNAME/tesla-drive-server.git
git push -u origin main
```

Once it is on GitHub you can also build the image in GitHub Actions and
push it to GHCR (`ghcr.io/YOUR-USERNAME/tesla-drive:latest`), which is
the image name the Unraid template in `unraid/tesla-drive.xml` expects.

## Credits / License

Architecture, the client player pattern, the probe page, and
`jsmpeg.min.js` come from
[tesla-video-drive](https://github.com/madpowah/tesla-video-drive) by
madpowah, used under the **MIT License** (see that repository for its full
license text). JSMpeg player by cycjimmy / upstream JSMpeg contributors,
MIT License, license header retained in the bundled file. This YouTube
adaptation is likewise MIT.
