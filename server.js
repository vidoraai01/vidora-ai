'use strict';
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 500);
const RETENTION_HOURS = Number(process.env.RETENTION_HOURS || 2);
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const FPCALC = process.env.FPCALC_PATH || 'fpcalc';
const ROOT = path.join(os.tmpdir(), 'vidora-ai');
const IN_DIR = path.join(ROOT, 'input');
const OUT_DIR = path.join(ROOT, 'output');
for (const dir of [IN_DIR, OUT_DIR]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const jobs = new Map();
const MIME_EXT = new Set(['.mp4','.mov','.webm','.mkv','.mp3','.wav','.m4a','.aac','.ogg','.flac']);
const OUTPUTS = {
  mp4: { ext: '.mp4', args: ['-c:v','libx264','-preset','medium','-c:a','aac','-b:a','192k','-movflags','+faststart'] },
  mov: { ext: '.mov', args: ['-c:v','libx264','-preset','medium','-c:a','aac','-b:a','192k'] },
  webm: { ext: '.webm', args: ['-c:v','libvpx-vp9','-crf','32','-b:v','0','-c:a','libopus'] },
  mp3: { ext: '.mp3', args: ['-vn','-c:a','libmp3lame','-b:a','192k'] },
  wav: { ext: '.wav', args: ['-vn','-c:a','pcm_s16le'] }
};

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'same-origin' },
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], mediaSrc: ["'self'", 'blob:'], connectSrc: ["'self'"] } }
}));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }));
const upload = multer({
  dest: IN_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!MIME_EXT.has(ext)) return cb(new Error('Unsupported file extension.'));
    cb(null, true);
  }
});

