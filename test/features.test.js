'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sniff } = require('../share');
const { guideAnswer, userExplain } = require('../support');
const { buildMask } = require('../bgremove');

test('share only accepts real photo/video/audio signatures', () => {
  assert.equal(sniff(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')).mime, 'image/png');
  assert.equal(sniff(Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(12)])).mime, 'image/jpeg');
  assert.equal(sniff(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypmp42'), Buffer.alloc(8)])).mime, 'video/mp4');
  assert.equal(sniff(Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.equal(sniff(Buffer.from('MZ' + 'x'.repeat(40))), null);
  assert.equal(sniff(Buffer.alloc(4)), null);
});

test('support guide answers common problems and escalates unknown ones', () => {
  assert.match(guideAnswer('upload fail ho raha hai', {}).reply, /restart|busy|dobara/i);
  assert.match(guideAnswer('password bhool gaya', {}).reply, /Forgot password/i);
  assert.match(guideAnswer('background remove kaise', {}).reply, /transparent/i);
  const unknown = guideAnswer('zzzz qqqq', {});
  assert.equal(unknown.solved, false);
  assert.match(unknown.reply, /Team ko bhejo/);
  assert.match(userExplain('Failed to fetch'), /busy|restart/i);
  assert.match(guideAnswer('help', { lastError: 'Upload failed (502).' }).reply, /busy|restart/i);
});

test('background mask separates a centred subject from a plain background', () => {
  const w = 60, h = 40, data = Buffer.alloc(w * h * 3, 235);
  for (let y = 10; y < 30; y++) for (let x = 20; x < 40; x++) { const i = (y * w + x) * 3; data[i] = 40; data[i + 1] = 80; data[i + 2] = 160; }
  const { mask, fraction } = buildMask({ w, h, data }, 52);
  assert.ok(Math.abs(fraction - 400 / 2400) < 0.01);
  assert.equal(mask[15 * w + 30], 1);
  assert.equal(mask[2 * w + 2], 0);
});
