'use strict';
/*
 * Tesla YouTube Drive — server
 *
 * Architecture adapted from tesla-video-drive by madpowah (MIT License)
 * https://github.com/madpowah/tesla-video-drive
 *
 * Why: Tesla's QtWebEngine browser pauses <video> elements at the OS level
 * in Drive. This server therefore never delivers a <video>-playable page:
 *   video -> yt-dlp resolves a stream URL -> ffmpeg transcodes to
 *            MPEG1-TS -> WebSocket -> JSMpeg (JS/WebGL decoder) -> <canvas>
 *   audio -> separate pipe -> ffmpeg MP3 -> native <audio> element
 *            (audio elements are not blocked in Drive)
 *
 * Security notes:
 *  - All yt-dlp / ffmpeg invocations use spawn/execFile with argument
 *    ARRAYS. No user input is ever interpolated into a shell string.
 *  - Video IDs are validated against /^[A-Za-z0-9_-]{11}$/.
 *  - Direct ?url= inputs must be http(s), must parse as a URL, and must
 *    not point at loopback / private / link-local hosts.
 *  - Binds to 127.0.0.1 by default (HOST env can change it).
 */
const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const { URL } = require('url');
const dnsLookup = require('dns').promises.lookup;

// ---- tiny .env loader (no extra dependency) -------------------------------
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (e) { /* .env is optional */ }
})();

const PORT = parseInt(process.env.PORT, 10) || 8742;
const HOST = process.env.HOST || '127.0.0.1';
// Every playback spawns a software MPEG1/MP3 transcode — the single most
// expensive thing this server does. Without a cap, anyone who can reach
// the public proxy can saturate the host CPU with parallel streams.
const MAX_STREAMS = Math.max(1, parseInt(process.env.TESLA_MAX_STREAMS, 10) || 6);
let activeStreams = 0;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const YT_DLP = process.env.YT_DLP || 'yt-dlp';
const YT_DLP_COOKIES = process.env.YT_DLP_COOKIES || '';

// ffmpeg pacing capabilities, probed once at startup. -readrate arrived
// in ffmpeg 5.1, but -readrate_initial_burst only in 6.1 — and the Docker
// image (Debian bookworm) ships ffmpeg 5.1, where passing the 6.1 option
// makes ffmpeg exit instantly ("Unrecognized option") and every VOD
// stream hangs at Buffering forever. Never pass an option the installed
// ffmpeg hasn't confirmed it supports. The default until the probe
// answers is the safest subset (plain realtime): a stream opened in the
// startup window must never be handed an option that may not exist.
let FFMPEG_READRATE = false;
let FFMPEG_READRATE_BURST = false;
execFile('ffmpeg', ['-h', 'full'], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
  const help = String(stdout || '');
  FFMPEG_READRATE = /-readrate[\s<]/.test(help);
  FFMPEG_READRATE_BURST = help.includes('readrate_initial_burst');
  console.log('ffmpeg pacing: ' + (FFMPEG_READRATE
    ? 'readrate 2x' + (FFMPEG_READRATE_BURST ? ' + initial burst' : ' (no initial burst — ffmpeg < 6.1)')
    : 'realtime (-re) — no -readrate support'));
});

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const QUALITY = {
  '360': { scale: '640:360', canvas: [640, 360], bitrate: '700k' },
  '480': { scale: '854:480', canvas: [854, 480], bitrate: '1100k' },
  '720': { scale: '1280:720', canvas: [1280, 720], bitrate: '1800k' },
  '1080': { scale: '1920:1080', canvas: [1920, 1080], bitrate: '3500k' },
};
const WATCH_URL = (id) => 'https://www.youtube.com/watch?v=' + id;

function cookieArgs() {
  // Only pass --cookies when the file actually exists: yt-dlp hard-fails on
  // a missing cookies file, and Docker/compose set YT_DLP_COOKIES by default
  // (the file itself is optional).
  if (!YT_DLP_COOKIES) return [];
  try {
    if (!fs.existsSync(YT_DLP_COOKIES)) return [];
  } catch (e) { return []; }
  return ['--cookies', YT_DLP_COOKIES];
}

