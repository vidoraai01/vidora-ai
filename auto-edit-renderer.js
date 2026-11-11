'use strict';

function visualStyleFilters(style) {
  const presets = {
    cinematic: ['eq=contrast=1.12:saturation=1.08:gamma=0.98', 'vignette=PI/5'],
    noir: ['hue=s=0', 'eq=contrast=1.22:brightness=-0.01'],
    vintage: ['colorbalance=rs=0.05:gs=0.01:bs=-0.04', 'eq=saturation=0.82:contrast=1.04'],
    warm: ['colorbalance=rs=0.08:gs=0.02:bs=-0.06'],
    cool: ['colorbalance=rs=-0.04:gs=0.01:bs=0.07'],
    natural: []
  };
  const key = String(style || 'natural').toLowerCase();
  return presets[key] ? [...presets[key]] : [];
}

function createAutoEditRenderer({ FFMPEG, detectLongSilences, run }) {
  async function renderAutoEdit(input, output, info, body = {}, onProgress = null, onSpawn = null) {
    const video=(info.streams||[]).find(s=>s.codec_type==='video');
    const audio=(info.streams||[]).find(s=>s.codec_type==='audio');
    const duration=Math.max(0,Number(info.format?.duration||0));
    if(!video||!audio||!duration) return {smartCutApplied:false,removedSeconds:0,reason:'Automatic pause trimming requires a video with an audio track; standard enhancement was used.'};
    let silences=[];
    try { silences=await detectLongSilences(input,duration); }
    catch(e) { return {smartCutApplied:false,removedSeconds:0,reason:'Silence detection was unavailable; standard enhancement was used.'}; }
    const silenceCuts=[];
    for(const silence of silences){
      const a=Math.min(silence.end,silence.start+0.15), b=Math.max(a,silence.end-0.15);
      if(b-a>=1.9) silenceCuts.push({start:a,end:b,source:'silence'});
    }
    let aiCuts=[];
    try {
      const proposed=JSON.parse(String(body.recommendedCuts||'[]'));
      if(Array.isArray(proposed)) aiCuts=proposed.slice(0,10).map(c=>{
        const start=Number(c.startSeconds),end=Number(c.endSeconds),confidence=Number(c.confidence);
        if(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(confidence)||confidence<0.65||end-start<0.6)return null;
        return {start:Math.max(0,start+0.12),end:Math.min(duration,end-0.12),source:'ai'};
      }).filter(c=>c&&c.end-c.start>=0.36);
    } catch { aiCuts=[]; }
    let cuts=[...silenceCuts,...aiCuts].sort((a,b)=>a.start-b.start);
    const merged=[];
    for(const cut of cuts){const last=merged[merged.length-1];if(last&&cut.start<=last.end){last.end=Math.max(last.end,cut.end);last.source=last.source==='ai'||cut.source==='ai'?'ai+silence':'silence';}else merged.push({...cut});}
    const proposedRemoved=merged.reduce((sum,c)=>sum+c.end-c.start,0);
    if(proposedRemoved>duration*0.35) cuts=silenceCuts; else cuts=merged;
    if(!cuts.length) return {smartCutApplied:false,removedSeconds:0,reason:'No sufficiently confident long-pause or AI-recommended removal was safe to apply; original pacing was preserved.',aiCutCount:0};
    const keep=[]; let cursor=0;
    for(const c of cuts){ if(c.start-cursor>=0.35) keep.push({start:cursor,end:c.start}); cursor=Math.max(cursor,c.end); }
    if(duration-cursor>=0.35) keep.push({start:cursor,end:duration});
    if(keep.length<2) return {smartCutApplied:false,removedSeconds:0,reason:'Pause trimming was skipped to avoid an excessively short export.'};
    const clamp=(value,min,max,fallback=0)=>{const n=Number(value);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;};
    const vf=[];
    const sharp=clamp(body.enhanceSharpness,0,2), denoise=clamp(body.enhanceDenoise,0,3);
    const brightness=clamp(body.enhanceBrightness,-0.2,0.2), contrast=clamp(body.enhanceContrast,0.5,1.5,1), saturation=clamp(body.enhanceSaturation,0,2,1);
    if(denoise>0) vf.push(`hqdn3d=${denoise.toFixed(2)}:${denoise.toFixed(2)}:${(denoise*1.5).toFixed(2)}:${(denoise*1.5).toFixed(2)}`);
    if(sharp>0) vf.push(`unsharp=5:5:${sharp.toFixed(2)}:5:5:0`);
    if(brightness!==0||contrast!==1||saturation!==1) vf.push(`eq=brightness=${brightness.toFixed(3)}:contrast=${contrast.toFixed(2)}:saturation=${saturation.toFixed(2)}`);
    vf.push(...visualStyleFilters(body.visualStyle));
    const resolution=String(body.resolution||'original').toLowerCase();
    if(['8k','4k','2k','1080p','720p','480p'].includes(resolution)){const h=({ '8k':4320,'4k':2160,'2k':1440 })[resolution] || Number(resolution.slice(0,-1));vf.push(`scale=-2:${h}:flags=lanczos`);}
    const af=[];
    if(String(body.aiAudioNoEnhancementNeeded)!=='true'){
      const gain=clamp(body.audioGainDb,-6,6), audioDenoise=clamp(body.audioDenoise,0,6);
      if(gain!==0) af.push(`volume=${gain.toFixed(2)}dB`);
      if(audioDenoise>0) af.push(`afftdn=nr=${audioDenoise.toFixed(1)}`);
      if(String(body.audioLimiter)==='true') af.push('alimiter=limit=0.95');
    }
    const graph=[];
    keep.forEach((seg,i)=>{
      graph.push(`[0:v:0]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS${vf.length?','+vf.join(','):''}[v${i}]`);
      graph.push(`[0:a:0]atrim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asetpts=PTS-STARTPTS${af.length?','+af.join(','):''}[a${i}]`);
    });
    graph.push(keep.map((_,i)=>`[v${i}][a${i}]`).join('')+`concat=n=${keep.length}:v=1:a=1[v][a]`);
    const args=['-hide_banner','-loglevel','error','-y','-i',input,'-filter_complex',graph.join(';'),'-map','[v]','-map','[a]','-c:v','libx264','-preset','medium','-crf','23','-c:a','aac','-b:a','192k','-movflags','+faststart','-progress','pipe:2','-nostats',output];
    await run(FFMPEG,args,30*60*1000,onProgress,Number(info.format?.duration||0),onSpawn);
    return {smartCutApplied:true,removedSeconds:Number(cuts.reduce((sum,c)=>sum+c.end-c.start,0).toFixed(2)),aiCutCount:cuts.filter(c=>c.source==='ai'||c.source==='ai+silence').length,reason:`Applied ${cuts.filter(c=>c.source==='ai'||c.source==='ai+silence').length} confidence-gated AI cut(s) and ${cuts.filter(c=>c.source==='silence'||c.source==='ai+silence').length} long-silence cut(s), preserving short boundary handles. Original content outside selected cuts was retained.`};
  }

  return renderAutoEdit;
}

module.exports = { visualStyleFilters, createAutoEditRenderer };
