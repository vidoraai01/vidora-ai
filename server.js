'use strict';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { GoogleGenAI } = require('@google/genai');
const { transformVideoWithRunway, cancelRunwayTask, MAX_RUNWAY_INPUT_BYTES, MAX_RUNWAY_DURATION_SECONDS } = require('./runway-video-provider');
const { visualStyleFilters, createAutoEditRenderer } = require('./auto-edit-renderer');
const { enhanceVideoFilters, voiceCleanFilters, isLocalLook, lookFilters, fallbackLookFor } = require('./free-effects');
const { transformVideoWithFreeProvider, transformWithGradio, isConfigured: gradioConfigured } = require('./free-video-provider');
// Visual Change provider: free open-source Gradio/Hugging Face Space first, Runway (paid) only if configured.
function visualProviderName(){const p=String(process.env.VISUAL_PROVIDER||'').toLowerCase();if(p==='runway')return process.env.RUNWAYML_API_SECRET?'runway':null;if(p==='free'||p==='huggingface')return process.env.HF_SPACE_URL?'free':null;return process.env.HF_SPACE_URL?'free':(process.env.RUNWAYML_API_SECRET?'runway':null);}
const FREE_MAX_SECONDS=Math.max(1,Math.min(30,Number(process.env.HF_MAX_SECONDS)||5));

const geminiAI = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: 'v1beta', timeout: 180000, retryOptions: { attempts: 1 } } }) : null;
const app = express();
const { setupAuthSupport } = require('./auth-support');
const PORT = Number(process.env.PORT || 3000);
const configuredUploadLimit = Number(process.env.MAX_UPLOAD_MB || 250);
const MAX_UPLOAD_MB = Number.isFinite(configuredUploadLimit) ? Math.min(250, Math.max(1, configuredUploadLimit)) : 250;
const MAX_AUDIO_MB = 50;
const MAX_PHOTO_MB = 25;
const MAX_VIDEO_SECONDS = Math.max(5, Math.min(300, Number(process.env.MAX_VIDEO_SECONDS) || 300));
const MAX_AUDIO_SECONDS = 1800;
const RETENTION_HOURS = Number(process.env.RETENTION_HOURS || 2);
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const FPCALC = process.env.FPCALC_PATH || (fs.existsSync(path.join(__dirname, 'tools', process.platform === 'win32' ? 'fpcalc.exe' : 'fpcalc')) ? path.join(__dirname, 'tools', process.platform === 'win32' ? 'fpcalc.exe' : 'fpcalc') : 'fpcalc');
const ROOT = path.join(os.tmpdir(), 'vidora-ai');
const IN_DIR = path.join(ROOT, 'input');
const OUT_DIR = path.join(ROOT, 'output');
for (const dir of [IN_DIR, OUT_DIR]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const jobs = new Map();
const uploads = new Map();
const userKey = req => req.session?.account?.id ? 'u:' + req.session.account.id : req.ip;
const mediaJobLimit = rateLimit({ keyGenerator: userKey, windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false, message: { error: 'Media processing limit reached. Please wait before starting another job.' } });
const analysisLimit = rateLimit({ keyGenerator: userKey, windowMs: 15 * 60 * 1000, limit: 4, standardHeaders: true, legacyHeaders: false, message: { error: 'Analysis limit reached. Please wait before retrying.' } });
const requireSession = (req,res,next) => req.session?.account ? next() : res.status(401).json({ error: 'Sign in is required before using Vidora tools.' });
const currentUserId = req => String(req.session.account.id);
const MIME_EXT = new Set(['.mp4','.mov','.webm','.mkv','.mp3','.wav','.m4a','.aac','.ogg','.flac','.jpg','.jpeg','.png','.webp','.bmp','.tif','.tiff']);
const DECLARED_MIME = {
  '.mp4':['video/mp4','application/mp4'],'.mov':['video/quicktime','video/mp4'],'.webm':['video/webm'],'.mkv':['video/x-matroska','video/matroska'],
  '.mp3':['audio/mpeg','audio/mp3'],'.wav':['audio/wav','audio/x-wav','audio/wave','audio/vnd.wave'],'.m4a':['audio/mp4','audio/x-m4a'],'.aac':['audio/aac','audio/aacp','audio/x-aac'],'.ogg':['audio/ogg','application/ogg'],'.flac':['audio/flac','audio/x-flac'],
  '.jpg':['image/jpeg'],'.jpeg':['image/jpeg'],'.png':['image/png'],'.webp':['image/webp'],'.bmp':['image/bmp','image/x-ms-bmp'],'.tif':['image/tiff'],'.tiff':['image/tiff']
};
const PHOTO_EXT = new Set(['.jpg','.jpeg','.png','.webp','.bmp','.tif','.tiff']);
const VIDEO_EXT = new Set(['.mp4','.mov','.webm','.mkv']);
const OUTPUTS = {
  mp4: { ext: '.mp4', args: ['-c:v','libx264','-preset','medium','-c:a','aac','-b:a','192k','-movflags','+faststart'] },
  mov: { ext: '.mov', args: ['-c:v','libx264','-preset','medium','-c:a','aac','-b:a','192k'] },
  webm: { ext: '.webm', args: ['-c:v','libvpx-vp9','-crf','32','-b:v','0','-c:a','libopus'] },
  mp3: { ext: '.mp3', args: ['-vn','-c:a','libmp3lame','-b:a','192k'] },
  wav: { ext: '.wav', args: ['-vn','-c:a','pcm_s16le'] }
};

app.disable('x-powered-by');
app.use(helmet({
  hsts: process.env.NODE_ENV === 'production' ? undefined : false,
  crossOriginResourcePolicy: { policy: 'same-origin' },
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"],
    styleSrc: ["'self'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'],
    imgSrc: ["'self'", 'data:', 'blob:'], mediaSrc: ["'self'", 'blob:'],
    connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
    baseUri: ["'self'"], formAction: ["'self'"],
    upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
  } }
}));
const authReady = (() => { try { return setupAuthSupport(app); } catch (error) { console.error('[Vidora] Authentication configuration error:', error.message); process.exit(1); } })();
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { dotfiles: 'deny', index: false, fallthrough: false, maxAge: '5m' }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use('/api/', rateLimit({
  keyGenerator: userKey,
  windowMs: 60_000,
  // Job status polling runs every 2 seconds during long exports; 20/min
  // incorrectly blocked valid renders after about 40 seconds.
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Vidora request limit reached. Please wait briefly and retry.' })
}));
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
  limits: { fileSize: MAX_AUDIO_MB * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!['.mp3','.wav','.m4a','.aac','.ogg','.flac'].includes(ext)) return cb(new Error('Fingerprint analysis accepts audio files only (MP3, WAV, M4A, AAC, OGG, FLAC).'));
    cb(null, true);
  }
});
const photoUpload = multer({
  dest: IN_DIR,
  limits: { fileSize: MAX_PHOTO_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => PHOTO_EXT.has(path.extname(file.originalname || '').toLowerCase()) ? cb(null, true) : cb(new Error('Photo Studio accepts JPG, PNG, WEBP, BMP and TIFF images only.'))
});
const videoPairUpload = multer({
  dest: IN_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => VIDEO_EXT.has(path.extname(file.originalname || '').toLowerCase()) ? cb(null, true) : cb(new Error('Video fingerprint comparison accepts MP4, MOV, WEBM and MKV videos only.'))
});
app.post('/api/uploads', requireSession, mediaJobLimit, upload.single('media'), async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Choose one media file first.'});
  try{
    const ext=path.extname(req.file.originalname||'').toLowerCase();let kind,info;
    if(VIDEO_EXT.has(ext)){kind='video';info=await validateMedia(req.file,'video',MAX_VIDEO_SECONDS);}
    else if(PHOTO_EXT.has(ext)){kind='photo';if(req.file.size>MAX_PHOTO_MB*1024*1024)throw new Error('Photo must be no larger than 25 MB.');info=await validateMedia(req.file,'photo',0);}
    else {kind='audio';if(req.file.size>MAX_AUDIO_MB*1024*1024)throw new Error('Audio must be no larger than 50 MB.');info=await validateMedia(req.file,'audio',MAX_AUDIO_SECONDS);}
    const id=crypto.randomUUID();uploads.set(id,{id,ownerId:currentUserId(req),path:req.file.path,originalName:req.file.originalname,size:req.file.size,kind,metadata:info,createdAt:Date.now()});
    res.status(201).json({ok:true,uploadId:id,kind,originalName:req.file.originalname,size:req.file.size,metadata:info,expiresInHours:RETENTION_HOURS});
  }catch(e){safeDelete(req.file.path);res.status(400).json({error:e.message||'Media validation failed.'});}
});
app.delete('/api/uploads/:id',requireSession,(req,res)=>{const item=ownedUpload(req,req.params.id);if(!item)return res.status(404).json({error:'Upload not found or expired.'});removeUpload(req.params.id);res.json({ok:true});});

function extractVideoHashes(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner','-loglevel','error','-i',file,'-an','-vf','fps=1,scale=9:8:flags=area,format=gray','-frames:v','300','-f','rawvideo','pipe:1'], { stdio:['ignore','pipe','pipe'], windowsHide:true });
    const chunks=[]; let bytes=0, err='', settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('Video fingerprint extraction timed out.'));},90000);
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>300*72){child.kill('SIGKILL');return finish(new Error('Video fingerprint exceeded its frame safety limit.'));}chunks.push(chunk);});
    child.stderr.on('data',chunk=>{err=(err+chunk.toString()).slice(-3000);});
    child.on('error',e=>finish(new Error(e.code==='ENOENT'?'FFmpeg is not installed on this server.':e.message)));
    child.on('close',code=>{
      if(code!==0)return finish(new Error(err||'Could not extract video fingerprint frames.'));
      const raw=Buffer.concat(chunks), hashes=[];
      for(let off=0;off+72<=raw.length;off+=72){let h=0n,bit=0n;for(let y=0;y<8;y++)for(let x=0;x<8;x++){if(raw[off+y*9+x]>raw[off+y*9+x+1])h|=1n<<bit;bit++;}hashes.push(h);}
      if(hashes.length<3)return finish(new Error('Video is too short or could not provide enough frames for comparison.'));
      finish(null,hashes);
    });
  });
}
function compareVideoHashes(a,b){
  const pop=n=>{let c=0;while(n){n&=n-1n;c++;}return c;};
  let best={score:0,offset:0,compared:0,matches:[],differentFrames:0};
  const max=Math.min(60,Math.max(a.length,b.length)-1);
  for(let offset=-max;offset<=max;offset++){
    const sa=Math.max(0,offset),sb=Math.max(0,-offset),count=Math.min(a.length-sa,b.length-sb);if(count<3)continue;
    let bits=0;const matches=[];let differentFrames=0;
    for(let i=0;i<count;i++){const score=(64-pop(a[sa+i]^b[sb+i]))/64*100;bits+=score;if(score>=82)matches.push(i);else differentFrames++;}
    const score=bits/count;if(score>best.score)best={score,offset,compared:count,matches,differentFrames};
  }
  const startA=Math.max(0,best.offset),startB=Math.max(0,-best.offset),segments=[];
  if(best.matches.length){let first=best.matches[0],last=first;for(let i=1;i<=best.matches.length;i++){const n=best.matches[i];if(n!==last+1){if(last-first+1>=2)segments.push({referenceStartSeconds:startA+first,checkStartSeconds:startB+first,durationSeconds:last-first+1});first=n;}last=n;}}
  return {...best,score:best.score,matchedFrames:best.matches.length,segments};
}