function classifyError(stderr) {
  const s = String(stderr || '');
  if (/Sign in to confirm|LOGIN_REQUIRED|not a bot/i.test(s)) return 'bot-blocked';
  if (/Private video|Video unavailable|removed/i.test(s)) return 'unavailable';
  if (/age|Sign in to verify your age/i.test(s)) return 'age-restricted';
  return 'resolve-failed';
}

// Run yt-dlp with an argument array; resolve to trimmed stdout.
function ytDlp(args, timeoutMs = 30000, maxBuffer = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile(YT_DLP, args, { timeout: timeoutMs, maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error('yt-dlp failed');
        e.type = classifyError(stderr);
        e.stderr = String(stderr || err.message || '').slice(0, 500);
        reject(e);
      } else {
        resolve(String(stdout || ''));
      }
    });
  });
}

// Resolve a direct stream URL for `format` ('bestvideo...' / 'bestaudio...').
async function resolveStream(videoId, format) {
  const args = ['-g', '--no-playlist', '--no-warnings', '-f', format,
    ...cookieArgs(), WATCH_URL(videoId)];
  const out = await ytDlp(args, 30000);
  const url = out.trim().split('\n').filter(Boolean)[0];
  if (!url || !url.startsWith('http')) {
    const e = new Error('yt-dlp returned no stream URL');
    e.type = 'resolve-failed';
    throw e;
  }
  return url;
}

// Is this IP literal in a range ffmpeg must never be sent to?
function isBlockedIp(host) {
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = +v4[1], b = +v4[2];
    if (a === 0 || a === 10 || a === 127) return true;          // "this" net, private, loopback
    if (a === 172 && b >= 16 && b <= 31) return true;           // private
    if (a === 192 && b === 168) return true;                    // private
    if (a === 169 && b === 254) return true;                    // link-local
    if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT (incl. Tailscale)
    if (a === 198 && (b === 18 || b === 19)) return true;       // benchmarking
    if (a === 192 && b === 0) return true;                      // 192.0.0.0/24
    if (a >= 240) return true;                                  // multicast / reserved / broadcast
    return false;
  }
  if (host.includes(':')) {
    const h = host.toLowerCase();
    if (h === '::' || h === '::1') return true;
    if (/^fe[89ab]/.test(h)) return true;                       // fe80::/10 link-local
    if (h.startsWith('fc') || h.startsWith('fd')) return true;  // fc00::/7 ULA
    // IPv4-mapped/compatible IPv6: Node's URL parser normalizes
    // [::ffff:127.0.0.1] to ::ffff:7f00:1 (hex), so decode the last
    // 32 bits back to a dotted quad and check that. (The dotted form
    // is kept as a fallback for parsers that don't normalize.)
    const hexMapped = h.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16);
      return isBlockedIp((hi >> 8) + '.' + (hi & 255) + '.' + (lo >> 8) + '.' + (lo & 255));
    }
    const mapped = h.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
  }
  return false;
}

// Validate a direct-media ?url= parameter (used for testing / advanced use).
async function validateDirectUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // Node keeps the brackets on IPv6 hostnames ('[::1]') — strip them, or
  // every IPv6 range check below silently misses.
  const host = u.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local')) return null;
  if (isBlockedIp(host)) return null;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host) && !host.includes(':')) {
    // A public-looking name that resolves to a private address is the
    // same SSRF with extra steps, so check every address it maps to.
    // (Residual risk: HTTP redirects and DNS answers that change after
    // this check — ffmpeg is pointed at the name, not a pinned address.)
    try {
      const addrs = await dnsLookup(host, { all: true });
      if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) return null;
    } catch (e) { return null; }
  }
  return u.href;
}

function parseQuality(raw) {
  return QUALITY[String(raw)] ? String(raw) : '480';
}

// Parse a restart-seek offset (`?t=SECONDS`). Absent means 0. A present but
// invalid value returns null so callers can reject it instead of silently
// restarting from the beginning.
function parseSeekOffset(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 24 * 3600) return null;
  return Math.floor(n * 1000) / 1000;
}

