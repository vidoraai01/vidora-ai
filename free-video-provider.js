'use strict';
// Free / self-hosted AI provider for any Gradio app (for example a Hugging Face Space, or your own
// Colab/Kaggle/PC server exposed over HTTPS). One generic adapter, three uses:
//   prefix HF    -> AI Visual Change (video-to-video restyle)
//   prefix PHOTO -> Photo Enhance (image-to-image, e.g. an upscaler/enhancer Space)
//   prefix VENH  -> Video Enhance (video-to-video upscaler/enhancer Space)
// Settings per prefix: <P>_SPACE_URL, <P>_API_NAME, <P>_INPUT_ORDER, <P>_EXTRA_INPUTS, <P>_OUTPUT_INDEX.
// HF_TOKEN (optional) is shared. No paid credits are needed, but free Spaces can be slow, queued or
// out of GPU quota.

const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAX_OUTPUT_BYTES = 250 * 1024 * 1024;
const FILE_SLOTS = new Set(['video', 'image', 'file']);

const setting = (prefix, key) => process.env[`${prefix}_${key}`];

function baseUrl(prefix) {
  const raw = String(setting(prefix, 'SPACE_URL') || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error(`${prefix}_SPACE_URL must use https (http is allowed only for localhost).`);
  }
  return url.toString().replace(/\/+$/, '');
}

function isConfigured(prefix) { return Boolean(String(setting(prefix, 'SPACE_URL') || '').trim()); }

function authHeaders() {
  return process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {};
}

async function request(url, options = {}, timeoutMs = 30000) {
  return fetch(url, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) }, signal: options.signal || AbortSignal.timeout(timeoutMs) });
}

async function uploadFile(base, filePath, mime) {
  for (const route of ['/gradio_api/upload', '/upload']) {
    const form = new FormData();
    form.append('files', await fs.openAsBlob(filePath, { type: mime }), path.basename(filePath));
    const response = await request(`${base}${route}`, { method: 'POST', body: form }, 5 * 60 * 1000);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`Free AI server rejected the file upload (${response.status}).`);
    const files = await response.json();
    if (!Array.isArray(files) || typeof files[0] !== 'string') throw new Error('Free AI server returned an unexpected upload response.');
    return files[0];
  }
  throw new Error('Free AI server has no Gradio upload endpoint. Check the SPACE_URL setting.');
}

