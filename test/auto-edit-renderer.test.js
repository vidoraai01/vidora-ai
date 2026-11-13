'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createAutoEditRenderer } = require('../auto-edit-renderer');

function ffmpegRun(command, args, timeoutMs, _onProgress, _duration, onSpawn) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore','ignore','pipe'] });
    onSpawn?.(child);
    let stderr='';
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Test FFmpeg timed out.'));},timeoutMs);
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-5000);});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(new Error(stderr||`FFmpeg exited ${code}`));});
  });
}

test('AI Video Edit applies confidence-gated AI cuts, pause cuts and visual enhancement to a real MP4', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidora-autoedit-test-'));
  const input=path.join(dir,'source.mp4'), output=path.join(dir,'edited.mp4');
  try {
    const generated=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=12','-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=12','-shortest','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-b:a','96k',input]);
    assert.equal(generated.status,0,generated.stderr?.toString());
    const probed=spawnSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',input],{encoding:'utf8'});
    assert.equal(probed.status,0,probed.stderr);
    const info=JSON.parse(probed.stdout);
    const render=createAutoEditRenderer({FFMPEG:'ffmpeg',detectLongSilences:async()=>[{start:2,end:5}],run:ffmpegRun});
    const result=await render(input,output,info,{recommendedCuts:JSON.stringify([{startSeconds:8,endSeconds:9,confidence:0.92}]),enhanceSharpness:0.25,enhanceDenoise:0.3,enhanceBrightness:0,enhanceContrast:1.04,enhanceSaturation:1.03,visualStyle:'cinematic',resolution:'original',aiAudioNoEnhancementNeeded:'true'});
    assert.equal(result.smartCutApplied,true);
    assert.equal(result.aiCutCount,1);
    assert.ok(result.removedSeconds>3 && result.removedSeconds<4);
    assert.ok(fs.existsSync(output));
    const outProbe=spawnSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',output],{encoding:'utf8'});
    assert.equal(outProbe.status,0,outProbe.stderr);
    const outInfo=JSON.parse(outProbe.stdout);
    assert.ok(outInfo.streams.some(s=>s.codec_type==='video'));
    assert.ok(outInfo.streams.some(s=>s.codec_type==='audio'));
    const outputDuration=Number(outInfo.format.duration);
    assert.ok(outputDuration<10 && outputDuration>8,`Unexpected output duration: ${outputDuration}`);
    assert.match(result.reason,/AI cut/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
