'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const API = 'https://api.dev.runwayml.com/v1';
const API_VERSION = '2024-11-06';
const MAX_INPUT_BYTES = 200 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 250 * 1024 * 1024;
const MAX_DURATION_SECONDS = 30;

async function runwayRequest(route, apiKey, options = {}) {
  const response = await fetch(`${API}${route}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'X-Runway-Version': API_VERSION,
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {})
    },
    signal: options.signal || AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 1200);
    const error = new Error(`Runway API request failed (${response.status}). ${body || 'No provider details returned.'}`);
    error.providerStatus = response.status;
    error.statusCode = response.status >= 500 ? 502 : 400;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

function findOutputUrl(value) {
  if (typeof value === 'string' && /^https:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findOutputUrl(item); if (found) return found; }
  } else if (value && typeof value === 'object') {
    for (const key of ['url', 'uri', 'videoUrl', 'video_uri', 'output']) {
      if (value[key]) { const found = findOutputUrl(value[key]); if (found) return found; }
    }
  }
  return null;
}

async function cancelRunwayTask(apiKey, taskId) {
  if (!apiKey || !taskId) return;
  try { await runwayRequest(`/tasks/${encodeURIComponent(taskId)}`, apiKey, { method: 'DELETE' }); }
  catch (error) { if (error.providerStatus !== 404) throw error; }
}

async function transformVideoWithRunway({ inputPath, outputPath, prompt, apiKey, onProgress = () => {}, isCancelled = () => false, onTaskId = () => {}, pollIntervalMs = 5000, maxWaitMs = 30 * 60 * 1000 }) {
  if (!apiKey) throw new Error('AI Visual Change needs RUNWAYML_API_SECRET configured in the hosting environment.');
  if (!fs.existsSync(inputPath)) throw new Error('The validated source video is no longer available. Upload it again.');
  const stat = fs.statSync(inputPath);
  if (stat.size > MAX_INPUT_BYTES) throw new Error('AI Visual Change accepts videos up to 200 MB per provider request.');
  if (typeof prompt !== 'string' || prompt.trim().length < 8 || prompt.trim().length > 1500) throw new Error('Enter a visual transformation prompt between 8 and 1,500 characters.');
  if (typeof fs.openAsBlob !== 'function') throw new Error('AI Visual Change requires Node.js 20.11 or newer for safe streaming file uploads.');

  const ext = path.extname(inputPath).toLowerCase();
  const mime = ({ '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' })[ext] || 'video/mp4';
  onProgress(8, 'Uploading source to AI video provider');
  const upload = await runwayRequest('/uploads', apiKey, { method: 'POST', body: JSON.stringify({ filename: path.basename(inputPath), type: 'ephemeral' }) });
  if (!upload?.uploadUrl || !upload?.runwayUri || !upload?.fields || typeof upload.fields !== 'object') throw new Error('The AI video provider returned an incomplete upload response.');

  // Runway requires a fresh ephemeral upload after a failed upload; do not blindly retry a signed URL.
  const form = new FormData();
  for (const [key, value] of Object.entries(upload.fields)) form.append(key, String(value));
  form.append('file', await fs.openAsBlob(inputPath, { type: mime }), path.basename(inputPath));
  const uploaded = await fetch(upload.uploadUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!uploaded.ok) throw new Error(`AI provider source upload failed (${uploaded.status}). Start a new request; the temporary upload URL cannot be reused.`);

  onProgress(15, 'Submitting visual transformation');
  const task = await runwayRequest('/video_to_video', apiKey, {
    method: 'POST',
    body: JSON.stringify({ model: 'aleph2', videoUri: upload.runwayUri, promptText: prompt.trim() })
  });
  if (!task?.id) throw new Error('The AI video provider did not return a task ID.');
  onTaskId(task.id);

  const started = Date.now();
  let completed = null;
  while (Date.now() - started < maxWaitMs) {
    if (isCancelled()) {
      await cancelRunwayTask(apiKey, task.id).catch(() => {});
      throw new Error('AI Visual Change was cancelled.');
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    const status = await runwayRequest(`/tasks/${encodeURIComponent(task.id)}`, apiKey);
    const phase = String(status?.status || '').toUpperCase();
    if (phase === 'SUCCEEDED' || phase === 'COMPLETED') { completed = status; break; }
    if (['FAILED', 'CANCELLED', 'CANCELED'].includes(phase)) throw new Error(`AI video transformation ${phase.toLowerCase()}: ${String(status?.failure || status?.error || 'The provider did not return a reason.').slice(0, 500)}`);
    const elapsed = Date.now() - started;
    onProgress(Math.min(82, 18 + Math.floor(elapsed / maxWaitMs * 64)), `AI model is transforming the video (${phase || 'processing'})`);
  }
  if (!completed) {
    await cancelRunwayTask(apiKey, task.id).catch(() => {});
    throw new Error('AI Visual Change exceeded its 30-minute processing window. The provider task was asked to stop.');
  }
  const outputUrl = findOutputUrl(completed.output || completed.outputs || completed.result);
  if (!outputUrl) throw new Error('The AI provider marked the task complete but returned no downloadable video.');

  onProgress(88, 'Downloading transformed video');
  const response = await fetch(outputUrl, { signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error(`Could not download the transformed video (${response.status}).`);
  let total = 0;
  const limiter = new Transform({ transform(chunk, _encoding, callback) { total += chunk.length; if (total > MAX_OUTPUT_BYTES) return callback(new Error('Transformed output exceeds the 250 MB safety limit.')); callback(null, chunk); } });
  await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }));
  onProgress(96, 'Validating transformed video');
  return { provider: 'Runway Aleph 2', taskId: task.id, inputBytes: stat.size, outputBytes: total, model: 'aleph2' };
}

module.exports = { transformVideoWithRunway, cancelRunwayTask, MAX_RUNWAY_INPUT_BYTES: MAX_INPUT_BYTES, MAX_RUNWAY_DURATION_SECONDS: MAX_DURATION_SECONDS };
