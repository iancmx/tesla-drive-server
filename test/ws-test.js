'use strict';
/*
 * End-to-end pipeline proof: connect to /ws/mpeg1 with a direct media
 * URL and verify that MPEG1-TS bytes actually arrive.
 *
 * Usage: node test/ws-test.js [mediaUrl] [seconds]
 * Default media: a small public sample MP4.
 */
const WebSocket = require('ws');

const media = process.argv[2] ||
  'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const seconds = parseInt(process.argv[3], 10) || 8;
const port = process.env.PORT || 8742;

const url = 'ws://127.0.0.1:' + port + '/ws/mpeg1?url=' +
  encodeURIComponent(media) + '&quality=360';
console.log('Connecting:', url.replace(/url=[^&]+/, 'url=<media>'));

const ws = new WebSocket(url);
let bytes = 0, chunks = 0, syncPackets = 0, firstByteChecked = false;
let textFrames = [];

ws.on('message', (data, isBinary) => {
  if (!isBinary) { textFrames.push(data.toString()); return; }
  if (!firstByteChecked) {
    firstByteChecked = true;
    console.log('First binary chunk: ' + data.length + ' bytes, first byte 0x' +
      data[0].toString(16) + (data[0] === 0x47 ? ' (TS sync ✓)' : ' (NOT TS sync ✗)'));
  }
  bytes += data.length; chunks++;
  // Count TS packets: 188-byte packets each starting with 0x47.
  for (let off = 0; off + 188 <= data.length; off += 188) {
    if (data[off] === 0x47) syncPackets++;
    else break;
  }
});
ws.on('error', (e) => { console.error('WS error:', e.message); });

setTimeout(() => {
  console.log('Text frames from server:', JSON.stringify(textFrames));
  console.log('Received: ' + bytes + ' bytes in ' + chunks + ' chunks, ' +
    syncPackets + ' TS packets with 0x47 sync byte');
  const ok = bytes > 10000 && syncPackets > 50;
  console.log(ok ? 'PIPELINE OK ✓' : 'PIPELINE FAILED ✗ (too little/no TS data)');
  try { ws.close(); } catch (e) {}
  process.exit(ok ? 0 : 1);
}, seconds * 1000);
