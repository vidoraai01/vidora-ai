'use strict';
// Free, model-free background remover. It decodes the photo with FFmpeg, finds every pixel that is
// connected to the picture border and looks like the border colour (plain walls, studio paper, sky,
// gradients), turns that region into a soft mask and lets FFmpeg write a transparent PNG.
// Works best on plain / smooth backgrounds. A free AI Space (BGRM_SPACE_URL) is used first when set.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEVELS = { low: 34, medium: 52, high: 76 };

function decodePpm(ffmpeg, input, maxSide) {
  const vf = `scale=w='min(iw,${maxSide})':h='min(ih,${maxSide})':force_original_aspect_ratio=decrease:flags=lanczos,format=rgb24`;
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', input, '-frames:v', '1', '-vf', vf, '-f', 'image2pipe', '-c:v', 'ppm', '-'],
      { encoding: 'buffer', maxBuffer: 80 * 1024 * 1024, timeout: 60000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).slice(-300)));
        const m = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(stdout.subarray(0, 40).toString('latin1'));
        if (!m) return reject(new Error('Could not read the photo.'));
        const w = Number(m[1]), h = Number(m[2]), off = m[0].length;
        if (stdout.length < off + w * h * 3) return reject(new Error('Photo decode was incomplete.'));
        resolve({ w, h, data: stdout.subarray(off, off + w * h * 3) });
      });
  });
}

// Average-pool the picture down so the flood fill stays fast and ignores noise.
function shrink(img, target) {
  const k = Math.max(1, Math.ceil(Math.max(img.w, img.h) / target));
  const w = Math.max(1, Math.floor(img.w / k)), h = Math.max(1, Math.floor(img.h / k)), out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) { const i = ((y * k + dy) * img.w + (x * k + dx)) * 3; r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; }
    const n = k * k, o = (y * w + x) * 3; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
  }
  return { w, h, data: out };
}

const median = arr => { const a = Float64Array.from(arr).sort(); return a[a.length >> 1]; };

// Returns { mask: Uint8Array (1 = keep, 0 = background), w, h, fraction (kept share), removedPct }.
function buildMask(img, tolerance) {
  const { w, h, data } = img, N = w * h, gTol = tolerance, sTol = 11;
  const band = Math.max(1, Math.round(Math.min(w, h) * 0.012));
  const R = [], G = [], B = [];
  const take = i => { R.push(data[i * 3]); G.push(data[i * 3 + 1]); B.push(data[i * 3 + 2]); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < band || y < band || x >= w - band || y >= h - band) take(y * w + x);
  const ref = [median(R), median(G), median(B)];
  const dRef = i => Math.hypot(data[i * 3] - ref[0], data[i * 3 + 1] - ref[1], data[i * 3 + 2] - ref[2]);
  const dPix = (i, j) => Math.hypot(data[i * 3] - data[j * 3], data[i * 3 + 1] - data[j * 3 + 1], data[i * 3 + 2] - data[j * 3 + 2]);
  const bg = new Uint8Array(N), queue = new Int32Array(N);
  let qh = 0, qt = 0;
  const seed = i => { if (!bg[i] && dRef(i) <= gTol * 1.3) { bg[i] = 1; queue[qt++] = i; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (qh < qt) {
    const i = queue[qh++], x = i % w, y = (i - x) / w;
    const tryAdd = j => { if (bg[j]) return; const dr = dRef(j); if (dr <= gTol || (dr <= gTol * 2.2 && dPix(i, j) <= sTol)) { bg[j] = 1; queue[qt++] = j; } };
    if (x > 0) tryAdd(i - 1); if (x < w - 1) tryAdd(i + 1); if (y > 0) tryAdd(i - w); if (y < h - 1) tryAdd(i + w);
  }
  // Foreground = not background. Drop tiny specks of foreground (noise) but keep every real subject.
  const label = new Int32Array(N), sizes = [0];
  let nLabels = 0;
  const stack = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (bg[s] || label[s]) continue;
    nLabels++; let sp = 0, size = 0; stack[sp++] = s; label[s] = nLabels;
    while (sp) {
      const i = stack[--sp]; size++; const x = i % w, y = (i - x) / w;
      const push = j => { if (!bg[j] && !label[j]) { label[j] = nLabels; stack[sp++] = j; } };
      if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w);
    }
    sizes.push(size);
  }
  const biggest = Math.max(0, ...sizes), keepMin = Math.max(biggest * 0.06, N * 0.002);
  const mask = new Uint8Array(N); let kept = 0;
  for (let i = 0; i < N; i++) if (!bg[i] && sizes[label[i]] >= keepMin) { mask[i] = 1; kept++; }
  return { mask, w, h, fraction: kept / N, removedPct: Math.round((1 - kept / N) * 100) };
}

const defaultRun = (cmd, args, timeout) => new Promise((resolve, reject) => execFile(cmd, args, { timeout }, (e, _o, se) => (e ? reject(new Error(String(se || e.message).slice(-300))) : resolve())));

async function removeBackground({ ffmpeg, run = defaultRun, input, output, maxSide = 2048, level, tolerance: strength = 'medium' }) {
  const tolerance = LEVELS[level || strength] || LEVELS.medium;
  const full = await decodePpm(ffmpeg, input, maxSide);
  const small = shrink(full, 480);
  const { mask, w, h, removedPct } = buildMask(small, tolerance);
  if (removedPct < 3) throw new Error('Background alag nahi ho paya: photo ka background plain (ek rang ka ya smooth) nahi lag raha. Plain deewar ya kaagaz ke saamne wali photo try karo.');
  if (removedPct > 94) throw new Error('Background aur subject ke rang bahut milte hain, isliye sab hat ja raha tha. "High" ki jagah "Low" try karo ya kisi alag rang ke background wali photo lo.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidora-bg-'));
  try {
    const pgm = path.join(dir, 'mask.pgm');
    fs.writeFileSync(pgm, Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), Buffer.from(mask.map(v => (v ? 255 : 0)))]));
    // Shrink the mask 1 px (no halo), upscale smoothly, soften the edge, then harden it into a clean alpha edge.
    const fc = `[1:v]format=gray,erosion,scale=${full.w}:${full.h}:flags=bicubic,gblur=sigma=${Math.max(1, full.w / 700).toFixed(2)},` +
      `curves=all='0/0 0.3/0 0.7/1 1/1',format=gray[m];` +
      `[0:v]scale=${full.w}:${full.h}:flags=lanczos,format=rgba[img];[img][m]alphamerge[out]`;
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-i', pgm, '-filter_complex', fc, '-map', '[out]', '-frames:v', '1', '-compression_level', '6', output], 120000);
    return { removedPct, width: full.w, height: full.h };
  } finally { fs.rm(dir, { recursive: true, force: true }, () => {}); }
}

module.exports = { removeBackground, buildMask, LEVELS };