function seekArgs(startSeconds) {
  return startSeconds > 0 ? ['-ss', String(startSeconds)] : [];
}

function mapFlatEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const id = e.id || (e.url && String(e.url).match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1]);
  if (!id || !VIDEO_ID_RE.test(id)) return null;
  return {
    id,
    title: String(e.title || 'Untitled'),
    channel: String(e.channel || e.uploader || e.channel_name || ''),
    channelId: String(e.channel_id || e.uploader_id || ''),
    duration: (typeof e.duration === 'number' && isFinite(e.duration)) ? Math.round(e.duration) : null,
    viewCount: (typeof e.view_count === 'number') ? e.view_count
      : (typeof e.views === 'number' ? e.views : null),
  };
}

function mapPipedItem(it) {
  const m = String(it.url || '').match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (!m) return null;
  const cm = String(it.uploaderUrl || '').match(/\/channel\/([A-Za-z0-9_-]+)/);
  return {
    id: m[1], title: String(it.title || 'Untitled'),
    channel: String(it.uploaderName || ''),
    channelId: cm ? cm[1] : '',
    duration: (typeof it.duration === 'number' && it.duration >= 0) ? it.duration : null,
    viewCount: (typeof it.views === 'number') ? it.views : null,
  };
}

function mapInvidiousItem(it) {
  const r = {
    id: it.videoId, title: String(it.title || 'Untitled'),
    channel: String(it.author || ''),
    channelId: String(it.authorId || ''),
    duration: (typeof it.lengthSeconds === 'number') ? it.lengthSeconds : null,
    viewCount: (typeof it.viewCount === 'number') ? it.viewCount : null,
  };
  return VIDEO_ID_RE.test(r.id) ? r : null;
}

// ==========================================================================
// HTTP app
// ==========================================================================
const app = express();
app.disable('x-powered-by');
app.use(express.static(PUBLIC_DIR));

// ---- Probe report receiver (as in the original repo) ----------------------
app.post('/api/probe-report', express.json({ limit: '1mb' }), (req, res) => {
  const reportsDir = path.join(__dirname, '..', 'probe-reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const filename = path.join(reportsDir,
    'probe-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFile(filename, JSON.stringify(req.body || {}, null, 2), (err) => {
    if (err) return res.status(500).json({ ok: false, error: 'could-not-save' });
    // Retention: keep only the newest 50 reports (ISO names sort by age),
    // so this unauthenticated endpoint can't fill the disk.
    try {
      const files = fs.readdirSync(reportsDir).filter((f) => f.startsWith('probe-')).sort();
      while (files.length > 50) {
        try { fs.unlinkSync(path.join(reportsDir, files.shift())); } catch (e) {}
      }
    } catch (e) {}
    res.json({ ok: true });
  });
});

// ---- Info ------------------------------------------------------------------
app.get('/api/info', async (req, res) => {
  const id = String(req.query.v || '');
  if (!VIDEO_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'Invalid video id' });
  try {
    const out = await ytDlp(['-J', '--no-playlist', '--skip-download', '--no-warnings',
      ...cookieArgs(), WATCH_URL(id)], 30000);
    const info = JSON.parse(out);
    res.json({
      ok: true,
      id,
      title: info.title || '',
      channel: info.channel || info.uploader || '',
      channelId: info.channel_id || '',
      duration: (typeof info.duration === 'number') ? Math.round(info.duration) : null,
      viewCount: (typeof info.view_count === 'number') ? info.view_count : null,
      isLive: !!info.is_live,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.type || 'resolve-failed', detail: e.stderr || '' });
  }
});

// ---- Search ----------------------------------------------------------------
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!q) return res.status(400).json({ ok: false, error: 'Missing q' });
  try {
    const out = await ytDlp(['--flat-playlist', '--no-warnings', '-J',
      ...cookieArgs(), 'ytsearch20:' + q], 45000);
    const data = JSON.parse(out);
    const results = (data.entries || []).map(mapFlatEntry).filter(Boolean);
    res.json({ ok: true, source: 'yt-dlp', query: q, results });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.type || 'search-failed', detail: e.stderr || '' });
  }
});

