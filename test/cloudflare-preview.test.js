'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const read = file => fs.readFile(path.join(process.cwd(), file), 'utf8');

test('Cloudflare Worker entry point exists and is configured', async () => {
  const config = JSON.parse(await read('wrangler.jsonc'));
  assert.equal(config.main, 'cloudflare/worker.js');
  await fs.access(path.join(process.cwd(), config.main));
});

test('every local stylesheet and script referenced by the preview HTML exists', async () => {
  const html = await read('public/index.html');
  const localCss = [...html.matchAll(/<link[^>]+href=["']([^"']+\.css)["']/g)]
    .map(match => match[1]).filter(url => url.startsWith('/'));
  const localJs = [...html.matchAll(/<script[^>]+src=["']([^"']+\.js)["']/g)]
    .map(match => match[1]).filter(url => url.startsWith('/'));

  assert.ok(localCss.length > 0, 'expected at least one local stylesheet');
  assert.ok(localJs.length > 0, 'expected at least one local script');

  for (const url of [...localCss, ...localJs]) {
    await fs.access(path.join(process.cwd(), 'public', url.replace(/^\//, '')));
  }
});

test('preview Worker keeps backend APIs explicitly unavailable and serves static assets', async () => {
  const worker = await read('cloudflare/worker.js');
  assert.match(worker, /url\.pathname\.startsWith\(["']\/api\/["']\)/);
  assert.match(worker, /\},\s*503\s*\)/);
  assert.match(worker, /env\.ASSETS\.fetch\(request\)/);
});
