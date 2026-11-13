'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { transformVideoWithRunway } = require('./runway-video-provider');

test('Runway video-to-video adapter uploads, submits, polls and downloads a transformed MP4', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidora-runway-test-'));
  const inputPath = path.join(dir, 'source.mp4');
  const outputPath = path.join(dir, 'transformed.mp4');
  const generated = spawnSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=1','-f','lavfi','-i','sine=frequency=440:duration=1','-shortest','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',inputPath]);
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const bytes = fs.readFileSync(inputPath);
  const originalFetch = global.fetch;
  let pollCount = 0;
  let submittedPrompt = '';
  let uploadedBlobBytes = 0;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith('/v1/uploads')) return new Response(JSON.stringify({uploadUrl:'https://upload.mock/file',fields:{key:'test-key'},runwayUri:'runway://test-asset'}), {status:200,headers:{'content-type':'application/json'}});
    if (target === 'https://upload.mock/file') {
      assert.equal(options.method, 'POST');
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get('key'), 'test-key');
      const file = options.body.get('file');
      uploadedBlobBytes = file.size;
      assert.equal(file.name, 'source.mp4');
      return new Response(null, {status:204});
    }
    if (target.endsWith('/v1/video_to_video')) {
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'aleph2');
      assert.equal(body.videoUri, 'runway://test-asset');
      submittedPrompt = body.promptText;
      return new Response(JSON.stringify({id:'00000000-0000-4000-8000-000000000001'}), {status:200,headers:{'content-type':'application/json'}});
    }
    if (target.endsWith('/v1/tasks/00000000-0000-4000-8000-000000000001')) {
      pollCount += 1;
      const data = pollCount === 1 ? {status:'RUNNING'} : {status:'SUCCEEDED',output:['https://output.mock/result.mp4']};
      return new Response(JSON.stringify(data), {status:200,headers:{'content-type':'application/json'}});
    }
    if (target === 'https://output.mock/result.mp4') return new Response(bytes, {status:200,headers:{'content-type':'video/mp4'}});
    throw new Error(`Unexpected mocked fetch URL: ${target}`);
  };
  try {
    const progress = [];
    const result = await transformVideoWithRunway({inputPath,outputPath,prompt:'Turn this scene into a consistent anime style.',apiKey:'test-key',pollIntervalMs:1,maxWaitMs:1000,onProgress:(pct,label)=>progress.push({pct,label})});
    assert.equal(result.provider, 'Runway Aleph 2');
    assert.equal(result.taskId, '00000000-0000-4000-8000-000000000001');
    assert.equal(submittedPrompt, 'Turn this scene into a consistent anime style.');
    assert.equal(uploadedBlobBytes, bytes.length);
    assert.equal(fs.readFileSync(outputPath).length, bytes.length);
    assert.ok(pollCount >= 2);
    assert.ok(progress.some(p=>p.pct===96));
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('Runway video-to-video adapter refuses to run without provider credentials', async () => {
  await assert.rejects(() => transformVideoWithRunway({inputPath:'/missing',outputPath:'/tmp/out.mp4',prompt:'A valid prompt',apiKey:''}), /RUNWAYML_API_SECRET/);
});

test('visual-only AI transformation can restore the original audio track without re-encoding video', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidora-audio-restore-test-'));
  const source=path.join(dir,'source.mp4'), visual=path.join(dir,'visual-only.mp4'), output=path.join(dir,'with-original-audio.mp4');
  try {
    const sourceGen=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=1','-f','lavfi','-i','sine=frequency=440:duration=1','-shortest','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',source]);
    assert.equal(sourceGen.status,0,sourceGen.stderr?.toString());
    const visualGen=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-i',source,'-an','-c:v','copy',visual]);
    assert.equal(visualGen.status,0,visualGen.stderr?.toString());
    const mux=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',visual,'-i',source,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-shortest','-movflags','+faststart',output]);
    assert.equal(mux.status,0,mux.stderr?.toString());
    const probe=spawnSync('ffprobe',['-v','error','-show_streams','-of','json',output],{encoding:'utf8'});
    assert.equal(probe.status,0,probe.stderr);
    const streams=JSON.parse(probe.stdout).streams;
    assert.ok(streams.some(s=>s.codec_type==='video'));
    assert.ok(streams.some(s=>s.codec_type==='audio'));
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
