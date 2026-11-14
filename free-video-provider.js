'use strict';
// Free / self-hosted video-to-video provider.
// Talks to any Gradio app (for example a Hugging Face Space running a Wan / LTX / AnimateDiff
// video-to-video demo, or your own Colab/Kaggle/PC server exposed over HTTPS).
// No paid credits are needed by this code, but free Spaces can be slow, queued or asleep.

const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAX_OUTPUT_BYTES = 250 * 1024 * 1024;

function baseUrl() {
  const raw = String(process.env.HF_SPACE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('HF_SPACE_URL must use https (http is allowed only for localhost).');
  }
  return url.toString().replace(/\/+$/, '');
}

function authHeaders() {
  return process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {};
}

async function request(url, options = {}, timeoutMs = 30000) {
  const response = await fetch(url, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) }, signal: options.signal || AbortSignal.timeout(timeoutMs) });
  return response;
}

async function uploadFile(base, filePath, mime) {
  for (const route of ['/gradio_api/upload', '/upload']) {
    const form = new FormData();
    form.append('files', await fs.openAsBlob(filePath, { type: mime }), path.basename(filePath));
    const response = await request(`${base}${route}`, { method: 'POST', body: form }, 5 * 60 * 1000);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`Free AI server rejected the video upload (${response.status}).`);
    const files = await response.json();
    if (!Array.isArray(files) || typeof files[0] !== 'string') throw new Error('Free AI server returned an unexpected upload response.');
    return files[0];
  }
  throw new Error('Free AI server has no Gradio upload endpoint. Check HF_SPACE_URL.');
}

function findVideoUrl(value, base) {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return value;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = findVideoUrl(item, base); if (found) return found; }
  } else if (value && typeof value === 'object') {
    if (typeof value.url === 'string' && value.url) return /^https?:\/\//i.test(value.url) ? value.url : new URL(value.url, base + '/').toString();
    if (typeof value.path === 'string' && value.path && !value.url) return `${base}/gradio_api/file=${value.path}`;
    for (const key of ['video', 'value', 'data', 'output']) {
      if (value[key]) { const found = findVideoUrl(value[key], base); if (found) return found; }
    }
  }
  return null;
}

// Gradio streams Server-Sent Events: "event: complete" + "data: [...]" or "event: error".
function parseSse(text) {
  const events = [];
  let name = 'message';
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) events.push({ name, data: line.slice(5).trim() });
  }
  return events;
}

async function transformVideoWithFreeProvider({ inputPath, outputPath, prompt, onProgress = () => {}, isCancelled = () => false, maxWaitMs = 20 * 60 * 1000 }) {
  const base = baseUrl();
  if (!base) throw new Error('Free AI Visual Change needs HF_SPACE_URL (a Gradio / Hugging Face Space URL) in the environment.');
  if (!fs.existsSync(inputPath)) throw new Error('The prepared source video is no longer available. Upload it again.');
  if (typeof prompt !== 'string' || prompt.trim().length < 8 || prompt.trim().length > 1500) throw new Error('Enter a visual transformation prompt between 8 and 1,500 characters.');
  if (typeof fs.openAsBlob !== 'function') throw new Error('Free AI Visual Change requires Node.js 20.11 or newer.');

  const apiName = String(process.env.HF_API_NAME || 'predict').replace(/^\/+/, '');
  const order = String(process.env.HF_INPUT_ORDER || 'video,prompt').split(',').map(x => x.trim()).filter(Boolean);
  const extra = (() => { try { return JSON.parse(process.env.HF_EXTRA_INPUTS || '[]'); } catch { throw new Error('HF_EXTRA_INPUTS must be a JSON array.'); } })();
  if (!Array.isArray(extra)) throw new Error('HF_EXTRA_INPUTS must be a JSON array.');

  onProgress(8, 'Uploading video to the free AI server');
  const remotePath = await uploadFile(base, inputPath, 'video/mp4');
  const fileData = { path: remotePath, meta: { _type: 'gradio.FileData' } };
  const data = order.map(slot => slot === 'video' ? fileData : slot === 'prompt' ? prompt.trim() : null).concat(extra);

  onProgress(15, 'Queued on the free AI server (can take a while)');
  let call = null;
  for (const route of ['/gradio_api/call', '/call']) {
    const response = await request(`${base}${route}/${encodeURIComponent(apiName)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`Free AI server rejected the request (${response.status}). Check HF_API_NAME and HF_INPUT_ORDER for your Space.`);
    call = { route, ...(await response.json()) };
    break;
  }
  if (!call?.event_id) throw new Error('Free AI server did not return an event id. Check that HF_SPACE_URL is a running Gradio app.');
  if (isCancelled()) throw new Error('AI Visual Change was cancelled.');

  const started = Date.now();
  const ticker = setInterval(() => onProgress(Math.min(82, 18 + Math.floor((Date.now() - started) / maxWaitMs * 64)), 'Free AI model is transforming the video'), 5000);
  let result;
  try {
    const stream = await request(`${base}${call.route}/${encodeURIComponent(apiName)}/${call.event_id}`, {}, maxWaitMs);
    if (!stream.ok) throw new Error(`Free AI server status check failed (${stream.status}).`);
    const events = parseSse(await stream.text());
    const error = events.find(e => e.name === 'error');
    const complete = [...events].reverse().find(e => e.name === 'complete');
    if (!complete) throw new Error(`Free AI model failed or timed out${error && error.data && error.data !== 'null' ? ': ' + error.data.slice(0, 300) : ' (the free Space may be busy, asleep or out of GPU quota). Try again later.'}`);
    result = JSON.parse(complete.data);
  } finally { clearInterval(ticker); }

  const outputUrl = findVideoUrl(result, base);
  if (!outputUrl) throw new Error('The free AI server finished but returned no downloadable video.');
  if (isCancelled()) throw new Error('AI Visual Change was cancelled.');

  onProgress(88, 'Downloading transformed video');
  const response = await request(outputUrl, {}, 120000);
  if (!response.ok || !response.body) throw new Error(`Could not download the transformed video (${response.status}).`);
  let total = 0;
  const limiter = new Transform({ transform(chunk, _e, cb) { total += chunk.length; if (total > MAX_OUTPUT_BYTES) return cb(new Error('Transformed output exceeds the 250 MB safety limit.')); cb(null, chunk); } });
  await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }));
  onProgress(96, 'Validating transformed video');
  return { provider: 'Free open-source model (Gradio/Hugging Face)', outputBytes: total, model: apiName };
}

module.exports = { transformVideoWithFreeProvider, parseSse, findVideoUrl };
