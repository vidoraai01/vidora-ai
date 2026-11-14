'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fx = require('../free-effects');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('look helpers', () => {
  assert.equal(fx.isLocalLook('look-cartoon'), true);
  assert.equal(fx.isLocalLook('anime'), false);
  assert.equal(fx.isLocalLook('constructor'), false);
  assert.deepEqual(fx.lookFilters('nope'), []);
  assert.equal(fx.fallbackLookFor('anime'), 'look-anime');
  assert.equal(fx.fallbackLookFor('custom'), null);
});

test('enhance filters respect low resource mode', () => {
  const full = fx.enhanceVideoFilters({ sharpness: 0.9, denoise: 1.2 }).join(',');
  const low = fx.enhanceVideoFilters({ sharpness: 0.9, denoise: 1.2, lowResource: true }).join(',');
  assert.match(full, /cas=/); assert.match(full, /normalize=/);
  assert.match(low, /cas=/); assert.doesNotMatch(low, /normalize=|deband/);
  assert.deepEqual(fx.enhanceVideoFilters({}), []);
});

test('every look and the enhance/audio chains run in ffmpeg', { skip: !hasFfmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-'));
  const src = path.join(dir, 'src.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12:duration=1', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  const chains = { enhance: [fx.enhanceVideoFilters({ sharpness: 1, denoise: 1, contrast: 1.05, saturation: 1.1 }), fx.voiceCleanFilters(10)] };
  for (const k of Object.keys(fx.LOOKS)) chains[k] = [fx.lookFilters(k), []];
  for (const [name, [vf, af]] of Object.entries(chains)) {
    const out = path.join(dir, `${name}.mp4`);
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vf', vf.join(','), ...(af.length ? ['-af', af.join(',')] : []), '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', out];
    execFileSync('ffmpeg', args);
    assert.ok(fs.statSync(out).size > 0, name);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