function getFingerprint(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(FPCALC, ['-json', '-raw', '-length', String(MAX_AUDIO_SECONDS), file], { stdio: ['ignore','pipe','pipe'], windowsHide:true });
    let out = '', err = '', settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('Audio fingerprint generation timed out.'));},180000);
    child.stdout.on('data', chunk => { out = (out + chunk.toString()).slice(-2_000_000); });
    child.stderr.on('data', chunk => { err = (err + chunk.toString()).slice(-4000); });
    child.on('error', e => finish(new Error(e.code === 'ENOENT' ? 'Audio fingerprint engine is not installed on this server.' : e.message)));
    child.on('close', code => {
      if (code !== 0) return finish(new Error(err || 'Could not generate an audio fingerprint.'));
      try {
        const data = JSON.parse(out);
        const values = String(data.fingerprint || '').split(',').filter(Boolean).map(v => Number(v) >>> 0);
        if (!values.length) throw new Error('The audio is too short or could not be fingerprinted.');
        finish(null,{ duration: Number(data.duration || 0), values });
      } catch (e) { finish(e); }
    });
  });
}
function compareFingerprints(a, b, durationA = a.length, durationB = b.length) {
  const bitCount = n => { n >>>= 0; n = n - ((n >>> 1) & 0x55555555); n = (n & 0x33333333) + ((n >>> 2) & 0x33333333); return (((n + (n >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; };
  let best = { score: 0, offset: 0, compared: 0, matches: [], differentSegments: 0 };
  const stepA=durationA/Math.max(1,a.length),stepB=durationB/Math.max(1,b.length);
  const maxOffset = Math.min(Math.max(a.length, b.length) - 1, Math.round(300 / Math.max(0.01,Math.min(stepA,stepB))));
  for (let offset = -maxOffset; offset <= maxOffset; offset++) {
    const startA = Math.max(0, offset), startB = Math.max(0, -offset);
    const count = Math.min(a.length - startA, b.length - startB);
    if (count < 3) continue;
    let bits = 0, matches = [], differentSegments = 0;
    for (let i = 0; i < count; i++) { const score=(32-bitCount(a[startA+i]^b[startB+i]))/32*100; bits += score; if(score>=75)matches.push(i);else differentSegments++; }
    const score = bits / count;
    if (score > best.score) best = { score, offset, compared: count, matches, differentSegments };
  }
  const startA=Math.max(0,best.offset),startB=Math.max(0,-best.offset),segments=[];
  if(best.matches.length){let first=best.matches[0],last=first;for(let i=1;i<=best.matches.length;i++){const n=best.matches[i];if(n!==last+1){if(last-first+1>=3)segments.push({referenceStartApproxSeconds:Number(((startA+first)*stepA).toFixed(1)),checkStartApproxSeconds:Number(((startB+first)*stepB).toFixed(1)),durationApproxSeconds:Number(((last-first+1)*Math.min(stepA,stepB)).toFixed(1))});first=n;}last=n;}}
  return {...best,segments,alignmentOffsetSeconds:Number((best.offset*(best.offset>=0?stepA:stepB)).toFixed(2)),fingerprintStepSecondsA:Number(stepA.toFixed(4)),fingerprintStepSecondsB:Number(stepB.toFixed(4))};
}

function run(command, args, timeoutMs = 30 * 60 * 1000, onProgress = null, totalDuration = 0, onSpawn = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    if(onSpawn)onSpawn(child);
    let err = '', settled = false;
    const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
    let progressBuffer = '';
    child.stderr.on('data', chunk => { const part = chunk.toString(); err = (err + part).slice(-6000); if (onProgress && totalDuration > 0) { progressBuffer = (progressBuffer + part).slice(-12000); const matches = [...progressBuffer.matchAll(/out_time_ms=(\d+)/g)]; if (matches.length) { const seconds = Number(matches[matches.length - 1][1]) / 1000000; onProgress(Math.max(0, Math.min(99, seconds / totalDuration * 100))); progressBuffer = progressBuffer.slice(-3000); } } });
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Processing timed out.')); }, timeoutMs);
    child.on('error', e => finish(new Error(e.code === 'ENOENT' ? `${command} is not installed on this server.` : e.message)));
    child.on('close', code => code === 0 ? finish() : finish(new Error(err || `${command} exited with code ${code}`)));
  });
}

async function probe(file) {
  const raw = await new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, ['-v','error','-show_entries','format=duration,format_name,bit_rate,size,start_time,nb_streams:format_tags:stream=codec_type,codec_name,profile,codec_long_name,codec_tag_string,width,height,coded_width,coded_height,display_aspect_ratio,sample_aspect_ratio,avg_frame_rate,r_frame_rate,nb_frames,pix_fmt,color_space,color_transfer,color_primaries,sample_rate,channels,channel_layout,sample_fmt,bit_rate,start_time,duration,bits_per_sample:stream_tags','-of','json',file], { windowsHide: true });
    let out = '', err = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { p.kill('SIGKILL'); finish(new Error('Media inspection timed out.')); }, 15000);
    p.stdout.on('data', d => { out += d; if (out.length > 1_000_000) { p.kill('SIGKILL'); finish(new Error('Media metadata output exceeded the safe limit.')); } });
    p.stderr.on('data', d => { err = (err + d).slice(-4000); });
    p.on('error', e => finish(new Error(e.code === 'ENOENT' ? 'FFprobe is not installed on this server.' : e.message)));
    p.on('close', c => c === 0 ? finish(null, out) : finish(new Error(err || 'Unable to inspect media.')));
  });
  return JSON.parse(raw);
}

function validateMagic(file) {
  const ext=path.extname(file.originalname||'').toLowerCase();
  const declared=String(file.mimetype||'').toLowerCase();
  if(declared&&declared!=='application/octet-stream'&&!(DECLARED_MIME[ext]||[]).includes(declared))throw new Error('The declared MIME type does not match the selected media extension.');
  const fd=fs.openSync(file.path,'r');const head=Buffer.alloc(16);let bytes=0;
  try{bytes=fs.readSync(fd,head,0,head.length,0);}finally{fs.closeSync(fd);}
  const starts=(...b)=>bytes>=b.length&&b.every((v,i)=>head[i]===v);
  const ascii=(offset,value)=>bytes>=offset+value.length&&head.toString('ascii',offset,offset+value.length)===value;
  let ok=false;
  if(['.mp4','.mov','.m4a'].includes(ext))ok=ascii(4,'ftyp');
  else if(['.webm','.mkv'].includes(ext))ok=starts(0x1a,0x45,0xdf,0xa3);
  else if(ext==='.mp3')ok=ascii(0,'ID3')||(starts(0xff,0xfb)||starts(0xff,0xf3)||starts(0xff,0xf2));
  else if(ext==='.wav')ok=ascii(0,'RIFF')&&ascii(8,'WAVE');
  else if(ext==='.flac')ok=ascii(0,'fLaC');
  else if(ext==='.ogg')ok=ascii(0,'OggS');
  else if(ext==='.aac')ok=starts(0xff,0xf1)||starts(0xff,0xf9);
  else if(['.jpg','.jpeg'].includes(ext))ok=starts(0xff,0xd8,0xff);
  else if(ext==='.png')ok=starts(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a);
  else if(ext==='.webp')ok=ascii(0,'RIFF')&&ascii(8,'WEBP');
  else if(ext==='.bmp')ok=ascii(0,'BM');
  else if(ext==='.tif'||ext==='.tiff')ok=starts(0x49,0x49,0x2a,0x00)||starts(0x4d,0x4d,0x00,0x2a);
  if(!ok)throw new Error('The file signature does not match its extension. Upload a valid, unmodified media file.');
}
async function validateMedia(file, expected, maxDuration) {
  validateMagic(file);
  const info = await probe(file.path);
  const streams = info.streams || [];
  const hasVideo = streams.some(x => x.codec_type === 'video');
  const hasAudio = streams.some(x => x.codec_type === 'audio');
  const hasImage = streams.some(x => x.codec_type === 'video' && Number(x.width) > 0 && Number(x.height) > 0);
  const ext=path.extname(file.originalname||'').toLowerCase();
  if (expected === 'video' && (!VIDEO_EXT.has(ext) || !hasVideo)) throw new Error('The uploaded file is not a valid supported video.');
  if (expected === 'audio' && (!['.mp3','.wav','.m4a','.aac','.ogg','.flac'].includes(ext) || !hasAudio || hasVideo)) throw new Error('Please upload a valid audio-only file.');
  if (expected === 'photo' && (!PHOTO_EXT.has(ext) || !hasImage || hasAudio)) throw new Error('Please upload a valid photo image.');
  if (expected === 'photo') { const imageStream=streams.find(x=>x.codec_type==='video'); if(Number(imageStream?.width||0)*Number(imageStream?.height||0)>50000000) throw new Error('Photo dimensions exceed the 50-megapixel safety limit.'); }
  const duration = Number(info.format?.duration || 0);
  if (maxDuration && duration > maxDuration) throw new Error(`Media duration exceeds the ${maxDuration >= 120 ? Math.floor(maxDuration / 60) + ' minute' : maxDuration + ' second'} limit.`);
  return info;
}
function detectedMemoryLimitMB(){
  for(const file of ['/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory/memory.limit_in_bytes']){try{const raw=fs.readFileSync(file,'utf8').trim();if(raw&&raw!=='max'){const n=Number(raw);if(Number.isFinite(n)&&n>0&&n<Number.MAX_SAFE_INTEGER)return Math.floor(n/1048576);}}catch{}}
  return Math.floor(os.totalmem()/1048576);
}
function estimateProcessing(file, info, body) {
  const streams=info.streams||[],video=streams.find(s=>s.codec_type==='video'),audio=streams.find(s=>s.codec_type==='audio');
  const duration=Math.max(0,Number(info.format?.duration||0)),sizeMB=file.size/1048576;
  const width=Number(video?.width||0),height=Number(video?.height||0);
  const rate=String(video?.avg_frame_rate||video?.r_frame_rate||'30/1').split('/').map(Number);
  const fps=rate.length===2&&rate[1]?rate[0]/rate[1]:30;
  const pixels=Math.max(1,(width*height)/(1920*1080));
  const target=String(body.resolution||'original').toLowerCase();
  const targetHeight=({'8k':4320,'4k':2160,'2k':1440,'1080p':1080,'720p':720,'480p':480})[target]||height;
  const scaleFactor=video&&height?Math.max(1,targetHeight/height):1;
  const tool=String(body.task||'convert');
  const toolFactor=tool==='visual-change'?8:tool==='enhance-video'?2.1:tool==='enhance-video-audio'?1.7:tool==='resize'?1.45:tool==='enhance-audio'?1.25:1;
  const audioFactor=audio?1+Math.min(0.4,Number(audio.sample_rate||0)/192000*0.2+Number(audio.bit_rate||0)/512000*0.2):1;
  const cpuCount=Math.max(1,os.cpus().length),load=Array.isArray(os.loadavg())&&os.loadavg()[0]>0?os.loadavg()[0]:0;
  const active=[...jobs.values()].filter(j=>j.status==='processing').length;
  const serverFactor=Math.min(2.5,1+Math.min(0.8,load/cpuCount)+Math.max(0,active-1)*0.18);
  const seconds=Math.max(10,Math.min(3600,Math.round(Math.round(8+duration*0.22*Math.max(1,fps/30)*pixels*scaleFactor*toolFactor*audioFactor+sizeMB*0.18)*serverFactor)));
  return {seconds,basis:{durationSeconds:Number(duration.toFixed(1)),sourceResolution:video?`${width}x${height}`:null,fps:Number(fps.toFixed(2)),fileSizeMB:Number(sizeMB.toFixed(1)),audioBitrate:Number(audio?.bit_rate||0),sampleRate:Number(audio?.sample_rate||0),activeJobs:active,serverLoadFactor:Number(serverFactor.toFixed(2)),note:'Heuristic estimate only; actual speed depends on hosting CPU, queue and codec complexity.'}};
}
function ownedUpload(req,id,expectedKind=null){
  const record=uploads.get(String(id||''));
  if(!record||record.ownerId!==currentUserId(req))return null;
  if(expectedKind&&record.kind!==expectedKind)return null;
  return {record,file:{path:record.path,originalname:record.originalName,size:record.size}};
}
function removeUpload(id){const record=uploads.get(String(id||''));if(record){uploads.delete(String(id));safeDelete(record.path);}}
function safeDelete(file) { if (file) fs.rm(file, { force: true }, () => {}); }

