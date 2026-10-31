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
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const YT_DLP = process.env.YT_DLP || 'yt-dlp';
const YT_DLP_COOKIES = process.env.YT_DLP_COOKIES || '';

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

// Validate a direct-media ?url= parameter (used for testing / advanced use).
function validateDirectUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) return null;
  if (/^127\./.test(host) || host === '::1') return null;
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return null;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return null;
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
  fs.writeFile(filename, JSON.stringify(req.body || {}, null, 2), () => {});
  res.json({ ok: true });
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
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-cache, no-store',
    'Access-Control-Allow-Origin': '*',
  });
  const ffmpeg = spawn('ffmpeg', [
    ...seekArgs(startSeconds),
    '-re', '-reconnect', '1', '-reconnect_at_eof', '1',
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
  ffmpeg.on('close', () => { try { res.end(); } catch (e) {} });
  req.on('close', () => { try { ffmpeg.kill(); } catch (e) {} });
}

app.get('/api/audio', async (req, res) => {
  const startSeconds = parseSeekOffset(req.query.t ?? req.query.start);
  if (startSeconds === null) return res.status(400).json({ ok: false, error: 'Invalid t (seek offset in seconds)' });
  if (req.query.url) {
    const direct = validateDirectUrl(String(req.query.url));
    if (!direct) return res.status(400).json({ ok: false, error: 'Invalid url' });
    return streamMp3(req, res, direct, startSeconds);
  }
  const id = String(req.query.v || '');
  if (!VIDEO_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'Invalid video id' });
  try {
    const audioUrl = await resolveStream(id, 'bestaudio[ext=m4a]/bestaudio/best');
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
    inputUrl = validateDirectUrl(direct);
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

  // Pacing: for on-demand YouTube videos, ffmpeg is deliberately NOT
  // paced to realtime (no -re): it encodes as fast as the CPU allows, so
  // during good network moments the client banks a buffer lead that
  // carries playback through stalls. The backpressure below throttles
  // the encoder once enough data is queued, so the burst is self-limiting.
  // Live streams and direct ?url= sources stay paced — there is no
  // "ahead" to run to, and unpaced reads of a live edge just buffer-spin.
  const pacedRealtime = !!direct || isLive;
  const inputArgs = [
    ...(pacedRealtime ? ['-re'] : []),
    '-reconnect', '1', '-reconnect_at_eof', '1',
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
      '-vf', 'fps=30,scale=' + q.scale,
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
      '-vf', 'fps=30,scale=' + q.scale,
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
      '-vf', 'fps=30,scale=' + q.scale,
      '-f', 'mpegts',
      '-muxdelay', '0.1', '-muxpreload', '0',
      '-',
    ];
  }
  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  // Backpressure: if the client falls behind, PAUSE ffmpeg's output pipe
  // instead of dropping chunks. Dropping MPEG1 chunks corrupts the picture
  // until the next keyframe (visible smearing/freezing); pausing lets TCP
  // and the pipe throttle the encoder to what the client can consume. The
  // window is deliberately wide (pause at 16 MB queued, resume at 4 MB)
  // so an unpaced VOD encode can bank a real buffer lead in the client.
  let bpTimer = null;
  ffmpeg.stdout.on('data', (chunk) => {
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
  });
  ffmpeg.stderr.on('data', () => {});
  ffmpeg.on('error', (e) => { sendJson({ type: 'error', message: e.message.slice(0, 120) }); });
  ffmpeg.on('close', (code) => {
    if (bpTimer) { clearInterval(bpTimer); bpTimer = null; }
    sendJson({ type: 'status', message: 'Stream ended (code ' + code + ')' });
    try { ws.close(); } catch (e) {}
  });
  const killFfmpeg = () => {
    if (bpTimer) { clearInterval(bpTimer); bpTimer = null; }
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
