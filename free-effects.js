'use strict';
// Free, GPU-less "advanced" effects built only on FFmpeg filters. They run on any server, instantly,
// with no quota and no third-party upload, and are used (a) as the default enhance pipeline and
// (b) as "instant looks" / fallback when a free AI Space is busy or not configured.

const clamp = (value, min, max, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

// Smart enhance chain: denoise -> deband -> auto-levels -> adaptive sharpen -> colour.
function enhanceVideoFilters({ sharpness = 0, denoise = 0, brightness = 0, contrast = 1, saturation = 1, lowResource = false } = {}) {
  const f = [];
  const s = clamp(sharpness, 0, 2), d = clamp(denoise, 0, 3);
  if (d > 0) f.push(`hqdn3d=${d.toFixed(2)}:${d.toFixed(2)}:${(d * 1.5).toFixed(2)}:${(d * 1.5).toFixed(2)}`);
  if (!lowResource && (s > 0 || d > 0)) {
    f.push('deband=1thr=0.02:2thr=0.02:3thr=0.02:range=16:blur=1');
    f.push('normalize=blackpt=black:whitept=white:smoothing=24:strength=0.55');
  }
  if (s > 0) {
    f.push(`unsharp=5:5:${Math.min(1.5, s).toFixed(2)}:5:5:0`);
    f.push(`cas=strength=${Math.min(0.8, s * 0.45).toFixed(2)}`);
  }
  const b = clamp(brightness, -0.2, 0.2), c = clamp(contrast, 0.5, 1.5, 1), sat = clamp(saturation, 0, 2, 1);
  if (b !== 0 || c !== 1 || sat !== 1) f.push(`eq=brightness=${b.toFixed(3)}:contrast=${c.toFixed(2)}:saturation=${sat.toFixed(2)}`);
  if (s > 0 && !lowResource) f.push('vibrance=intensity=0.25');
  return f;
}

// Voice clean-up chain: remove rumble, denoise, even out loudness, normalise.
function voiceCleanFilters(noiseReduction = 10) {
  const nr = clamp(noiseReduction, 0, 20, 10);
  return [
    'highpass=f=70',
    `afftdn=nr=${nr.toFixed(0)}:nf=-45`,
    'acompressor=threshold=0.089:ratio=3:attack=20:release=250:makeup=1.5',
    'loudnorm=I=-16:TP=-1.5:LRA=11'
  ];
}

// Instant looks. Every entry is a plain single-chain ffmpeg filter list (works on the full video).
const LOOKS = {
  'look-cartoon': {
    label: 'Cartoon',
    filters: ['smartblur=lr=2.5:ls=1.0:lt=12', "lutyuv=y='floor(val/28)*28+14'", 'eq=saturation=1.6:contrast=1.12', 'unsharp=5:5:0.8:5:5:0']
  },
  'look-anime': {
    label: 'Anime style',
    filters: ['smartblur=lr=2:ls=0.8:lt=8', "lutyuv=y='floor(val/20)*20+10'", 'eq=saturation=1.45:contrast=1.1:brightness=0.03', 'colorbalance=rs=0.03:bs=0.05:rh=0.04', 'unsharp=5:5:0.9:5:5:0']
  },
  'look-sketch': {
    label: 'Pencil sketch',
    filters: ['format=gray', 'edgedetect=low=0.06:high=0.2:mode=colormix', 'negate', 'eq=contrast=1.2']
  },
  'look-cyberpunk': {
    label: 'Cyberpunk neon',
    filters: ['colorbalance=rs=0.18:gs=-0.1:bs=0.3:rm=0.12:bm=0.22:rh=0.1:bh=0.15', 'eq=contrast=1.22:saturation=1.7:gamma=0.95', 'noise=alls=6:allf=t', 'vignette=PI/4']
  },
  'look-tealorange': {
    label: 'Teal & orange movie',
    filters: ['colorbalance=rs=-0.12:gs=-0.02:bs=0.14:rh=0.14:gh=0.03:bh=-0.12', 'eq=contrast=1.12:saturation=1.18', 'vignette=PI/6']
  },
  'look-dreamy': {
    label: 'Dreamy soft glow',
    filters: ['eq=brightness=0.05:saturation=1.25:contrast=0.95', 'gblur=sigma=1.4', 'colorbalance=rs=0.05:bs=0.04']
  },
  'look-retro': {
    label: 'Retro VHS',
    filters: ['noise=alls=16:allf=t+u', 'eq=saturation=0.85:contrast=1.08', 'colorbalance=rs=0.06:bs=-0.05', 'chromashift=crh=3:cbh=-3', 'vignette=PI/4.5']
  },
  'look-sepia': {
    label: 'Old sepia film',
    filters: ['colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131', 'noise=alls=8:allf=t', 'vignette=PI/4']
  },
  'look-noir': {
    label: 'Black & white noir',
    filters: ['hue=s=0', 'eq=contrast=1.3:brightness=-0.02', 'vignette=PI/4']
  }
};

// When the free AI model is unavailable, map the AI preset to the closest local look.
const AI_FALLBACK = { anime: 'look-anime', cinematic: 'look-tealorange', cyberpunk: 'look-cyberpunk', 'day-night': 'look-noir', weather: 'look-dreamy' };

const isLocalLook = style => Object.prototype.hasOwnProperty.call(LOOKS, String(style || ''));
const lookFilters = style => (isLocalLook(style) ? [...LOOKS[style].filters] : []);
const fallbackLookFor = style => AI_FALLBACK[String(style || '')] || null;

module.exports = { enhanceVideoFilters, voiceCleanFilters, LOOKS, isLocalLook, lookFilters, fallbackLookFor };