function analyzeAudioMetrics(input) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostats',
      '-i', input,
      '-vn',
      '-af', 'ebur128=peak=true,astats=metadata=1:reset=0,volumedetect',
      '-f', 'null', '-'
    ];

    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let output = '';
    let settled = false;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (!settled) {
        settled = true;
        reject(new Error('Audio analysis timed out.'));
      }
    }, 120000);

    child.stderr.on('data', chunk => {
      output = (output + chunk.toString()).slice(-30000);
    });

    child.on('error', error => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (code !== 0) {
        return reject(new Error('FFmpeg audio measurement failed: ' + output.slice(-1500)));
      }

      const last = regex => {
        const matches = [...output.matchAll(regex)];
        return matches.length ? Number(matches[matches.length - 1][1]) : null;
      };

      resolve({
        integratedLufs: last(/Integrated loudness:\s*(-?[\d.]+)\s*LUFS/gi) ?? last(/\bI:\s*(-?[\d.]+)\s*LUFS/gi),
        loudnessRange: last(/\bLRA:\s*(-?[\d.]+)\s*LU/gi),
        truePeakDbfs: last(/True peak:\s*(-?[\d.]+)\s*dBFS/gi) ?? last(/\bPeak:\s*(-?[\d.]+)\s*dBFS/gi),
        meanVolumeDb: last(/mean_volume:\s*(-?[\d.]+)\s*dB/gi),
        maxVolumeDb: last(/max_volume:\s*(-?[\d.]+)\s*dB/gi),
        rmsLevelDb: last(/RMS level dB:\s*(-?[\d.]+)/gi),
        peakLevelDb: last(/Peak level dB:\s*(-?[\d.]+)/gi),
        crestFactor: last(/Crest factor:\s*(-?[\d.]+)/gi),
        flatFactor: last(/Flat factor:\s*(-?[\d.]+)/gi),
        dynamicRange: last(/Dynamic range:\s*(-?[\d.]+)/gi)
      });
    });
  });
}

async function detectLongSilences(input, duration) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner','-nostats','-i',input,'-vn','-af','silencedetect=noise=-38dB:d=2.2','-f','null','-'];
    const child = spawn(FFMPEG,args,{stdio:['ignore','ignore','pipe']});
    let log = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Silence detection timed out.')); }, 120000);
    child.stderr.on('data',chunk => { log=(log+chunk.toString()).slice(-200000); });
    child.on('error',err => { clearTimeout(timer); reject(err); });
    child.on('close',code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(log.slice(-1500) || 'Silence detection failed.'));
      const starts = [...log.matchAll(/silence_start:\s*([\d.]+)/g)].map(m=>Number(m[1]));
      const ends = [...log.matchAll(/silence_end:\s*([\d.]+)/g)].map(m=>Number(m[1]));
      const ranges=[];
      for(let i=0;i<Math.min(starts.length,ends.length);i++){
        const start=Math.max(0,starts[i]), end=Math.min(duration,ends[i]);
        if(Number.isFinite(start)&&Number.isFinite(end)&&end-start>=2.2) ranges.push({start,end});
      }
      resolve(ranges);
    });
  });
}

const renderAutoEdit = createAutoEditRenderer({ FFMPEG, detectLongSilences, run });

// Small hosts (under 1 GB RAM, e.g. Render free) run out of memory with x264 'medium' at 1080p.
// LOW_RESOURCE forces the light x264 preset and caps output height at 720p. Override with LOW_RESOURCE=true|false.
const LOW_RESOURCE = process.env.LOW_RESOURCE === 'true' || (process.env.LOW_RESOURCE !== 'false' && detectedMemoryLimitMB() < 1024);
if (LOW_RESOURCE) { process.env.X264_PRESET = 'veryfast'; console.log('[Vidora] Low-resource mode: veryfast preset, 720p cap, MAX_VIDEO_SECONDS=' + MAX_VIDEO_SECONDS); }
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
  if (['normalize-audio','enhance-audio','enhance-video-audio'].includes(task) && !hasAudio) throw new Error('Audio enhancement requires an audio stream.');
  if (['normalize-audio','enhance-audio'].includes(task) && hasVideo) throw new Error('Audio Studio requires an audio-only upload.');
  if (task === 'enhance-video-audio' && !hasVideo) throw new Error('Video Audio Enhance requires a video with an audio stream.');
  if (!hasVideo && !['mp3','wav'].includes(format)) throw new Error('For audio-only input, choose MP3 or WAV output.');
  if (['resize','extract-audio','enhance-video','enhance-video-audio'].includes(task) && !hasVideo) throw new Error('This task requires a video input.');
  if (task === 'enhance-video' && ['mp3','wav'].includes(format)) throw new Error('Video enhancement requires a video output format.');
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
  if (task === 'normalize-audio' && hasAudio) {
    args.push('-af','loudnorm=I=-16:TP=-1.5:LRA=11');
  } else if (task === 'enhance-audio' && hasAudio) {
    args.push('-af', voiceCleanFilters(12).join(','));
  } else if (task === 'enhance-video-audio' && hasAudio) {
    args.push('-af', voiceCleanFilters(10).join(','));
  } else if (task === 'enhance-video' && hasAudio && String(body.aiAudioNoEnhancementNeeded) !== 'true') {
    const clampAudio = (value, min, max) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0;
    };
    const audioFilters = [];
    const gain = clampAudio(body.audioGainDb, -6, 6);
    const denoise = clampAudio(body.audioDenoise, 0, 6);

    if (gain !== 0) audioFilters.push(`volume=${gain.toFixed(2)}dB`);
    if (denoise > 0) audioFilters.push(`afftdn=nr=${denoise.toFixed(1)}`);
    if (String(body.audioLimiter) === 'true') audioFilters.push('alimiter=limit=0.95');

    if (audioFilters.length) args.push('-af', audioFilters.join(','));
  }
  if (hasVideo && !['mp3','wav'].includes(format)) {
    const videoFilters = [];

    if (resolution !== 'original' && ['8k','4k','2k','1080p','720p','480p'].includes(resolution)) {
      const h = ({ '8k':4320,'4k':2160,'2k':1440 })[resolution] || Number(resolution.slice(0,-1));
      videoFilters.push(`scale=-2:${h}:flags=lanczos`);
    }

    if (task === 'enhance-video') {
      const clamp = (value, min, max, fallback = 0) => {
        const number = Number(value);
        return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
      };

      const sharpness = clamp(body.enhanceSharpness, 0, 2);
      const denoise = clamp(body.enhanceDenoise, 0, 3);
      const brightness = clamp(body.enhanceBrightness, -0.2, 0.2);
      const contrast = clamp(body.enhanceContrast, 0.5, 1.5, 1);
      const saturation = clamp(body.enhanceSaturation, 0, 2, 1);

      videoFilters.push(...enhanceVideoFilters({ sharpness, denoise, brightness, contrast, saturation, lowResource: LOW_RESOURCE }));
      videoFilters.push(...visualStyleFilters(body.visualStyle));
    }
    if (task === 'visual-change' && isLocalLook(body.visualStyle)) videoFilters.push(...lookFilters(body.visualStyle));

    if (LOW_RESOURCE && resolution === 'original') videoFilters.unshift('scale=-2:min(720\\,ih)');
    if (videoFilters.length) args.push('-vf', videoFilters.join(','));

    const preset = LOW_RESOURCE ? 'veryfast' : quality === 'high' ? 'slow' : quality === 'small' ? 'veryfast' : 'medium';
    if (['mp4','mov'].includes(format)) args.push('-c:v','libx264','-preset',preset,'-crf',quality === 'high' ? '18' : quality === 'small' ? '28' : '23');
    else args.push('-c:v','libvpx-vp9','-crf',quality === 'high' ? '26' : quality === 'small' ? '38' : '32','-b:v','0');
  }
  if (['normalize-audio','enhance-audio','enhance-video-audio'].includes(task) && hasAudio && hasVideo && !['mp3','wav'].includes(format)) {
    // Preserve the selected video codec and normalize only the audio stream.
    args.push('-c:a', format === 'webm' ? 'libopus' : 'aac');
  } else if (['normalize-audio','enhance-audio'].includes(task) && hasAudio && ['mp3','wav'].includes(format)) {
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

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'Vidora AI'
  });
});