const audioUpload = multer({
  dest: IN_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!['.mp3','.wav','.m4a','.aac','.ogg','.flac'].includes(ext)) return cb(new Error('Fingerprint analysis accepts audio files only (MP3, WAV, M4A, AAC, OGG, FLAC).'));
    cb(null, true);
  }
});
function getFingerprint(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(FPCALC, ['-json', '-raw', '-length', '120', file], { stdio: ['ignore','pipe','pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out = (out + chunk.toString()).slice(-2_000_000); });
    child.stderr.on('data', chunk => { err = (err + chunk.toString()).slice(-4000); });
    child.on('error', e => reject(new Error(e.code === 'ENOENT' ? 'Audio fingerprint engine is not installed on this server.' : e.message)));
    child.on('close', code => {
      if (code !== 0) return reject(new Error(err || 'Could not generate an audio fingerprint.'));
      try {
        const data = JSON.parse(out);
        const values = String(data.fingerprint || '').split(',').filter(Boolean).map(v => Number(v) >>> 0);
        if (!values.length) throw new Error('The audio is too short or could not be fingerprinted.');
        resolve({ duration: Number(data.duration || 0), values });
      } catch (e) { reject(e); }
    });
  });
}
function compareFingerprints(a, b) {
  const bitCount = n => { n >>>= 0; n = n - ((n >>> 1) & 0x55555555); n = (n & 0x33333333) + ((n >>> 2) & 0x33333333); return (((n + (n >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; };
  let best = { score: 0, offset: 0, compared: 0 };
  const maxOffset = Math.min(60, Math.max(a.length, b.length) - 1);
  for (let offset = -maxOffset; offset <= maxOffset; offset++) {
    const startA = Math.max(0, offset), startB = Math.max(0, -offset);
    const count = Math.min(a.length - startA, b.length - startB);
    if (count < 8) continue;
    let bits = 0;
    for (let i = 0; i < count; i++) bits += 32 - bitCount(a[startA + i] ^ b[startB + i]);
    const score = bits / (count * 32) * 100;
    if (score > best.score) best = { score, offset, compared: count };
  }
  return best;
}

function run(command, args, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore','ignore','pipe'] });
    let err = '';
    child.stderr.on('data', chunk => { err = (err + chunk.toString()).slice(-6000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Processing timed out.')); }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(err || `${command} exited with code ${code}`)); });
  });
}
async function probe(file) {
  const raw = await new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, ['-v','error','-show_entries','format=duration,format_name:stream=codec_type,width,height','-of','json',file]);
    let out='', err=''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('error', reject); p.on('close', c => c === 0 ? resolve(out) : reject(new Error(err || 'Unable to inspect media.')));
  });
  return JSON.parse(raw);
}
function safeDelete(file) { if (file) fs.rm(file, { force: true }, () => {}); }
function buildArgs(input, output, body, info) {
  const task = String(body.task || 'convert');
  const format = String(body.format || 'mp4').toLowerCase();
  const quality = String(body.quality || 'balanced').toLowerCase();
  const resolution = String(body.resolution || 'original').toLowerCase();
  const spec = OUTPUTS[format];
  if (!spec) throw new Error('Unsupported output format.');
  const hasVideo = (info.streams || []).some(s => s.codec_type === 'video');
  const hasAudio = (info.streams || []).some(s => s.codec_type === 'audio');
  if (!hasVideo && !hasAudio) throw new Error('The uploaded file has no supported audio or video stream.');
  if (task === 'normalize-audio' && !hasAudio) throw new Error('Audio normalization requires an audio stream.');
  if (!hasVideo && !['mp3','wav'].includes(format)) throw new Error('For audio-only input, choose MP3 or WAV output.');
  if (['resize','extract-audio'].includes(task) && !hasVideo) throw new Error('This task requires a video input.');
  if (task === 'extract-audio' && !['mp3','wav'].includes(format)) throw new Error('Choose MP3 or WAV for audio extraction.');
  if (['mp3','wav'].includes(format) && !hasAudio) throw new Error('The input has no audio stream.');
  const args = ['-hide_banner','-loglevel','error','-y'];
  if (task === 'trim') {
    const start = Number(body.startTime || 0), duration = Number(body.duration || 10);
    if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || duration <= 0 || duration > 3600) throw new Error('Trim start must be non-negative and duration must be between 0 and 3600 seconds.');
    args.push('-ss', String(start), '-t', String(duration));
  }
  args.push('-i', input);
  if (task === 'extract-audio' || ['mp3','wav'].includes(format)) args.push('-vn');
  if (task === 'normalize-audio' && hasAudio) args.push('-af','loudnorm=I=-16:TP=-1.5:LRA=11');
  if (hasVideo && !['mp3','wav'].includes(format)) {
    if (resolution !== 'original' && ['1080p','720p','480p'].includes(resolution)) {
      const h = resolution.slice(0,-1);
      args.push('-vf', `scale=-2:'min(${h},ih)'`);
    }
    const preset = quality === 'high' ? 'slow' : quality === 'small' ? 'veryfast' : 'medium';
    if (['mp4','mov'].includes(format)) args.push('-c:v','libx264','-preset',preset,'-crf',quality === 'high' ? '18' : quality === 'small' ? '28' : '23');
    else args.push('-c:v','libvpx-vp9','-crf',quality === 'high' ? '26' : quality === 'small' ? '38' : '32','-b:v','0');
  }
  if (task === 'normalize-audio' && hasAudio && hasVideo && !['mp3','wav'].includes(format)) {
    // Preserve the selected video codec and normalize only the audio stream.
    args.push('-c:a', format === 'webm' ? 'libopus' : 'aac');
  } else if (task === 'normalize-audio' && hasAudio && ['mp3','wav'].includes(format)) {
    args.push(...spec.args);
  } else if (!hasVideo || ['mp3','wav'].includes(format)) {
    args.push(...spec.args);
  } else {
    args.push('-c:a', format === 'webm' ? 'libopus' : 'aac');
    if (format === 'mp4') args.push('-movflags','+faststart');
  }
  args.push('-progress','pipe:2','-nostats',output);
  return args;
}

app.get('/api/health', (_req,res) => res.json({ ok:true, service:'Vidora AI processing API' }));
app.post('/api/audio-fingerprint', audioUpload.fields([{ name:'referenceAudio', maxCount:1 },{ name:'checkAudio', maxCount:1 }]), async (req,res) => {
  const files = req.files || {};
  const reference = files.referenceAudio?.[0], check = files.checkAudio?.[0];
  if (!reference || !check) {
    if (reference) safeDelete(reference.path); if (check) safeDelete(check.path);
    return res.status(400).json({ error:'Upload both the reference audio and the audio you want to check.' });
  }
  try {
    const [refFp, checkFp] = await Promise.all([getFingerprint(reference.path), getFingerprint(check.path)]);
    const comparison = compareFingerprints(refFp.values, checkFp.values);
    const score = Number(comparison.score.toFixed(1));
    const result = score >= 90 ? 'Very high similarity' : score >= 75 ? 'High similarity' : score >= 60 ? 'Moderate similarity' : 'Low similarity';
    res.json({ ok:true, analysis:{ referenceDuration:Number(refFp.duration.toFixed(1)), checkDuration:Number(checkFp.duration.toFixed(1)), referenceFingerprintLength:refFp.values.length, checkFingerprintLength:checkFp.values.length, similarity:score, result, comparedSegments:comparison.compared, alignmentOffset:comparison.offset, engine:'Chromaprint' }, notice:'This compares acoustic fingerprints of the two uploaded files. It does not search a global copyright database and is not a copyright clearance or infringement decision.' });
  } catch (e) { res.status(500).json({ error:e.message || 'Fingerprint analysis failed.' }); }
  finally { safeDelete(reference.path); safeDelete(check.path); }
});
app.post('/api/jobs', upload.single('media'), async (req,res) => {
  if (req.body.rightsConfirmed !== 'true') { if (req.file) safeDelete(req.file.path); return res.status(400).json({ error:'Confirm that you have permission to process this media.' }); }
  if (!req.file) return res.status(400).json({ error:'Choose a media file first.' });
  const id = crypto.randomUUID();
  const ext = OUTPUTS[String(req.body.format || 'mp4').toLowerCase()]?.ext;
  if (!ext) { safeDelete(req.file.path); return res.status(400).json({ error:'Unsupported output format.' }); }
  const output = path.join(OUT_DIR, `${id}${ext}`);
  const job = { id, status:'processing', originalName:req.file.originalname, createdAt:Date.now(), output:null, error:null };
  jobs.set(id, job);
  res.status(202).json({ id, status:job.status });
  (async () => {
    try {
      const info = await probe(req.file.path);
      const args = buildArgs(req.file.path, output, req.body, info);
      await run(FFMPEG, args);
      job.status = 'completed'; job.output = output;
      job.outputName = `${path.basename(req.file.originalname, path.extname(req.file.originalname)).replace(/[^a-z0-9_-]/gi,'_') || 'vidora-export'}${ext}`;
      job.metadata = { duration:Number(info.format?.duration || 0), inputFormat:info.format?.format_name || 'unknown' };
    } catch (e) { job.status='failed'; job.error = e.message; safeDelete(output); }
    finally { safeDelete(req.file.path); }
  })();
});
app.get('/api/jobs/:id', (req,res) => {
  const j = jobs.get(req.params.id); if (!j) return res.status(404).json({ error:'Job not found or expired.' });
  res.json({ id:j.id, status:j.status, error:j.error, outputName:j.outputName, metadata:j.metadata });
});
app.get('/api/jobs/:id/download', (req,res) => {
  const j = jobs.get(req.params.id); if (!j || j.status !== 'completed' || !j.output || !fs.existsSync(j.output)) return res.status(404).json({ error:'Export is not ready or has expired.' });
  res.download(j.output, j.outputName);
});
app.delete('/api/jobs/:id', (req,res) => {
  const j = jobs.get(req.params.id); if (!j) return res.status(404).json({ error:'Job not found.' });
  safeDelete(j.output); jobs.delete(j.id); res.json({ ok:true });
});
setInterval(() => {
  const cutoff = Date.now() - RETENTION_HOURS * 3600_000;
  for (const [id,j] of jobs) if (j.createdAt < cutoff && j.status !== 'processing') { safeDelete(j.output); jobs.delete(id); }
}, 10 * 60_000).unref();
app.use((err,_req,res,_next) => {
  const status = err instanceof multer.MulterError ? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400) : 400;
  res.status(status).json({ error: err.message || 'Upload failed.' });
});
app.listen(PORT, () => console.log(`Vidora AI API running at http://localhost:${PORT}`));
