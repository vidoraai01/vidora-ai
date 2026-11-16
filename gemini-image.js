'use strict';
// Gemini image editing over plain HTTPS (REST). One image in + a text instruction -> one image out.
// Used for "AI Enhance" and the 2D/3D cartoon tool. Every failure throws, callers fall back to FFmpeg.
const fs = require('node:fs');

const PROMPTS = {
  enhance: 'Enhance this photo like a professional photo-enhancer app: increase sharpness and fine detail, remove noise and blur, fix exposure, contrast and colours, and make faces clear and natural. Keep the SAME person, face, pose, composition, background and aspect ratio. Do not add, remove or change any object. Output only the enhanced photo.',
  cartoon2d: 'Redraw this photo as a polished 2D cartoon illustration: clean bold outlines, flat bright colours with simple cel shading. Keep the same people, faces (recognisable), pose, composition, background and aspect ratio. Output only the image.',
  cartoon3d: 'Redraw this photo as a 3D animated-movie character render (Pixar-style): smooth soft skin, big expressive eyes, soft studio lighting, rich colours and gentle depth. Keep the same people, faces (recognisable), pose, composition, background and aspect ratio. Output only the image.'
};

const MODEL = () => process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

async function geminiImage({ apiKey = process.env.GEMINI_API_KEY, imagePath, mime = 'image/png', prompt, model = MODEL(), timeoutMs = 90000, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set.');
  const body = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: fs.readFileSync(imagePath).toString('base64') } }] }], generationConfig: { responseModalities: ['IMAGE'] } };
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini image error ${res.status}: ${String(json?.error?.message || 'request failed').slice(0, 200)}`);
  const parts = (json.candidates || []).flatMap(c => c?.content?.parts || []);
  const img = parts.find(p => (p.inlineData || p.inline_data)?.data);
  if (!img) throw new Error('Gemini returned no image (it may have blocked this photo).');
  const d = img.inlineData || img.inline_data;
  return Buffer.from(d.data, 'base64');
}

module.exports = { geminiImage, PROMPTS };