app.get('/api/system-status', requireSession, (_req, res) => {
  const commandAvailable = command => new Promise(resolve => {
    const child = spawn(command, ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill('SIGKILL'); resolve(false); } }, 4000);
    child.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(false); } });
    child.on('close', code => { if (!settled) { settled = true; clearTimeout(timer); resolve(code === 0); } });
  });
  const databaseReady = app.locals.vidoraPool ? app.locals.vidoraPool.query('SELECT 1').then(()=>true).catch(()=>false) : Promise.resolve(false);
  Promise.all([commandAvailable(FFMPEG), commandAvailable(FFPROBE), commandAvailable(FPCALC), databaseReady]).then(([ffmpeg, ffprobe, fpcalc, database]) => {
    res.json({ ok: true, service: 'Vidora AI', capabilities: {
      database, geminiConfigured: Boolean(geminiAI), runwayVisualChangeConfigured: Boolean(process.env.RUNWAYML_API_SECRET), visualChangeProvider: visualProviderName(), ffmpeg, ffprobe, chromaprint: fpcalc,
      aiVision: Boolean(geminiAI), localMediaAnalysis: ffmpeg && ffprobe,
      audioFingerprint: fpcalc
    }, note: 'Database connectivity and local binaries were checked. Gemini API key presence is configuration-only; model access is verified when an analysis request runs.' });
  });
});

function detectSceneChanges(input, duration) {
  return new Promise(resolve => {
    const args = ['-hide_banner','-nostats','-i',input,'-an','-vf',"select='gt(scene,0.32)',showinfo",'-f','null','-'];
    const child = spawn(FFMPEG, args, { stdio: ['ignore','ignore','pipe'] });
    let log = '', settled = false;
    const finish = values => { if (settled) return; settled = true; clearTimeout(timer); resolve(values); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish([]); }, 90000);
    child.stderr.on('data', chunk => { log = (log + chunk.toString()).slice(-250000); });
    child.on('error', () => finish([]));
    child.on('close', code => {
      if (code !== 0) return finish([]);
      const values = [...log.matchAll(/pts_time:([0-9.]+)/g)].map(m => Number(m[1])).filter(n => Number.isFinite(n) && n > 0 && n < duration);
      const unique = [...new Set(values.map(n => Number(n.toFixed(2))))];
      finish(unique.slice(0, 100));
    });
  });
}
app.post('/api/audio-fingerprint', requireSession, analysisLimit, audioUpload.fields([{ name:'referenceAudio', maxCount:1 },{ name:'checkAudio', maxCount:1 }]), async (req,res) => {
  const files=req.files||{};let reference=files.referenceAudio?.[0],storedId=null;const check=files.checkAudio?.[0];
  if(!reference&&req.body.referenceUploadId){const stored=ownedUpload(req,req.body.referenceUploadId,'audio');if(stored){reference=stored.file;storedId=stored.record.id;}}
  if(!reference||!check){if(files.referenceAudio?.[0])safeDelete(files.referenceAudio[0].path);if(check)safeDelete(check.path);return res.status(400).json({error:'Upload the second audio file to compare with the selected source.'});}
  try {
    await Promise.all([validateMedia(reference,'audio',MAX_AUDIO_SECONDS),validateMedia(check,'audio',MAX_AUDIO_SECONDS)]);
    const [refFp,checkFp]=await Promise.all([getFingerprint(reference.path),getFingerprint(check.path)]);
    const comparison=compareFingerprints(refFp.values,checkFp.values,refFp.duration,checkFp.duration),score=Number(comparison.score.toFixed(1));
    const result=score>=90?'Very high similarity':score>=75?'High similarity':score>=60?'Moderate similarity':'Low similarity';
    res.json({ok:true,analysis:{referenceDuration:Number(refFp.duration.toFixed(1)),checkDuration:Number(checkFp.duration.toFixed(1)),referenceFingerprintLength:refFp.values.length,checkFingerprintLength:checkFp.values.length,similarity:score,result,comparedSegments:comparison.compared,matchingSegments:comparison.segments,differentSegments:comparison.differentSegments,alignmentOffsetSeconds:comparison.alignmentOffsetSeconds,alignmentSearchRangeSeconds:300,confidence:Math.min(0.99,comparison.compared/20)*Math.max(0.2,score/100),engine:'Chromaprint',method:'Raw Chromaprint fingerprint alignment',limitations:'Only the two supplied audio files are compared. Fingerprint offsets are approximate and alignment search is limited to ±300 seconds; this is not a global copyright search or a copyright/ownership verdict.'},notice:'This compares acoustic fingerprints of the two uploaded files. It does not search a global copyright database and is not a copyright clearance or infringement decision.'});
  }catch(e){res.status(500).json({error:e.message||'Fingerprint analysis failed.'});}
  finally{if(files.referenceAudio?.[0])safeDelete(files.referenceAudio[0].path);safeDelete(check.path);if(storedId)removeUpload(storedId);}
});

app.post('/api/video-fingerprint', requireSession, analysisLimit, videoPairUpload.fields([{name:'referenceVideo',maxCount:1},{name:'checkVideo',maxCount:1}]), async(req,res)=>{
  const files=req.files||{};let reference=files.referenceVideo?.[0],storedId=null;const check=files.checkVideo?.[0];
  if(!reference&&req.body.referenceUploadId){const stored=ownedUpload(req,req.body.referenceUploadId,'video');if(stored){reference=stored.file;storedId=stored.record.id;}}
  if(!reference||!check){if(files.referenceVideo?.[0])safeDelete(files.referenceVideo[0].path);if(check)safeDelete(check.path);return res.status(400).json({error:'Upload the second video to compare with the selected source.'});}
  try{
    await Promise.all([validateMedia(reference,'video',MAX_VIDEO_SECONDS),validateMedia(check,'video',MAX_VIDEO_SECONDS)]);
    const [a,b]=await Promise.all([extractVideoHashes(reference.path),extractVideoHashes(check.path)]);
    const match=compareVideoHashes(a,b),similarity=Number(match.score.toFixed(1));
    const matched=similarity>=90?'Very high visual similarity':similarity>=75?'High visual similarity':similarity>=60?'Moderate visual similarity':'Low visual similarity';
    res.json({ok:true,analysis:{similarity,result:matched,referenceFrames:a.length,checkFrames:b.length,comparedFrames:match.compared,matchedFrames:match.matchedFrames,differentFrames:match.differentFrames,matchingSegments:match.segments,alignmentOffsetSeconds:match.offset,alignmentSearchRangeSeconds:60,sampling:'1 frame/second, 64-bit perceptual difference hash',confidence:Math.min(0.99,match.compared/10)*Math.max(0.2,similarity/100),limitations:'Visual frame sampling is approximate, can miss brief segments, and alignment search is limited to ±60 seconds. This is not a copyright or ownership verdict.'}});
  }catch(e){res.status(400).json({error:e.message||'Video fingerprint comparison failed.'});}
  finally{if(files.referenceVideo?.[0])safeDelete(files.referenceVideo[0].path);safeDelete(check.path);if(storedId)removeUpload(storedId);}
});

