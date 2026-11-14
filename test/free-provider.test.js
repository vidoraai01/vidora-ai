'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { transformVideoWithFreeProvider, parseSse, findVideoUrl } = require('../free-video-provider');

test('parseSse reads Gradio complete and error events', () => {
  const ev = parseSse('event: generating\ndata: null\n\nevent: complete\ndata: [{"url":"https://x/y.mp4"}]\n');
  assert.equal(ev.at(-1).name, 'complete');
  assert.equal(findVideoUrl(JSON.parse(ev.at(-1).data), 'https://space.mock'), 'https://x/y.mp4');
  assert.equal(findVideoUrl([{ video: { url: '/gradio_api/file=a.mp4' } }], 'https://space.mock'), 'https://space.mock/gradio_api/file=a.mp4');
});

test('free provider uploads, calls the Gradio API, reads the stream and downloads the result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidora-free-test-'));
  const inputPath = path.join(dir, 'in.mp4'), outputPath = path.join(dir, 'out.mp4');
  fs.writeFileSync(inputPath, Buffer.from('fake-video-bytes'));
  process.env.HF_SPACE_URL = 'https://space.mock';
  process.env.HF_API_NAME = 'predict';
  const original = global.fetch;
  let sentData = null;
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u === 'https://space.mock/gradio_api/upload') return new Response(JSON.stringify(['/tmp/gradio/abc/in.mp4']), { status: 200 });
    if (u === 'https://space.mock/gradio_api/call/predict') { sentData = JSON.parse(options.body).data; return new Response(JSON.stringify({ event_id: 'evt1' }), { status: 200 }); }
    if (u === 'https://space.mock/gradio_api/call/predict/evt1') return new Response('event: complete\ndata: [{"video":{"url":"https://out.mock/r.mp4"}}]\n\n', { status: 200 });
    if (u === 'https://out.mock/r.mp4') return new Response(Buffer.from('result-bytes'), { status: 200 });
    throw new Error('Unexpected URL ' + u);
  };
  try {
    const result = await transformVideoWithFreeProvider({ inputPath, outputPath, prompt: 'Make this an anime style video.' });
    assert.equal(sentData[0].path, '/tmp/gradio/abc/in.mp4');
    assert.equal(sentData[1], 'Make this an anime style video.');
    assert.equal(fs.readFileSync(outputPath, 'utf8'), 'result-bytes');
    assert.match(result.provider, /Free/);
  } finally { global.fetch = original; delete process.env.HF_SPACE_URL; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('free provider reports a clear error when the Space fails or HF_SPACE_URL is missing', async () => {
  delete process.env.HF_SPACE_URL;
  await assert.rejects(() => transformVideoWithFreeProvider({ inputPath: __filename, outputPath: '/tmp/x.mp4', prompt: 'long enough prompt' }), /HF_SPACE_URL/);
});