// ---- Trending ---------------------------------------------------------------
const PIPED_TRENDING = [
  'https://pipedapi.kavin.rocks/trending',
  'https://api.piped.video/trending',
  'https://pipedapi.adminforge.de/trending',
  'https://api.piped.private.coffee/trending',
];
const INVIDIOUS_TRENDING = [
  'https://inv.nadeko.net/api/v1/trending',
  'https://yewtu.be/api/v1/trending',
  'https://invidious.materialio.us/api/v1/trending',
];

async function fetchJson(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'tesla-youtube-drive/1.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

app.get('/api/trending', async (req, res) => {
  const region = /^[A-Za-z]{2}$/.test(String(req.query.region || ''))
    ? String(req.query.region).toUpperCase() : 'US';
  const attempts = [];

  // Path 1: yt-dlp on the YouTube trending feed.
  try {
    const out = await ytDlp(['--flat-playlist', '--no-warnings', '-J',
      ...cookieArgs(), 'https://www.youtube.com/feed/trending'], 45000);
    const data = JSON.parse(out);
    const results = (data.entries || []).map(mapFlatEntry).filter(Boolean);
    if (results.length >= 5) {
      return res.json({ ok: true, source: 'yt-dlp', region, results });
    }
    attempts.push('yt-dlp: only ' + results.length + ' entries');
  } catch (e) {
    attempts.push('yt-dlp: ' + (e.type || 'failed'));
  }

  // Path 2: public Piped instances.
  for (const base of PIPED_TRENDING) {
    try {
      const items = await fetchJson(base + '?region=' + region);
      const results = (Array.isArray(items) ? items : []).map(mapPipedItem).filter(Boolean);
      if (results.length) return res.json({ ok: true, source: 'piped', region, results });
      attempts.push(base + ': empty');
    } catch (e) { attempts.push(base + ': ' + e.message); }
  }

  // Path 3: public Invidious instances.
  for (const base of INVIDIOUS_TRENDING) {
    try {
      const items = await fetchJson(base + '?region=' + region);
      const results = (Array.isArray(items) ? items : []).map(mapInvidiousItem).filter(Boolean);
      if (results.length) return res.json({ ok: true, source: 'invidious', region, results });
      attempts.push(base + ': empty');
    } catch (e) { attempts.push(base + ': ' + e.message); }
  }

  res.status(502).json({ ok: false, error: 'trending-unavailable', attempts });
});

// ---- Channel (latest videos from one channel) -------------------------------
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
app.get('/api/channel', async (req, res) => {
  const id = String(req.query.id || '');
  if (!CHANNEL_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'Invalid channel id' });
  const attempts = [];

  // Path 1: yt-dlp on the channel's Videos tab (flat playlist, latest first).
  try {
    const out = await ytDlp(['--flat-playlist', '--playlist-end', '30', '--no-warnings', '-J',
      ...cookieArgs(), 'https://www.youtube.com/channel/' + id + '/videos'], 45000);
    const data = JSON.parse(out);
    const results = (data.entries || []).map(mapFlatEntry).filter(Boolean);
    if (results.length) {
      return res.json({ ok: true, source: 'yt-dlp',
        channel: { id, name: String(data.title || results[0].channel || '') }, results });
    }
    attempts.push('yt-dlp: empty');
  } catch (e) { attempts.push('yt-dlp: ' + (e.type || 'failed')); }

  // Path 2: public Piped instances' channel endpoint.
  for (const base of PIPED_TRENDING) {
    const api = base.replace(/\/trending$/, '');
    try {
      const d = await fetchJson(api + '/channel/' + id);
      const results = (Array.isArray(d.relatedStreams) ? d.relatedStreams : [])
        .map(mapPipedItem).filter(Boolean);
      if (results.length) {
        return res.json({ ok: true, source: 'piped',
          channel: { id, name: String(d.name || results[0].channel || '') }, results });
      }
      attempts.push(api + ': empty');
    } catch (e) { attempts.push(api + ': ' + e.message); }
  }

  // Path 3: public Invidious instances' channel-videos endpoint.
  for (const base of INVIDIOUS_TRENDING) {
    const api = base.replace(/\/trending$/, '');
    try {
      const items = await fetchJson(api + '/channels/' + id + '/videos');
      const results = (Array.isArray(items) ? items : []).map(mapInvidiousItem).filter(Boolean);
      if (results.length) {
        return res.json({ ok: true, source: 'invidious',
          channel: { id, name: results[0].channel || '' }, results });
      }
      attempts.push(api + ': empty');
    } catch (e) { attempts.push(api + ': ' + e.message); }
  }

  res.status(502).json({ ok: false, error: 'channel-unavailable', attempts });
});

