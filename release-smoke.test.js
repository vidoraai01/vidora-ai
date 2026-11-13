'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = __dirname;
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/assets/app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const auth = fs.readFileSync(path.join(root, 'auth-support.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'auto-edit-renderer.js'), 'utf8');

test('five-page workflow is present', () => {
  for (let i=1;i<=5;i++) assert.match(html, new RegExp(`id="page${i}"`));
  assert.equal((html.match(/id="page[1-5]"/g)||[]).length, 5);
});

test('frontend DOM IDs are unique and JavaScript references resolve', () => {
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(new Set(ids).size,ids.length,'Duplicate HTML id attributes found.');
  const dynamic=new Set(['formatChoice','qualityChoice','resolutionChoice','visualStyleChoice','visualPromptChoice']);
  const refs=[...js.matchAll(/\$\('([^']+)'\)/g)].map(m=>m[1]);
  for(const id of new Set(refs))assert.ok(ids.includes(id)||dynamic.has(id),`Missing DOM element referenced by app.js: ${id}`);
});

test('processing animation is scoped to page four and results stop at page five', () => {
  const page4=html.match(/<section class="page processing-page" id="page4">([\s\S]*?)<\/section>/);
  assert.ok(page4 && page4[1].includes('brain-core'));
  assert.doesNotMatch(html,/id="page6"/);
  const page5=html.match(/<section class="page" id="page5">([\s\S]*?)<\/section>/);
  assert.ok(page5);
  assert.match(page5[1],/resultBack/);
  assert.doesNotMatch(page5[1],/Next page|Continue to next/i);
  assert.match(js,/backOnly/);
  assert.match(js,/autoEdit:true/);
  assert.match(js,/AI-guided visual enhancement/);
});

test('all twelve approved tool names are exposed', () => {
  const names = ['Video Enhance AI','AI Video Analysis','AI Video Edit','AI Visual Change','Video Fingerprint Check','Video Full Details','AI Video Upscale','Audio Extractor','Video Audio Enhance','Photo Enhance AI','Audio Enhance AI','Audio Fingerprint Check'];
  for (const name of names) assert.ok(js.includes(name), `Missing tool: ${name}`);
});

test('workflow has guest gate, Help, public comments and second fingerprint upload', () => {
  assert.match(js, /Continue as guest|guest/i);
  assert.match(html, /helpTop/);
  assert.match(html, /commentsPage2/);
  assert.match(html, /commentsPage3/);
  assert.match(html, /secondMediaInput/);
  assert.match(html, /adminPanel/);
  assert.match(html, /myReports/);
  assert.match(html, /brain-core/);
  assert.match(server, /requireSession/);
  assert.match(server, /app\.post\('\/api\/uploads'/);
  assert.match(js, /'\/api\/uploads'/);
});

test('media APIs are protected by authentication', () => {
  for (const route of ["'/api/jobs'","'/api/audio-fingerprint'","'/api/video-fingerprint'","'/api/photo-enhance'","'/api/media-details'","'/api/ai-edit-plan'"]) {
    const line = server.split('\n').find(x => x.includes(`app.post(${route}`));
    assert.ok(line && line.includes('requireSession'), `Missing auth guard: ${route}`);
  }
  assert.match(server, /ownerId/);
  assert.match(server, /validateMagic/);
  assert.match(renderer, /function visualStyleFilters/);
  assert.match(renderer, /cinematic: \[/);
  assert.match(auth, /forgot-password/);
  assert.match(auth, /reset-password/);
  assert.match(auth, /TRUST_PROXY_HOPS/);
  assert.match(auth, /vidora_sessions/);
  assert.match(auth, /admin\/comments\/:id/);
  assert.match(auth, /\['feedback','suggestion'\]\.includes\(kind\)/);
});

test('AI Video Edit chains analysis into an actual render and Visual Change presets are wired safely', () => {
  assert.match(js, /'video-edit':\{analysis:true,autoEdit:true\}/);
  assert.match(js, /renderForm.append\('autoSmartCut',String\(d.autoEdit\)\)/);
  assert.match(js, /renderForm.append\('visualStyle','natural'\)/);
  assert.match(js, /recommendedCuts',JSON.stringify\(responseData.recommendedCuts\|\|\[\]\)/);
  assert.match(js, /d.details\|\|\(d.analysis\&\&!d.autoEdit\)/);
  assert.match(js, /'visual-change':\{task:'visual-change',format:'mp4',visualStyle:true\}/);
  assert.match(server, /createAutoEditRenderer\(\{ FFMPEG, detectLongSilences, run \}\)/);
  assert.match(server, /transformVideoWithRunway/);
  assert.match(server, /MAX_RUNWAY_DURATION_SECONDS/);
  assert.match(server, /visualFps>30\.01/);
  assert.match(server, /supportedRunwayCodecs/);
  assert.match(server, /1920\*1080/);
  assert.match(server, /task==='visual-change'/);
  assert.match(server, /visualPrompt/);
  assert.match(renderer, /confidence<0\.65/);
  assert.match(renderer, /proposedRemoved>duration\*0\.35/);
  assert.match(renderer, /vf.push\(\.\.\.visualStyleFilters\(body.visualStyle\)\)/);
});

test('JavaScript source parses', () => {
  for (const file of ['server.js','auth-support.js','public/assets/app.js','runway-video-provider.js','auto-edit-renderer.js']) {
    const r=spawnSync(process.execPath,['--check',path.join(root,file)],{encoding:'utf8'});
    assert.equal(r.status,0,`${file}: ${r.stderr}`);
  }
});

test('FFmpeg and FFprobe are available in the current test environment', () => {
  for (const bin of ['ffmpeg','ffprobe']) {
    const r=spawnSync(bin,['-version'],{encoding:'utf8'});
    assert.equal(r.status,0,`${bin} is not available`);
  }
});


test('all Visual Change render presets are accepted by FFmpeg', () => {
  const presets = [
    'eq=contrast=1.12:saturation=1.08:gamma=0.98,vignette=PI/5',
    'hue=s=0,eq=contrast=1.22:brightness=-0.01',
    'colorbalance=rs=0.05:gs=0.01:bs=-0.04,eq=saturation=0.82:contrast=1.04',
    'colorbalance=rs=0.08:gs=0.02:bs=-0.06',
    'colorbalance=rs=-0.04:gs=0.01:bs=0.07'
  ];
  for (const preset of presets) {
    const r = spawnSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=0.25','-vf',preset,'-f','null','-'], {encoding:'utf8'});
    assert.equal(r.status,0,`FFmpeg rejected visual preset ${preset}: ${r.stderr}`);
  }
});

test('secret files are excluded from release packaging', () => {
  const ignore=fs.readFileSync(path.join(root,'.dockerignore'),'utf8');
  assert.match(ignore,/^\.env$/m);
  assert.match(ignore,/^\.env\.\*$/m);
  assert.ok(!fs.existsSync(path.join(root,'.env')));
});
