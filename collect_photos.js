/**
 * Standalone photo collector for @MotionAsistente_bot.
 * Polls Telegram for new photo messages and saves them to Images directory.
 * Run: node collect_photos.js
 * Send photos to the bot while this is running. Press Ctrl+C when done.
 */
require('dotenv').config();
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const TOKEN  = process.env.TELEGRAM_TOKEN;
const OUTDIR = process.env.PHOTOS_DIR || 'C:/Users/M11/Desktop/YouTube_Pipeline/EN_Motivation_Finance/Images';
const API    = `https://api.telegram.org/bot${TOKEN}`;

fs.mkdirSync(OUTDIR, { recursive: true });

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function apiCall(method, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const buf = await get(`${API}/${method}${qs ? '?' + qs : ''}`);
  return JSON.parse(buf.toString());
}

function nextPrefix(dir) {
  const files = fs.readdirSync(dir).filter(f => /^\d{2}/.test(f));
  if (!files.length) return 1;
  const nums = files.map(f => parseInt(f.slice(0, 2))).filter(n => !isNaN(n));
  return Math.max(...nums) + 1;
}

async function downloadPhoto(fileId, destPath) {
  const info = await apiCall('getFile', { file_id: fileId });
  if (!info.ok) throw new Error('getFile failed');
  const data = await get(`https://api.telegram.org/file/bot${TOKEN}/${info.result.file_path}`);
  fs.writeFileSync(destPath, data);
  return data.length;
}

let offset   = 0;
let received = 0;

async function poll() {
  try {
    const res = await apiCall('getUpdates', { offset, limit: 100, timeout: 30 });
    if (!res.ok) return;

    for (const update of res.result) {
      offset = update.update_id + 1;
      const msg = update.message || update.channel_post;
      if (!msg) continue;

      // Handle photo messages
      if (msg.photo?.length) {
        const best   = msg.photo[msg.photo.length - 1];
        const prefix = String(nextPrefix(OUTDIR)).padStart(2, '0');
        const label  = (msg.caption || `photo_${received + 1}`)
          .replace(/[^a-z0-9_]/gi, '_').slice(0, 30).replace(/_+/g, '_').replace(/^_|_$/g, '');
        const dest = path.join(OUTDIR, `${prefix}_${label}.jpg`);

        try {
          const size = await downloadPhoto(best.file_id, dest);
          console.log(`[SAVED] ${path.basename(dest)} (${Math.round(size / 1024)}KB)`);
          received++;
        } catch (e) {
          console.error(`[ERROR] ${e.message}`);
        }
      }

      // Handle image documents
      if (msg.document?.mime_type?.startsWith('image/')) {
        const prefix = String(nextPrefix(OUTDIR)).padStart(2, '0');
        const label  = (msg.document.file_name || `doc_${received + 1}`)
          .replace(/\.[^.]+$/, '').replace(/[^a-z0-9_]/gi, '_').slice(0, 30);
        const ext  = msg.document.mime_type === 'image/png' ? '.png' : '.jpg';
        const dest = path.join(OUTDIR, `${prefix}_${label}${ext}`);

        try {
          const size = await downloadPhoto(msg.document.file_id, dest);
          console.log(`[SAVED] ${path.basename(dest)} (${Math.round(size / 1024)}KB)`);
          received++;
        } catch (e) {
          console.error(`[ERROR] ${e.message}`);
        }
      }
    }
  } catch (e) {
    if (!e.message.includes('ECONNRESET')) console.error('[Poll error]', e.message);
  }
}

async function main() {
  console.log(`Photo collector for @MotionAsistente_bot`);
  console.log(`Saving to: ${OUTDIR}`);
  console.log(`\nSend photos to the bot now. Press Ctrl+C when done.\n`);

  // Set offset to current update_id so we only get NEW photos from now
  const info = await apiCall('getUpdates', { limit: 1, offset: -1 });
  if (info.result?.length) offset = info.result[0].update_id + 1;

  while (true) {
    await poll();
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