// ---- Audio (separate MP3 pipe, as in the original repo) --------------------
function streamMp3(req, res, inputUrl, startSeconds = 0) {
  if (activeStreams >= MAX_STREAMS) {
    return res.status(503).json({ ok: false, error: 'server-busy' });
  }
  activeStreams++;
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-cache, no-store',
    'Access-Control-Allow-Origin': '*',
  });
  const ffmpeg = spawn('ffmpeg', [
    ...seekArgs(startSeconds),
    '-re', '-reconnect', '1',
    '-reconnect_streamed', '1', '-reconnect_delay_max', '30',
    '-i', inputUrl, '-vn',
    '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-analyzeduration', '0', '-probesize', '32',
    '-c:a', 'libmp3lame', '-b:a', '48k', '-ar', '22050', '-ac', '1',
    '-f', 'mp3', '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  ffmpeg.stdout.pipe(res);
  ffmpeg.stderr.on('data', () => {});
  ffmpeg.on('error', () => { try { res.end(); } catch (e) {} });
  ffmpeg.on('close', () => { activeStreams--; try { res.end(); } catch (e) {} });
  req.on('close', () => { try { ffmpeg.kill(); } catch (e) {} });
}

app.get('/api/audio', async (req, res) => {
  const startSeconds = parseSeekOffset(req.query.t ?? req.query.start);
  if (startSeconds === null) return res.status(400).json({ ok: false, error: 'Invalid t (seek offset in seconds)' });
  if (req.query.url) {
    const direct = await validateDirectUrl(String(req.query.url));
    if (!direct) return res.status(400).json({ ok: false, error: 'Invalid url' });
    return streamMp3(req, res, direct, startSeconds);
  }
  const id = String(req.query.v || '');
  if (!VIDEO_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'Invalid video id' });
  try {
    const audioUrl = await resolveStream(id, 'bestaudio[ext=m4a]/bestaudio/best');
    // The resolve can take up to 30s; if the client gave up meanwhile,
    // spawning ffmpeg now would leave it transcoding into a dead socket
    // with no close event left to kill it.
    if (res.destroyed) return;
    streamMp3(req, res, audioUrl, startSeconds);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.type || 'resolve-failed', detail: e.stderr || '' });
  }
});