// Collect every downloadable file URL in the result, in order.
function collectUrls(value, base, out = []) {
  if (typeof value === 'string') { if (/^https?:\/\//i.test(value)) out.push(value); return out; }
  if (Array.isArray(value)) { value.forEach(item => collectUrls(item, base, out)); return out; }
  if (value && typeof value === 'object') {
    if (typeof value.url === 'string' && value.url) { out.push(/^https?:\/\//i.test(value.url) ? value.url : new URL(value.url, base + '/').toString()); return out; }
    if (typeof value.path === 'string' && value.path) { out.push(`${base}/gradio_api/file=${value.path}`); return out; }
    for (const key of ['video', 'image', 'value', 'data', 'output']) if (value[key]) collectUrls(value[key], base, out);
  }
  return out;
}

// index 0 = first file, 1 = second, -1 = last (e.g. before/after sliders return [before, after]).
function findVideoUrl(value, base, index = 0) {
  const urls = collectUrls(value, base);
  if (!urls.length) return null;
  const i = index < 0 ? urls.length + index : index;
  return urls[i] || null;
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

async function transformWithGradio({ prefix = 'HF', inputPath, outputPath, prompt = '', mime = 'video/mp4', onProgress = () => {}, isCancelled = () => false, maxWaitMs = 20 * 60 * 1000, label = 'Free AI model' }) {
  const base = baseUrl(prefix);
  if (!base) throw new Error(`${label} needs ${prefix}_SPACE_URL (a Gradio / Hugging Face Space URL) in the environment.`);
  if (!fs.existsSync(inputPath)) throw new Error('The prepared source file is no longer available. Upload it again.');
  if (typeof fs.openAsBlob !== 'function') throw new Error('This feature requires Node.js 20.11 or newer.');

  const apiName = String(setting(prefix, 'API_NAME') || 'predict').replace(/^\/+/, '');
  const order = String(setting(prefix, 'INPUT_ORDER') || 'video,prompt').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (order.includes('prompt') && (typeof prompt !== 'string' || prompt.trim().length < 8 || prompt.trim().length > 1500)) throw new Error('Enter a visual transformation prompt between 8 and 1,500 characters.');
  let extra;
  try { extra = JSON.parse(setting(prefix, 'EXTRA_INPUTS') || '[]'); } catch { throw new Error(`${prefix}_EXTRA_INPUTS must be a JSON array.`); }
  if (!Array.isArray(extra)) throw new Error(`${prefix}_EXTRA_INPUTS must be a JSON array.`);
  const outputIndex = Number.isInteger(Number(setting(prefix, 'OUTPUT_INDEX'))) && setting(prefix, 'OUTPUT_INDEX') !== undefined && setting(prefix, 'OUTPUT_INDEX') !== '' ? Number(setting(prefix, 'OUTPUT_INDEX')) : 0;

  onProgress(8, `Uploading to the ${label}`);
  const remotePath = await uploadFile(base, inputPath, mime);
  const fileData = { path: remotePath, meta: { _type: 'gradio.FileData' } };
  const data = order.map(slot => FILE_SLOTS.has(slot) ? fileData : slot === 'prompt' ? String(prompt).trim() : null).concat(extra);

  onProgress(15, `Queued on the ${label} (can take a while)`);
  let call = null;
  for (const route of ['/gradio_api/call', '/call']) {
    const response = await request(`${base}${route}/${encodeURIComponent(apiName)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`${label} rejected the request (${response.status}). Check ${prefix}_API_NAME, ${prefix}_INPUT_ORDER and ${prefix}_EXTRA_INPUTS for your Space.`);
    call = { route, ...(await response.json()) };
    break;
  }
  if (!call?.event_id) throw new Error('Free AI server did not return an event id. Check that the SPACE_URL is a running Gradio app.');
  if (isCancelled()) throw new Error('The request was cancelled.');

  const started = Date.now();
  const ticker = setInterval(() => onProgress(Math.min(82, 18 + Math.floor((Date.now() - started) / maxWaitMs * 64)), `${label} is working`), 5000);
  let result;
  try {
    const stream = await request(`${base}${call.route}/${encodeURIComponent(apiName)}/${call.event_id}`, {}, maxWaitMs);
    if (!stream.ok) throw new Error(`Free AI server status check failed (${stream.status}).`);
    const events = parseSse(await stream.text());
    const error = events.find(e => e.name === 'error');
    const complete = [...events].reverse().find(e => e.name === 'complete');
    if (!complete) throw new Error(`${label} failed or timed out${error && error.data && error.data !== 'null' ? ': ' + error.data.slice(0, 300) : ' (the free Space may be busy, asleep or out of GPU quota). Try again later.'}`);
    result = JSON.parse(complete.data);
  } finally { clearInterval(ticker); }

  const outputUrl = findVideoUrl(result, base, outputIndex);
  if (!outputUrl) throw new Error('The free AI server finished but returned no downloadable file.');
  if (isCancelled()) throw new Error('The request was cancelled.');

  onProgress(88, 'Downloading the result');
  const response = await request(outputUrl, {}, 120000);
  if (!response.ok || !response.body) throw new Error(`Could not download the result (${response.status}).`);
  let total = 0;
  const limiter = new Transform({ transform(chunk, _e, cb) { total += chunk.length; if (total > MAX_OUTPUT_BYTES) return cb(new Error('Result exceeds the 250 MB safety limit.')); cb(null, chunk); } });
  await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }));
  onProgress(96, 'Validating the result');
  return { provider: 'Free open-source model (Gradio/Hugging Face)', outputBytes: total, model: apiName };
}

// Backwards-compatible wrapper used for AI Visual Change.
const transformVideoWithFreeProvider = opts => transformWithGradio({ prefix: 'HF', mime: 'video/mp4', label: 'free AI server', ...opts });

module.exports = { transformVideoWithFreeProvider, transformWithGradio, isConfigured, parseSse, findVideoUrl, collectUrls };