app.post('/api/photo-enhance', requireSession, mediaJobLimit, photoUpload.single('media'), async(req,res)=>{
  let source=req.file,storedId=null;if(!source&&req.body.uploadId){const stored=ownedUpload(req,req.body.uploadId,'photo');if(!stored)return res.status(404).json({error:'Uploaded photo not found or expired.'});source=stored.file;storedId=stored.record.id;}
  if(!source)return res.status(400).json({error:'Choose one photo first.'});
  const output=path.join(OUT_DIR,`${crypto.randomUUID()}.png`);let workDir=null,mode='local-conservative-fallback',confidence=0;
  try{
    const photoInfo=await validateMedia(source,'photo',0);
    if(gradioConfigured('PHOTO')){
      // Neural enhancement through a free Gradio/Hugging Face Space. Any failure falls back to the local filters below.
      const prepared=path.join(OUT_DIR,`${crypto.randomUUID()}.photo-in.png`),raw=path.join(OUT_DIR,`${crypto.randomUUID()}.photo-out.bin`);
      try{
        await run(FFMPEG,['-hide_banner','-loglevel','error','-y','-i',source.path,'-frames:v','1','-vf','scale=min(1024\\,iw):min(1024\\,ih):force_original_aspect_ratio=decrease:flags=lanczos,format=rgb24',prepared],60000);
        await transformWithGradio({prefix:'PHOTO',inputPath:prepared,outputPath:raw,mime:'image/png',maxWaitMs:Math.max(30000,Number(process.env.PHOTO_MAX_WAIT_MS)||90000),label:'free photo AI server'});
        await run(FFMPEG,['-hide_banner','-loglevel','error','-y','-i',raw,'-frames:v','1',output],60000);
        res.setHeader('X-Vidora-AI-Mode','neural-gradio');res.setHeader('X-Vidora-AI-Confidence','1');
        return res.download(output,'vidora-photo-enhanced.png',()=>safeDelete(output));
      }catch(e){console.warn('[Vidora Photo] Neural photo enhancement failed; using local filters:',e.message);safeDelete(output);}
      finally{safeDelete(prepared);safeDelete(raw);}
    }
    let settings={sharpness:0.9,denoise:1.2,brightness:0,contrast:1.08,saturation:1.1,noEnhancementNeeded:false};
    if(geminiAI){
      workDir=fs.mkdtempSync(path.join(os.tmpdir(),'vidora-photo-ai-'));
      const sample=path.join(workDir,'sample.png');
      await run(FFMPEG,['-hide_banner','-loglevel','error','-y','-i',source.path,'-frames:v','1','-vf','scale=1024:1024:force_original_aspect_ratio=decrease:flags=area','-compression_level','6',sample],60000);
      const prompt='You are a careful professional photo-quality analyst. Inspect this downscaled preview only. Assess visible blur, noise, exposure, contrast, colour and detail. Preserve identity, composition, skin tone and natural appearance. Do not invent or add content. Recommend only necessary conventional filter strengths. Return ONLY JSON with keys: summary, confidence (0..1), noEnhancementNeeded (boolean), sharpness (0..1.5), denoise (0..2), brightness (-0.15..0.15), contrast (0.8..1.2), saturation (0.8..1.2).';
      const photoModels=['gemini-3.8-flash',process.env.GEMINI_FALLBACK_MODEL||'gemini-3.6-flash'];let parsedPhoto=null,lastPhotoError=null;
      for(const model of [...new Set(photoModels)]){try{const result=await geminiAI.interactions.create({model,input:[{type:'text',text:prompt},{type:'image',data:fs.readFileSync(sample).toString('base64'),mime_type:'image/png'}],automatic_continuation:false,store:false},{timeout_ms:90000,retries:{attempts:1}});const textOut=String(result.output_text||'').replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');parsedPhoto=JSON.parse(textOut);break;}catch(e){lastPhotoError=e;}}
      if(parsedPhoto){const clamp=(v,min,max,fallback)=>{const n=Number(v);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;};settings={sharpness:clamp(parsedPhoto.sharpness,0,1.5,0.4),denoise:clamp(parsedPhoto.denoise,0,2,1),brightness:clamp(parsedPhoto.brightness,-0.15,0.15,0),contrast:clamp(parsedPhoto.contrast,0.8,1.2,1),saturation:clamp(parsedPhoto.saturation,0.8,1.2,1),noEnhancementNeeded:parsedPhoto.noEnhancementNeeded===true};confidence=clamp(parsedPhoto.confidence,0,1,0);mode='gemini-guided-conventional-filters';}
      else console.warn('[Vidora Photo] Gemini assessment unavailable; using conservative local filters:',lastPhotoError?.message||'No valid model response.');
    }
    if(settings.noEnhancementNeeded)settings={...settings,sharpness:0,denoise:0,brightness:0,contrast:1,saturation:1};
    const vf=`hqdn3d=${settings.denoise}:${settings.denoise}:3:3,unsharp=5:5:${settings.sharpness}:3:3:${Math.min(0.4,settings.sharpness*0.25)},eq=brightness=${settings.brightness}:contrast=${settings.contrast}:saturation=${settings.saturation}`;
    const pixFmt=String((photoInfo.streams||[]).find(x=>x.codec_type==='video')?.pix_fmt||'');
    const hasAlpha=/^(?:yuva|gbrap|rgba|bgra|argb|abgr|ya\d|pal8)/i.test(pixFmt);
    const args=['-hide_banner','-loglevel','error','-y','-i',source.path];
    if(hasAlpha){args.push('-filter_complex',`[0:v]split=2[base][alpha];[base]format=rgb24,${vf}[enh];[alpha]alphaextract[mask];[enh][mask]alphamerge,format=rgba[out]`,'-map','[out]');}
    else args.push('-vf',vf);
    args.push('-frames:v','1','-map_metadata','0','-compression_level','6',output);
    await run(FFMPEG,args,120000);
    res.setHeader('X-Vidora-AI-Mode',mode);res.setHeader('X-Vidora-AI-Confidence',String(confidence));
    res.download(output,'vidora-photo-enhanced.png',()=>safeDelete(output));
  }catch(e){safeDelete(output);res.status(400).json({error:e.message||'Photo enhancement failed.'});}
  finally{if(req.file)safeDelete(req.file.path);if(storedId)removeUpload(storedId);if(workDir)fs.rm(workDir,{recursive:true,force:true},()=>{});}
});

app.post('/api/media-details', requireSession, analysisLimit, upload.single('media'), async(req,res)=>{
  let source=req.file,storedId=null;
  if(!source&&req.body.uploadId){const stored=ownedUpload(req,req.body.uploadId,'video');if(!stored)return res.status(404).json({error:'Uploaded video not found or expired.'});source=stored.file;storedId=stored.record.id;}
  if(!source)return res.status(400).json({error:'Choose a video first.'});
  try{const info=await validateMedia(source,'video',MAX_VIDEO_SECONDS);res.json({ok:true,details:info});}
  catch(e){res.status(400).json({error:e.message||'Could not inspect video.'});}
  finally{if(req.file)safeDelete(req.file.path);if(storedId)removeUpload(storedId);}
});

app.post('/api/ai-edit-plan', requireSession, analysisLimit, upload.single('media'), async (req, res) => {
  let workDir = null,sourceFile=req.file,storedUploadId=null;
  if(!sourceFile&&req.body.uploadId){const stored=ownedUpload(req,req.body.uploadId,'video');if(!stored)return res.status(404).json({error:'Uploaded video not found or expired.'});sourceFile=stored.file;storedUploadId=stored.record.id;}
  try {
    if (req.body.rightsConfirmed !== 'true') {
      if (req.file) safeDelete(req.file.path);
      return res.status(400).json({ error: 'Confirm that you have permission to process this media.' });
    }
    if (!sourceFile) return res.status(400).json({ error: 'Choose a video first.' });
    // Gemini is optional; an honest local fallback is returned when it is unavailable.

    const info = await validateMedia(sourceFile, 'video', MAX_VIDEO_SECONDS);
    const video = (info.streams || []).find(x => x.codec_type === 'video');
    if (!video) throw new Error('AI Auto Editor requires a video file.');

    const audioStream = (info.streams || []).some(x => x.codec_type === 'audio');
    const audioMetricsPromise = audioStream
      ? analyzeAudioMetrics(sourceFile.path)
      : Promise.resolve(null);

    const duration = Math.max(0, Number(info.format?.duration || 0));
    if (!duration) throw new Error('Could not read video duration.');

    const width = Number(video.width || 0);
    const height = Number(video.height || 0);
    const fps = String(video.avg_frame_rate || video.r_frame_rate || 'unknown');
    const codec = String(video.codec_name || 'unknown');

    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidora-ai-frames-'));

    const metadata = {
      durationSeconds: Number(duration.toFixed(2)),
      width,
      height,
      fps,
      codec
    };

    const parts = [{
      type: 'text',
      text: 'You are Vidora AI Deep Vision, a careful professional video-quality analyst. Analyze all supplied adaptively selected frames together and use their timestamps plus the video metadata. Describe visible content and scene changes. Evaluate visible blur, noise, exposure, lighting, contrast, colour balance, saturation and detail. These are visual estimates, not laboratory measurements. Do not claim to have listened to audio or analyzed unseen frames. Recommend only corrections genuinely needed. Preserve natural colours, skin tones and original artistic intent. Avoid excessive sharpening, denoising or saturation. If footage already looks good, set noEnhancementNeeded true and use neutral settings. For an editor-facing plan also return: recommendedCuts (array of objects with startSeconds, endSeconds, reason and confidence; only propose cuts supported by sampled timestamps), pacingRecommendation, transitionRecommendations (array), titleCardSuggestions (array), continuityNotes (array), and suggestedSequence (array of sampled frame indexes). Never invent unseen footage or assert that a suggested edit has been rendered. Return ONLY valid JSON with keys: summary, contentType, sceneDescription, visualIssues (array), confidence (0 to 1), enhancementReason, noEnhancementNeeded (boolean), recommendedCuts, pacingRecommendation, transitionRecommendations, titleCardSuggestions, continuityNotes, suggestedSequence, sharpness (0 to 2), denoise (0 to 3), brightness (-0.2 to 0.2), contrast (0.5 to 1.5), saturation (0 to 2). Video metadata: ' + JSON.stringify(metadata)
    }];

    const preparationStartedAt = Date.now();
    const sceneChangesPromise = detectSceneChanges(sourceFile.path, duration);
    const [audioMetrics, sceneChanges] = await Promise.all([
      audioMetricsPromise,
      sceneChangesPromise
    ]);

    // Adaptive sampling: duration sets the baseline; detected scene changes,
    // resolution and frame rate increase the budget when useful.
    const fpsParts = fps.split('/').map(Number);
    const fpsValue = fpsParts.length === 2 && fpsParts[1] ? fpsParts[0] / fpsParts[1] : Number(fps);
    const resolutionFactor = width * height >= 3840 * 2160 ? 1.2 :
      width * height >= 1920 * 1080 ? 1.1 : 1;
    const motionSamplingFactor = Number.isFinite(fpsValue) && fpsValue >= 50 ? 1.12 : 1;
    const durationBudget = duration <= 15 ? 10 :
      duration <= 30 ? 14 :
      duration <= 60 ? 20 :
      duration <= 180 ? 28 :
      duration <= 600 ? 40 : 50;
    const sceneBudget = Math.min(12, Math.ceil(sceneChanges.length * 0.35));
    const frameBudget = Math.max(8, Math.min(60,
      Math.ceil((durationBudget + sceneBudget) * resolutionFactor * motionSamplingFactor)));

    const candidates = new Map();
    const addCandidate = (time, priority, reason) => {
      const t = Math.min(Math.max(0, duration - 0.08), Math.max(0, Number(time)));
      if (!Number.isFinite(t)) return;
      const key = t.toFixed(2);
      const old = candidates.get(key);
      if (!old || priority > old.priority) candidates.set(key, { time: Number(key), priority, reason });
    };
    addCandidate(0, 100, 'start');
    addCandidate(duration - 0.1, 95, 'end');
    // Uniform coverage prevents long gaps even when scene detection is sparse.
    for (let i = 1; i < frameBudget - 1; i++) {
      addCandidate((duration * i) / (frameBudget - 1), 20, 'uniform');
    }
    // Sample immediately before/after scene cuts to capture transitions.
    for (const sceneTime of sceneChanges) {
      addCandidate(sceneTime - 0.18, 85, 'scene-before');
      addCandidate(sceneTime + 0.12, 90, 'scene-after');
    }
    const ranked = [...candidates.values()].sort((a, b) => b.priority - a.priority || a.time - b.time);
    const selected = [];
    const minGap = Math.max(0.25, Math.min(1.5, duration / (frameBudget * 3)));
    for (const item of ranked) {
      if (selected.length >= frameBudget) break;
      if (selected.every(existing => Math.abs(existing.time - item.time) >= minGap)) selected.push(item);
    }
    // Fill any gaps caused by near-duplicate candidates.
    for (let i = 0; selected.length < frameBudget && i < frameBudget * 4; i++) {
      const t = duration * (i + 0.5) / (frameBudget * 4);
      if (selected.every(existing => Math.abs(existing.time - t) >= minGap)) {
        selected.push({ time: Number(t.toFixed(2)), priority: 10, reason: 'gap-fill' });
      }
    }
    selected.sort((a, b) => a.time - b.time);
    const times = selected.map(item => item.time);
    let frameSelection = selected.map((item, index) => ({
      index, timestampSeconds: item.time, reason: item.reason
    }));
    const frameFiles = times.map((_, i) => path.join(workDir, 'frame-' + i + '.png'));

    const extractFrame = async (index, requestedTime) => {
      const output = frameFiles[index];
      const candidates = [...new Set([
        requestedTime,
        requestedTime - 0.15,
        requestedTime - 0.4,
        requestedTime - 0.8,
        requestedTime - 1.5,
        0
      ].map(value => Math.max(0, Number(value.toFixed(3)))))];
      let lastError = null;

      for (let attempt = 0; attempt < candidates.length; attempt++) {
        const seekTime = candidates[attempt];
        try {
          fs.rmSync(output, { force: true });
          await run(FFMPEG, [
            '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
            '-ss', String(seekTime), '-i', sourceFile.path,
            '-map', '0:v:0', '-an', '-sn', '-dn',
            '-frames:v', '1',
            '-vf', 'scale=640:-2,format=rgb24',
            '-c:v', 'png',
            output
          ], 90000);

          const stat = fs.statSync(output);
          if (stat.isFile() && stat.size > 128) {
            return { index, time: times[index], path: output, reason: selected[index].reason, seekTime, attempts: attempt + 1 };
          }
          lastError = new Error('FFmpeg returned without creating a usable frame file.');
        } catch (error) {
          lastError = error;
        }
        fs.rmSync(output, { force: true });
      }

      console.warn('[Vidora AI] Frame extraction skipped:', index, 'timestamp:', requestedTime, 'reason:', lastError?.message || 'No output');
      return null;
    };

    const extractionResults = [];
    const batchSize = 3;
    for (let i = 0; i < times.length; i += batchSize) {
      const batch = times.slice(i, i + batchSize);
      const results = await Promise.all(batch.map((time, offset) => extractFrame(i + offset, time)));
      extractionResults.push(...results);
    }

    const extractedFrames = extractionResults.filter(Boolean);
    if (!extractedFrames.length) {
      throw new Error('FFmpeg could not extract any usable video frames. Check the video codec, FFmpeg installation, and file integrity.');
    }

    // Keep timestamps and frame indexes aligned with the images actually sent to Gemini.
    frameSelection = extractedFrames.map((frame, index) => ({
      index,
      timestampSeconds: frame.time,
      reason: frame.reason,
      extractionSeekSeconds: frame.seekTime,
      extractionAttempts: frame.attempts
    }));


    parts.push({
      type: 'text',
      text: 'COMBINED AUDIO ANALYSIS: Analyze objective FFmpeg audio measurements alongside the video frames. You have NOT listened to the audio. Never claim to hear speech, music, background noise or distortion. Do not infer noise reduction needs from loudness metrics alone. Return additional JSON keys: audioSummary, audioIssues (array), audioEnhancementReason, noAudioEnhancementNeeded (boolean), audioGainDb (-6 to 6), audioDenoise (0 to 6; use 0 unless reliable evidence supports noise reduction), audioLimiter (boolean). If audioMetrics is null, set noAudioEnhancementNeeded true, audioGainDb 0, audioDenoise 0 and audioLimiter false. Preserve natural audio. Consider true peak safety. Audio measurements: ' + JSON.stringify(audioMetrics)
    });
    parts.push({
      type: 'text',
      text: 'Sampling report: ' + JSON.stringify({ frameBudget, sceneCount: sceneChanges.length, frameSelection })
    });
    for (const frame of extractedFrames) {
      parts.push({
        type: 'image',
        data: fs.readFileSync(frame.path).toString('base64'),
        mime_type: 'image/png'
      });
    }

    console.log('[Vidora AI] Audio + frame preparation:',
      ((Date.now() - preparationStartedAt) / 1000).toFixed(2), 'seconds');

    const geminiStartedAt = Date.now();

    console.log('[Vidora AI] Gemini request started. Sending frames and audio metrics...');

    const primaryModel = 'gemini-3.8-flash';
    const fallbackModel = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.6-flash';
    const models = !geminiAI ? [] : (fallbackModel && fallbackModel !== primaryModel
      ? [primaryModel, fallbackModel]
      : [primaryModel]);

    let result = null;
    let lastGeminiError = null;

    let modelUsed = 'local-technical-fallback';

    for (const model of models) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log('[Vidora AI] Trying', model, '- attempt', attempt);

          result = await geminiAI.interactions.create({
            model,
            input: parts,
            automatic_continuation: false,
            store: false
          }, {
            // Representative frames + audio metrics can take longer than a text-only call.
            // Keep this bounded and configurable rather than silently aborting at 60 seconds.
            timeout_ms: Math.max(60000, Math.min(240000, Number(process.env.GEMINI_REQUEST_TIMEOUT_MS) || 180000)),
            retries: { attempts: 1 }
          });

          modelUsed = model;
          console.log('[Vidora AI] Gemini succeeded:', model);
          break;
        } catch (error) {
          lastGeminiError = error;
          const status = Number(error.status || error.code || error.response?.status || 0);
          const retryable = status === 429 || status === 503 || status >= 500;

          console.error('[Vidora AI] Gemini error:', status, error.message);

          if (!retryable || attempt === 3) break;

          const baseDelay = Math.min(12000, 2000 * Math.pow(2, attempt - 1));
          const delay = baseDelay + Math.floor(Math.random() * 1000);
          console.log('[Vidora AI] Retrying after', delay, 'ms...');
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }

      if (result) break;
    }

    if (!result) {
      console.log('[Vidora AI] Gemini unavailable. Using local technical fallback.');
      const fallbackData = {
        summary: 'Gemini is unavailable. Local technical fallback used media metadata and FFmpeg measurements. Visual quality was not assessed.',
        contentType: 'Video media',
        sceneDescription: 'Visual scene analysis unavailable in local fallback mode.',
        visualIssues: [],
        confidence: 0,
        enhancementReason: 'Visual quality could not be assessed. No automatic visual filters recommended.',
        noEnhancementNeeded: true,
        sharpness: 0, denoise: 0, brightness: 0, contrast: 1, saturation: 1,
        audioSummary: audioStream ? 'FFmpeg audio measurements collected. Original audio preserved.' : 'No audio stream detected.',
        audioIssues: [],
        audioEnhancementReason: 'No audio correction recommended in fallback mode.',
        noAudioEnhancementNeeded: true,
        audioGainDb: 0, audioDenoise: 0, audioLimiter: false
      };
      result = { output_text: JSON.stringify(fallbackData) };
      modelUsed = 'local-technical-fallback';
    }

    console.log('[Vidora AI] Gemini response:',
      ((Date.now() - geminiStartedAt) / 1000).toFixed(2), 'seconds');

    let raw = String(result.output_text || '').trim();
    raw = raw.split(String.fromCharCode(96).repeat(3)).join('').trim().replace(/^\s*json\s*/i, '');
    let parsed;
    try {
      parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Gemini returned JSON in an unexpected format.');
    } catch (parseError) {
      console.error('[Vidora AI] Gemini response JSON could not be parsed:', parseError.message);
      lastGeminiError = parseError;
      modelUsed = 'local-technical-fallback';
      parsed = {
        summary: 'Gemini returned an unreadable response. Local technical fallback used media metadata and FFmpeg measurements. Visual quality was not assessed.',
        contentType: 'Video media',
        sceneDescription: 'Visual scene analysis unavailable because the Gemini response was invalid.',
        visualIssues: [], confidence: 0,
        enhancementReason: 'Visual quality could not be assessed. No automatic visual filters recommended.',
        noEnhancementNeeded: true,
        sharpness: 0, denoise: 0, brightness: 0, contrast: 1, saturation: 1,
        audioSummary: audioStream ? 'FFmpeg audio measurements collected. Original audio preserved.' : 'No audio stream detected.',
        audioIssues: [], audioEnhancementReason: 'No audio correction recommended in fallback mode.',
        recommendedCuts: [], pacingRecommendation: 'No AI edit plan available in local fallback mode.', transitionRecommendations: [], titleCardSuggestions: [], continuityNotes: [], suggestedSequence: [],
        noAudioEnhancementNeeded: true, audioGainDb: 0, audioDenoise: 0, audioLimiter: false
      };
    }

    const clamp = (v, min, max, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };

    const settings = {
      enhanceSharpness: clamp(parsed.sharpness, 0, 2, 0),
      enhanceDenoise: clamp(parsed.denoise, 0, 3, 0),
      enhanceBrightness: clamp(parsed.brightness, -0.2, 0.2, 0),
      enhanceContrast: clamp(parsed.contrast, 0.5, 1.5, 1),
      enhanceSaturation: clamp(parsed.saturation, 0, 2, 1),
      audioGainDb: clamp(parsed.audioGainDb, -6, 6, 0),
      audioDenoise: clamp(parsed.audioDenoise, 0, 6, 0),
      audioLimiter: parsed.audioLimiter === true
    };

    const noEnhancementNeeded = parsed.noEnhancementNeeded === true;
    const noAudioEnhancementNeeded = !audioStream || parsed.noAudioEnhancementNeeded === true;

    if (noAudioEnhancementNeeded) {
      settings.audioGainDb = 0;
      settings.audioDenoise = 0;
      settings.audioLimiter = false;
    }

    if (noEnhancementNeeded) {
      settings.enhanceSharpness = 0;
      settings.enhanceDenoise = 0;
      settings.enhanceBrightness = 0;
      settings.enhanceContrast = 1;
      settings.enhanceSaturation = 1;
    }

    res.json({
      ok: true,
      model: modelUsed,
      analysisMode: modelUsed === 'local-technical-fallback' ? 'Local Technical Fallback' : 'Deep Vision',
      framesAnalyzed: modelUsed === 'local-technical-fallback' ? 0 : extractedFrames.length,
      adaptiveAnalysis: { enabled: true, frameBudget, framesExtracted: extractedFrames.length, frameSelection, sceneCount: sceneChanges.length, samplingStrategy: 'duration + scene-change + resolution + fps', preparationTimeSeconds: Number(((Date.now() - preparationStartedAt) / 1000).toFixed(2)) },
      videoMetadata: metadata,
      summary: String(parsed.summary || 'Video analysis completed.').slice(0, 500),
      contentType: String(parsed.contentType || 'Unknown').slice(0, 100),
      sceneDescription: String(parsed.sceneDescription || 'Scene description unavailable.').slice(0, 500),
      visualIssues: modelUsed === 'local-technical-fallback' ? [] : (Array.isArray(parsed.visualIssues)
        ? parsed.visualIssues.slice(0, 10).map(x => String(x).slice(0, 100))
        : []),
      visualAssessmentStatus: modelUsed === 'local-technical-fallback' ? 'not_assessed' : 'sampled_frames_assessed',
      sceneChanges,
      sceneChangeCount: sceneChanges.length,
      sceneDetectionStatus: sceneChanges.length ? 'changes_detected' : 'no_changes_above_threshold',
      geminiError: modelUsed === 'local-technical-fallback' ? String(lastGeminiError?.message || (geminiAI ? 'Gemini request failed.' : 'GEMINI_API_KEY is not configured.')).slice(0, 240) : null,
      confidence: clamp(parsed.confidence, 0, 1, 0),
      enhancementReason: String(parsed.enhancementReason || 'No additional explanation provided.').slice(0, 500),
      recommendedCuts: modelUsed==='local-technical-fallback'?[]:(Array.isArray(parsed.recommendedCuts)?parsed.recommendedCuts.slice(0,10).map(c=>({startSeconds:clamp(c.startSeconds,0,duration,0),endSeconds:clamp(c.endSeconds,0,duration,0),reason:String(c.reason||'').slice(0,200),confidence:clamp(c.confidence,0,1,0)})).filter(c=>c.endSeconds>c.startSeconds):[]),
      pacingRecommendation: String(parsed.pacingRecommendation || 'No pacing recommendation available.').slice(0,500),
      transitionRecommendations: Array.isArray(parsed.transitionRecommendations)?parsed.transitionRecommendations.slice(0,8).map(x=>String(x).slice(0,160)):[],
      titleCardSuggestions: Array.isArray(parsed.titleCardSuggestions)?parsed.titleCardSuggestions.slice(0,8).map(x=>String(x).slice(0,160)):[],
      continuityNotes: Array.isArray(parsed.continuityNotes)?parsed.continuityNotes.slice(0,8).map(x=>String(x).slice(0,160)):[],
      suggestedSequence: Array.isArray(parsed.suggestedSequence)?parsed.suggestedSequence.slice(0,frameSelection.length).map(x=>clamp(x,0,Math.max(0,frameSelection.length-1),0)):[],
      noEnhancementNeeded,
      audioSummary: String(parsed.audioSummary || (audioStream ? 'Audio measurements analyzed.' : 'No audio stream detected.')).slice(0, 500),
      audioIssues: Array.isArray(parsed.audioIssues) ? parsed.audioIssues.slice(0, 10).map(x => String(x).slice(0, 100)) : [],
      audioEnhancementReason: String(parsed.audioEnhancementReason || 'No additional audio correction recommended.').slice(0, 500),
      noAudioEnhancementNeeded,
      audioMetrics,
      settings
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'AI video analysis failed.' });
  } finally {
    if (req.file) safeDelete(req.file.path);
    if (workDir) fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
});
app.post('/api/jobs', requireSession, mediaJobLimit, upload.single('media'), async (req,res) => {
  if (req.body.rightsConfirmed !== 'true') { if (req.file) safeDelete(req.file.path); return res.status(400).json({ error:'Confirm that you have permission to process this media.' }); }
  let sourceFile=req.file,storedUploadId=null;
  if(!sourceFile&&req.body.uploadId){const stored=ownedUpload(req,req.body.uploadId);if(!stored)return res.status(404).json({error:'Uploaded media not found or expired.'});sourceFile=stored.file;storedUploadId=stored.record.id;}
  if (!sourceFile) return res.status(400).json({ error:'Choose a media file first.' });
  if (sourceFile.size > MAX_UPLOAD_MB * 1024 * 1024) { if(req.file)safeDelete(req.file.path); return res.status(413).json({error:'Upload exceeds the 250 MB video limit.'}); }
  let preflightInfo;
  const task=String(req.body.task||'convert'),outputFormat=String(req.body.format||'mp4').toLowerCase();
  try {
    validateMagic(sourceFile);
    preflightInfo = await probe(sourceFile.path);
    const streams = preflightInfo.streams || [];
    if (PHOTO_EXT.has(path.extname(sourceFile.originalname||'').toLowerCase())) throw new Error('Photo uploads must use Photo Studio.');
    const hasVideo = streams.some(x => x.codec_type === 'video');
    const hasAudio = streams.some(x => x.codec_type === 'audio');
    if (!hasVideo && !hasAudio) throw new Error('Unsupported media. Upload a valid video or audio file.');
    const duration = Number(preflightInfo.format?.duration || 0);
    if (hasVideo && duration > MAX_VIDEO_SECONDS) throw new Error(`Video exceeds the ${MAX_VIDEO_SECONDS >= 120 ? Math.floor(MAX_VIDEO_SECONDS / 60) + ' minute' : MAX_VIDEO_SECONDS + ' second'} limit.`);
    if (!hasVideo && (duration > MAX_AUDIO_SECONDS || sourceFile.size > MAX_AUDIO_MB * 1024 * 1024)) throw new Error('Audio must be 30 minutes or shorter and no larger than 50 MB.');
    if(!['convert','trim','resize','extract-audio','enhance-video','enhance-audio','normalize-audio','enhance-video-audio','visual-change'].includes(task))throw new Error('Unsupported processing task.');
    if(!hasVideo&&!['mp3','wav'].includes(outputFormat))throw new Error('Audio-only uploads must be exported as MP3 or WAV.');
    if(['resize','extract-audio','enhance-video','enhance-video-audio','visual-change'].includes(task)&&!hasVideo)throw new Error('This Video Studio task requires a video input.');
    if(task==='visual-change'&&!isLocalLook(req.body.visualStyle)&&!visualProviderName()&&fallbackLookFor(req.body.visualStyle))req.body.visualStyle=fallbackLookFor(req.body.visualStyle);
    if(task==='visual-change'&&isLocalLook(req.body.visualStyle)){if(outputFormat!=='mp4')throw new Error('Instant looks export MP4 only.');}
    else if(task==='visual-change'&&visualProviderName()==='free'){if(duration<1)throw new Error('AI Visual Change needs a clip of at least 1 second.');if(outputFormat!=='mp4')throw new Error('AI Visual Change currently exports MP4 only.');const fp=String(req.body.visualPrompt||'').trim();if(fp.length<8||fp.length>1500)throw new Error('Enter a visual transformation prompt between 8 and 1,500 characters.');}
    else if(task==='visual-change'){if(!process.env.RUNWAYML_API_SECRET){const error=new Error('AI Visual Change is not configured yet. Set HF_SPACE_URL (free) or RUNWAYML_API_SECRET (paid) in the hosting environment.');error.statusCode=503;throw error;}if(sourceFile.size>MAX_RUNWAY_INPUT_BYTES)throw new Error('AI Visual Change accepts videos up to 200 MB.');if(duration<2||duration>MAX_RUNWAY_DURATION_SECONDS)throw new Error('AI Visual Change accepts clips from 2 to 30 seconds. Trim the source to the supported duration and retry.');const visualStream=streams.find(x=>x.codec_type==='video');const parseRate=value=>{const parts=String(value||'').split('/').map(Number);return parts.length===2&&parts[1]>0?parts[0]/parts[1]:0;};const visualFps=parseRate(visualStream?.avg_frame_rate)||parseRate(visualStream?.r_frame_rate);const visualWidth=Number(visualStream?.width||0),visualHeight=Number(visualStream?.height||0),visualPixels=visualWidth*visualHeight;const supportedRunwayCodecs=new Set(['h264','hevc','av1','vp8','vp9','prores','mjpeg','mpeg2video','theora','flv1','msmpeg4v3']);if(!supportedRunwayCodecs.has(String(visualStream?.codec_name||'').toLowerCase()))throw new Error('AI Visual Change does not support this source video codec. Export it as H.264 MP4 and retry.');if(!Number.isFinite(visualFps)||visualFps<=0||visualFps>30.01)throw new Error('AI Visual Change requires footage at 30 FPS or lower. Convert the source frame rate and retry.');if(!visualPixels||Math.max(visualWidth,visualHeight)>1920||visualPixels>1920*1080)throw new Error('AI Visual Change currently accepts source footage up to 1080p. Use a 1080p or lower source clip.');if(outputFormat!=='mp4')throw new Error('AI Visual Change currently exports MP4 only.');if(String(req.body.visualPrompt||'').trim().length<8||String(req.body.visualPrompt||'').trim().length>1500)throw new Error('Enter a visual transformation prompt between 8 and 1,500 characters.');}
    if(['enhance-audio','normalize-audio'].includes(task)&&(hasVideo||!hasAudio))throw new Error('This Audio Studio task requires an audio-only input.');
    if(task==='extract-audio'&&!hasAudio)throw new Error('Audio Extractor requires a video with an audio track.');
    if(task==='enhance-video-audio'&&!hasAudio)throw new Error('Video Audio Enhance requires a video with an audio track.');
    if(['mp3','wav'].includes(outputFormat)&&!hasAudio)throw new Error('The selected output format requires an audio track.');
  } catch (e) { if(req.file)safeDelete(req.file.path); return res.status(e.statusCode || 400).json({error:e.message || 'Media validation failed.'}); }
  const resolution=String(req.body.resolution||'original').toLowerCase(),memoryMB=detectedMemoryLimitMB();
  if(resolution==='4k'&&memoryMB<1536){if(req.file)safeDelete(req.file.path);return res.status(503).json({error:`4K rendering requires at least 1.5 GB of detected memory. This server currently exposes about ${memoryMB} MB; use 1080p/2K or a larger processing worker.`});}
  if(resolution==='8k'&&memoryMB<4096){if(req.file)safeDelete(req.file.path);return res.status(503).json({error:`8K rendering requires at least 4 GB of detected memory. This server currently exposes about ${memoryMB} MB; use a larger processing worker.`});}
  const id = crypto.randomUUID();
  const ext = OUTPUTS[String(req.body.format || 'mp4').toLowerCase()]?.ext;
  if (!ext) { if(req.file)safeDelete(req.file.path); return res.status(400).json({ error:'Unsupported output format.' }); }
  const output = path.join(OUT_DIR, `${id}${ext}`);
  const activeJob=[...jobs.values()].find(j=>j.ownerId===currentUserId(req)&&j.status==='processing');
  if(activeJob){if(req.file)safeDelete(req.file.path);return res.status(409).json({error:'You already have a media job processing. Wait for it to finish or cancel it before starting another.',activeJobId:activeJob.id});}
  const estimate=estimateProcessing(sourceFile,preflightInfo,req.body);
  if(storedUploadId)uploads.delete(storedUploadId);
  const job = { id, ownerId:currentUserId(req), status:'processing', progress:0, estimateSeconds:estimate.seconds, estimateBasis:estimate.basis, originalName:sourceFile.originalname, input:sourceFile.path, child:null, cancelRequested:false, createdAt:Date.now(), output:null, error:null };
  jobs.set(id, job);
  res.status(202).json({ id, status:job.status, estimateSeconds:job.estimateSeconds, estimateBasis:job.estimateBasis });
  (async () => {
    try {
      const info = preflightInfo;
      const mediaHasVideo = (info.streams || []).some(x => x.codec_type === 'video');
      const mediaHasAudio = (info.streams || []).some(x => x.codec_type === 'audio');
      if (!mediaHasVideo && !mediaHasAudio) throw new Error('Unsupported or invalid media stream.');
      const mediaDuration = Number(info.format?.duration || 0);
      if (mediaHasVideo && mediaDuration > MAX_VIDEO_SECONDS) throw new Error('Video exceeds the allowed duration limit.');
      if (!mediaHasVideo && mediaDuration > MAX_AUDIO_SECONDS) throw new Error('Audio exceeds the 30 minute limit.');
      let autoEditInfo = null;
      const useVideoEnhanceAI = task === 'enhance-video' && gradioConfigured('VENH') && String(req.body.autoSmartCut) !== 'true' && String(req.body.format || 'mp4').toLowerCase() === 'mp4';
      let skipAudioRestore = false;
      if ((task === 'visual-change' && !isLocalLook(req.body.visualStyle)) || useVideoEnhanceAI) {
        if (useVideoEnhanceAI || visualProviderName() === 'free') {
          // Free GPUs are small: send a short, 480p, silent copy. The original audio is restored afterwards.
          const preparedInput = path.join(OUT_DIR, `${id}.free-input.mp4`);
          try {
            await run(FFMPEG, ['-hide_banner','-loglevel','error','-y','-i',sourceFile.path,'-t',String(FREE_MAX_SECONDS),'-an','-vf','scale=-2:min(480\\,ih)','-c:v','libx264','-preset','veryfast','-crf','24','-pix_fmt','yuv420p','-movflags','+faststart',preparedInput], 180000, null, 0, child => { job.child=child; });
            try {
              job.visualChangeInfo = await transformWithGradio({
                prefix: useVideoEnhanceAI ? 'VENH' : 'HF', mime: 'video/mp4', label: useVideoEnhanceAI ? 'free video enhance server' : 'free AI server',
                inputPath: preparedInput, outputPath: output, prompt: useVideoEnhanceAI ? '' : String(req.body.visualPrompt || ''),
                onProgress: (p, label) => { job.progress=p; job.progressLabel=label; },
                isCancelled: () => job.cancelRequested
              });
              job.visualChangeInfo.reason = `Free mode: the first ${Math.min(FREE_MAX_SECONDS, Math.floor(mediaDuration))} seconds were transformed at up to 480p.`;
            } catch (aiError) {
              // The free Space can be asleep, queued or out of GPU quota. Fall back to the built-in FFmpeg pipeline.
              safeDelete(output);
              const fallbackStyle = useVideoEnhanceAI ? null : fallbackLookFor(req.body.visualStyle);
              if (job.cancelRequested || (!useVideoEnhanceAI && !fallbackStyle)) throw aiError;
              console.warn('[Vidora AI] Free AI server failed; using built-in FFmpeg pipeline:', aiError.message);
              job.progressLabel = 'Free AI server is busy. Applying the built-in look instead';
              const fallbackBody = { ...req.body, task: useVideoEnhanceAI ? 'enhance-video' : 'visual-change', visualStyle: fallbackStyle || req.body.visualStyle };
              await run(FFMPEG, buildArgs(sourceFile.path, output, fallbackBody, info), 30*60*1000, p => { job.progress=p; }, mediaDuration, child => { job.child=child; });
              job.visualChangeInfo = { provider: 'Built-in FFmpeg pipeline (free AI server unavailable)', reason: `The free AI server was unavailable (${String(aiError.message).slice(0, 160)}). The full video was processed with the built-in ${fallbackStyle || 'enhance'} pipeline instead.` };
              skipAudioRestore = true;
            }
          } finally { safeDelete(preparedInput); }
        } else {
        job.visualChangeInfo = await transformVideoWithRunway({
          inputPath: sourceFile.path, outputPath: output, prompt: String(req.body.visualPrompt || ''),
          apiKey: process.env.RUNWAYML_API_SECRET,
          onProgress: (p, label) => { job.progress=p; job.progressLabel=label; },
          isCancelled: () => job.cancelRequested,
          onTaskId: taskId => { job.remoteTaskId=taskId; }
        });
        }
        // Visual Change alters pixels only. Restore the exact source audio track after AI video generation.
        if (skipAudioRestore) {
          job.visualChangeInfo.audioTrack = 'Audio was processed together with the video.';
        } else if (mediaHasAudio) {
          const audioPreservedOutput = path.join(OUT_DIR, `${id}.audio-preserved.mp4`);
          try {
            await run(FFMPEG, ['-hide_banner','-loglevel','error','-y','-i',output,'-i',sourceFile.path,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-shortest','-movflags','+faststart',audioPreservedOutput], 180000, p => { job.progress=Math.max(job.progress,96); }, mediaDuration, child => { job.child=child; });
            fs.renameSync(audioPreservedOutput, output);
          } finally { safeDelete(audioPreservedOutput); }
          job.visualChangeInfo.audioTrack = 'Original source audio restored and synchronized to the transformed video.';
        } else {
          job.visualChangeInfo.audioTrack = 'Source video had no audio track.';
        }
      } else {
        if (String(req.body.autoSmartCut) === 'true' && String(req.body.format || 'mp4').toLowerCase() === 'mp4' && String(req.body.task || '') === 'enhance-video') {
          autoEditInfo = await renderAutoEdit(sourceFile.path, output, info, req.body, p => { job.progress=p; }, child => { job.child=child; });
        }
        if (!autoEditInfo || !autoEditInfo.smartCutApplied) {
          const args = buildArgs(sourceFile.path, output, req.body, info);
          await run(FFMPEG, args, 30*60*1000, p => { job.progress=p; }, mediaDuration, child => { job.child=child; });
        }
      }
      if(job.cancelRequested) throw new Error('Job cancelled by the user.');
      const outputInfo = await probe(output);
      if (mediaHasVideo && !(outputInfo.streams || []).some(x => x.codec_type === 'video')) throw new Error('The processing pipeline returned an output without a valid video stream.');
      if (!mediaHasVideo && !(outputInfo.streams || []).some(x => x.codec_type === 'audio')) throw new Error('The processing pipeline returned an output without a valid audio stream.');
      job.progress=100; job.status = 'completed'; job.output = output;
      job.autoEditInfo = autoEditInfo || job.visualChangeInfo || null;
      job.outputName = `${path.basename(sourceFile.originalname, path.extname(sourceFile.originalname)).replace(/[^a-z0-9_-]/gi,'_') || 'vidora-export'}${ext}`;
      const outputVideo = (outputInfo.streams || []).find(x => x.codec_type === 'video');
      const outputAudio = (outputInfo.streams || []).find(x => x.codec_type === 'audio');
      job.metadata = {
        duration:Number(info.format?.duration || 0),
        inputFormat:info.format?.format_name || path.extname(sourceFile.originalname).slice(1).toLowerCase() || 'unavailable',
        outputFormat:outputInfo.format?.format_name || ext.slice(1),
        outputDuration:Number(outputInfo.format?.duration || 0),
        outputWidth:Number(outputVideo?.width || 0), outputHeight:Number(outputVideo?.height || 0),
        outputVideoCodec:outputVideo?.codec_name || 'none', outputAudioCodec:outputAudio?.codec_name || 'none',
        outputHasAudio:Boolean(outputAudio)
      };
    } catch (e) { job.status=job.cancelRequested?'cancelled':'failed'; job.error = job.cancelRequested?'Job cancelled by the user.':e.message; safeDelete(output); }
    finally { job.child=null; job.input=null; safeDelete(sourceFile.path); }
  })();
});
app.get('/api/jobs/:id', requireSession, (req,res) => {
  const j = jobs.get(req.params.id); if (j && j.ownerId !== currentUserId(req)) return res.status(404).json({ error:'Job not found or expired.' }); if (!j) return res.status(404).json({ error:'Job not found or expired.' });
  res.json({ id:j.id, status:j.status, progress:Number(j.progress||0), estimateSeconds:j.estimateSeconds, estimateBasis:j.estimateBasis, error:j.error, progressLabel:j.progressLabel || null, outputName:j.outputName, metadata:j.metadata, autoEditInfo:j.autoEditInfo || null });
});
app.post('/api/jobs/:id/cancel', requireSession, (req,res) => {
  const job=jobs.get(req.params.id);
  if(!job||job.ownerId!==currentUserId(req))return res.status(404).json({error:'Job not found.'});
  if(job.status!=='processing')return res.json({ok:true,status:job.status});
  job.cancelRequested=true;
  if(job.child){job.child.kill('SIGTERM');const child=job.child;setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},3000).unref();}
  if(job.remoteTaskId)cancelRunwayTask(process.env.RUNWAYML_API_SECRET,job.remoteTaskId).catch(()=>{});
  else if(!job.child){safeDelete(job.input);}
  res.json({ok:true,status:'cancelling'});
});
app.get('/api/jobs/:id/download', requireSession, (req,res) => {
  const j = jobs.get(req.params.id); if (j && j.ownerId !== currentUserId(req)) return res.status(404).json({ error:'Export is not ready or has expired.' }); if (!j || j.status !== 'completed' || !j.output || !fs.existsSync(j.output)) return res.status(404).json({ error:'Export is not ready or has expired.' });
  res.download(j.output, j.outputName);
});
app.delete('/api/jobs/:id', requireSession, (req,res) => {
  const j = jobs.get(req.params.id); if (j && j.ownerId !== currentUserId(req)) return res.status(404).json({ error:'Job not found.' }); if (!j) return res.status(404).json({ error:'Job not found.' });
  if(j.status==='processing'){j.cancelRequested=true;if(j.child){const child=j.child;child.kill('SIGTERM');setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},3000).unref();}if(j.remoteTaskId)cancelRunwayTask(process.env.RUNWAYML_API_SECRET,j.remoteTaskId).catch(()=>{});else safeDelete(j.input);}
  safeDelete(j.output); jobs.delete(j.id); res.json({ ok:true });
});
setInterval(() => {
  const cutoff = Date.now() - RETENTION_HOURS * 3600_000;
  for (const [id,item] of uploads) if(item.createdAt<cutoff) removeUpload(id);
  for (const [id,j] of jobs) if (j.createdAt < cutoff && j.status !== 'processing') { safeDelete(j.output); jobs.delete(id); }
  const activePaths=new Set([...uploads.values()].map(x=>x.path));for(const j of jobs.values())if(j.status==='processing'){if(j.input)activePaths.add(j.input);if(j.output)activePaths.add(j.output);}
  for(const dir of [IN_DIR,OUT_DIR])fs.readdir(dir,{withFileTypes:true},(err,entries)=>{if(err)return;for(const entry of entries){if(!entry.isFile())continue;const file=path.join(dir,entry.name);if(activePaths.has(file))continue;fs.stat(file,(statErr,st)=>{if(!statErr&&st.mtimeMs<cutoff)safeDelete(file);});}});
}, 10 * 60_000).unref();
app.use((err,_req,res,_next) => {
  const status = err instanceof multer.MulterError ? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400) : (err.statusCode || (err.name === 'Error' && /extension|accepts|only/i.test(err.message || '') ? 400 : 500));
  const message = status >= 500 ? 'The request could not be completed. Please retry or contact Help with the request time.' : (err.message || 'Upload failed.');
  if (status >= 500) console.error('[Vidora request error]', err);
  res.status(status).json({ error: message });
});
authReady.then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Vidora AI running on port ${PORT}`);
  });
}).catch(error => {
  console.error('[Vidora] Accounts database initialization failed:', error.message);
  process.exit(1);
});