// ==========================================================================
// WebSocket: MPEG1-TS video (never a <video> element on the client)
// ==========================================================================
// Optional built-in HTTPS: set BOTH TLS_CERT and TLS_KEY to PEM file
// paths and the same port serves HTTPS + WSS instead of HTTP + WS.
// (The more common setup is a reverse proxy / tunnel terminating TLS in
// front of the plain-HTTP server — see README "HTTPS". A self-signed
// cert works for LAN use, but the Tesla browser may refuse it.)
const TLS_CERT = process.env.TLS_CERT || '';
const TLS_KEY = process.env.TLS_KEY || '';
let server, SCHEME = 'http';
if (TLS_CERT && TLS_KEY) {
  server = https.createServer({
    cert: fs.readFileSync(TLS_CERT),
    key: fs.readFileSync(TLS_KEY),
  }, app);
  SCHEME = 'https';
} else {
  if (TLS_CERT || TLS_KEY) {
    console.warn('TLS_CERT/TLS_KEY: only one is set — serving plain HTTP. Set BOTH to enable built-in HTTPS.');
  }
  server = http.createServer(app);
}
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) {}
  if (pathname === '/ws/mpeg1') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', async (ws, req) => {
  const sendJson = (obj) => {
    if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
  };
  let params;
  try { params = new URL(req.url, 'http://localhost').searchParams; }
  catch (e) { ws.close(); return; }

  const quality = parseQuality(params.get('quality'));
  const q = QUALITY[quality];
  const startSeconds = parseSeekOffset(params.get('t') ?? params.get('start'));
  if (startSeconds === null) {
    sendJson({ type: 'error', message: 'Invalid ?t= (seek offset in seconds)' });
    ws.close();
    return;
  }
  // mode=combined: audio is muxed into the same MPEG-TS as MP2 and decoded
  // by JSMpeg — one stream, one clock, inherently in sync.
  // mode=separate (default): video only here; audio comes from /api/audio.
  const combined = params.get('mode') === 'combined';
  // live=1: the client knows the source is a live stream. Live stays
  // realtime-paced; on-demand video is encoded as fast as the CPU allows
  // (see inputArgs below) so the client can bank a buffer lead.
  const isLive = params.get('live') === '1';
  let inputUrl = null;
  let audioUrl = null;

  const direct = params.get('url');
  const videoId = params.get('v');
  if (direct) {
    inputUrl = await validateDirectUrl(direct);
    if (!inputUrl) { sendJson({ type: 'error', message: 'Invalid ?url=' }); ws.close(); return; }
  } else if (videoId && VIDEO_ID_RE.test(videoId)) {
    sendJson({ type: 'status', message: 'Resolving YouTube video...' });
    try {
      const videoFormat = 'bestvideo[height<=' + quality + '][ext=mp4]/bestvideo[height<=' + quality + ']/bestvideo/best';
      if (combined) {
        // Resolve both pipes up front so they start from the same offset
        // at the same moment — the separate-pipe mode can drift because
        // the audio pipe starts seconds before the video pipe exists.
        const pair = await Promise.all([
          resolveStream(videoId, videoFormat),
          resolveStream(videoId, 'bestaudio[ext=m4a]/bestaudio/best'),
        ]);
        inputUrl = pair[0];
        audioUrl = pair[1];
      } else {
        inputUrl = await resolveStream(videoId, videoFormat);
      }
    } catch (e) {
      sendJson({ type: 'error', error: e.type || 'resolve-failed',
        message: e.type === 'bot-blocked'
          ? 'YouTube blocked this server (sign-in/bot check). Try a residential connection or YT_DLP_COOKIES.'
          : 'Could not resolve this video (' + (e.type || 'error') + ')' });
      ws.close();
      return;
    }
  } else {
    sendJson({ type: 'error', message: 'Missing or invalid ?v=VIDEOID or ?url=' });
    ws.close();
    return;
  }

  if (ws.readyState !== 1) return;
  sendJson({
    type: 'status',
    startSeconds,
    mode: combined ? 'combined' : 'separate',
    message: 'Starting MPEG1-TS stream (' + quality + 'p, ' +
      (combined ? 'combined A/V' : 'video only') + ') at ' + startSeconds + 's...',
  });

  // Pacing: on-demand videos are encoded at a CAPPED 2x realtime
  // (-readrate). The cap matters: an earlier fully-unpaced build flooded
  // JSMpeg, whose sync loop is built around a realtime-fed stream — the
  // car reported audio racing ahead of the picture and heavy stutter.
  // But even a steady 2x DELIVERY is too much in Compat mode: the
  // video-only JSMpeg player has no audio clock to throttle against, and
  // the car showed the picture playing at visibly increased speed
  // whenever a backlog built up, burning the bank and collapsing into
  // Buffering every few seconds. So delivery is paced a second time,
  // here in the WebSocket writer: the first ~10 media-seconds go out
  // immediately (fast start / pre-roll), then the pipe is throttled to
  // ~1.1x realtime — a small, steady lead the renderer cannot race
  // through, which still outruns playback enough to absorb jitter.
  // Live streams and direct ?url= sources stay at 1x end to end: there
  // is no "ahead" to run to.
  const pacedRealtime = !!direct || isLive || process.env.FFMPEG_PACING === 'realtime';
  const paceArgs = pacedRealtime
    ? ['-re']
    : (FFMPEG_READRATE
      ? ['-readrate', '2', ...(FFMPEG_READRATE_BURST ? ['-readrate_initial_burst', '10'] : [])]
      : ['-re']);
  const inputArgs = [
    ...paceArgs,
    '-reconnect', '1',
    '-reconnect_streamed', '1', '-reconnect_delay_max', '30',
  ];
  let ffmpegArgs;
  if (combined && audioUrl) {
    // One ffmpeg, two inputs seeked to the same offset, one output stream:
    // video MPEG1 + audio MP2 muxed together. JSMpeg decodes both from the
    // same timestamps, so lip sync is exact by construction.
    ffmpegArgs = [
      ...seekArgs(startSeconds), ...inputArgs, '-i', inputUrl,
      ...seekArgs(startSeconds), ...inputArgs, '-i', audioUrl,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'mpeg1video', '-q:v', '5', '-b:v', q.bitrate,
      '-bf', '0', '-g', '30',
      '-vf', 'fps=30,scale=' + q.scale + ':force_original_aspect_ratio=decrease,pad=' + q.scale + ':(ow-iw)/2:(oh-ih)/2',
      '-c:a', 'mp2', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-f', 'mpegts',
      '-muxdelay', '0.1', '-muxpreload', '0',
      '-',
    ];
  } else if (combined) {
    // Direct media URL: audio (if any) lives in the same source.
    ffmpegArgs = [
      ...seekArgs(startSeconds), ...inputArgs, '-i', inputUrl,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'mpeg1video', '-q:v', '5', '-b:v', q.bitrate,
      '-bf', '0', '-g', '30',
      '-vf', 'fps=30,scale=' + q.scale + ':force_original_aspect_ratio=decrease,pad=' + q.scale + ':(ow-iw)/2:(oh-ih)/2',
      '-c:a', 'mp2', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-f', 'mpegts',
      '-muxdelay', '0.1', '-muxpreload', '0',
      '-',
    ];
  } else {
    ffmpegArgs = [
      ...seekArgs(startSeconds), ...inputArgs, '-i', inputUrl, '-an',
      '-c:v', 'mpeg1video', '-q:v', '5', '-b:v', q.bitrate,
      '-bf', '0', '-g', '30',
      '-vf', 'fps=30,scale=' + q.scale + ':force_original_aspect_ratio=decrease,pad=' + q.scale + ':(ow-iw)/2:(oh-ih)/2',
      '-f', 'mpegts',
      '-muxdelay', '0.1', '-muxpreload', '0',
      '-',
    ];
  }
  if (activeStreams >= MAX_STREAMS) {
    sendJson({ type: 'error', message: 'Server busy: too many concurrent streams (max ' + MAX_STREAMS + ')' });
    try { ws.close(); } catch (e) {}
    return;
  }
  activeStreams++;
  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  // Backpressure (all streams): if the client falls behind, PAUSE
  // ffmpeg's output pipe instead of dropping chunks. Dropping MPEG1
  // chunks corrupts the picture until the next keyframe (visible
  // smearing/freezing); pausing lets TCP and the pipe throttle the
  // encoder to what the client can consume.
  let bpTimer = null;
  let drainTimer = null;
  let ffmpegEnded = false, ffmpegEndCode = null;
  const sendDirect = (chunk) => {
    if (ws.readyState !== 1) return;
    try { ws.send(chunk); } catch (e) {}
    if (ws.bufferedAmount > 16 * 1024 * 1024 && !bpTimer) {
      ffmpeg.stdout.pause();
      bpTimer = setInterval(() => {
        if (ws.readyState !== 1 || ws.bufferedAmount < 4 * 1024 * 1024) {
          clearInterval(bpTimer); bpTimer = null;
          try { ffmpeg.stdout.resume(); } catch (e) {}
        }
      }, 100);
    }
  };
  if (pacedRealtime) {
    ffmpeg.stdout.on('data', sendDirect);
  } else {
    // Delivery pacer for VOD (see the pacing note above): ffmpeg may
    // produce at up to 2x, but the socket only releases a ~10
    // media-second burst plus a ~1.1x realtime trickle. Produced chunks
    // wait in a small queue; the existing close path flushes the queue
    // before it reports the stream ended, so the tail is never cut.
    const kbps = (parseInt(q.bitrate, 10) || 1100) + (combined ? 128 : 0);
    const bytesPerSec = kbps * 1000 / 8 * 1.06; // + MPEG-TS overhead
    const burstBytes = 10 * bytesPerSec;
    const pending = [];
    let pendingBytes = 0, sentBytes = 0, paceStart = 0;
    ffmpeg.stdout.on('data', (chunk) => {
      if (!paceStart) paceStart = Date.now();
      pending.push(chunk); pendingBytes += chunk.length;
      if (pendingBytes > 16 * 1024 * 1024) { try { ffmpeg.stdout.pause(); } catch (e) {} }
    });
    drainTimer = setInterval(() => {
      // A client that vanished without a clean close (browser killed,
      // network drop) must not leave a zombie transcode running: the
      // send failures below are swallowed by design, so check liveness
      // explicitly and tear the stream down.
      if (ws.readyState !== 1) { killFfmpeg(); return; }
      const elapsedSec = paceStart ? (Date.now() - paceStart) / 1000 : 0;
      const allowance = burstBytes + elapsedSec * 1.1 * bytesPerSec;
      while (pending.length && ws.bufferedAmount < 16 * 1024 * 1024) {
        const next = pending[0];
        if (sentBytes > 0 && sentBytes + next.length > allowance) break;
        pending.shift(); pendingBytes -= next.length;
        try { ws.send(next); } catch (e) {}
        sentBytes += next.length;
      }
      if (pendingBytes < 4 * 1024 * 1024) { try { ffmpeg.stdout.resume(); } catch (e) {} }
      if (ffmpegEnded && pendingBytes === 0) finishStream();
    }, 50);
  }
  // Keep the tail of ffmpeg's stderr: if it exits instantly (bad option,
  // dead input), the reason lands in the server log AND the client's
  // status line instead of a silent "Stream ended".
  let stderrTail = '';
  ffmpeg.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-600);
  });
  ffmpeg.on('error', (e) => { sendJson({ type: 'error', message: e.message.slice(0, 120) }); });
  // finishStream reports the end exactly once — immediately for the
  // direct path, or after the pacer queue has flushed for VOD, so the
  // pacer can never truncate the tail of a finished video.
  let streamFinished = false;
  function finishStream() {
    if (streamFinished) return;
    streamFinished = true;
    const code = ffmpegEndCode;
    if (bpTimer) { clearInterval(bpTimer); bpTimer = null; }
    if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
    const tail = stderrTail.trim().split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 220);
    if (code !== 0 && tail) console.error('ffmpeg exited (code ' + code + '): ' + tail);
    sendJson({ type: 'status', message: 'Stream ended (code ' + code + ')' + (code !== 0 && tail ? ': ' + tail : '') });
    try { ws.close(); } catch (e) {}
  }
  ffmpeg.on('close', (code) => {
    activeStreams--;
    ffmpegEnded = true; ffmpegEndCode = code;
    if (!drainTimer) finishStream(); // direct path: nothing queued
    // pacer path: the drain loop calls finishStream once flushed
  });
  const killFfmpeg = () => {
    if (bpTimer) { clearInterval(bpTimer); bpTimer = null; }
    if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
    try { ffmpeg.kill(); } catch (e) {}
  };
  ws.on('close', killFfmpeg);
  ws.on('error', killFfmpeg);
});

server.listen(PORT, HOST, () => {
  console.log('Tesla YouTube Drive running on ' + SCHEME + '://' + HOST + ':' + PORT);
  console.log('  Client : ' + SCHEME + '://' + HOST + ':' + PORT + '/youtube-client/');
  console.log('  Probe  : ' + SCHEME + '://' + HOST + ':' + PORT + '/probe/');
  console.log('  yt-dlp : ' + YT_DLP + (YT_DLP_COOKIES ? ' (cookies file configured)' : ''));
});
