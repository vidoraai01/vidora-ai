'use strict';
// Public share links for finished results. Files are stored in Postgres (so links survive Render restarts),
// are capped in size, expire automatically and can be deleted by their owner at any time.
const crypto = require('node:crypto');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vidora_shares(token VARCHAR(32) PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES vidora_users(id) ON DELETE CASCADE,mime VARCHAR(40) NOT NULL,name VARCHAR(80) NOT NULL,size INTEGER NOT NULL,data BYTEA NOT NULL,views INTEGER NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),expires_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS vidora_shares_user_idx ON vidora_shares(user_id);
CREATE INDEX IF NOT EXISTS vidora_shares_exp_idx ON vidora_shares(expires_at);`;

// Never trust the browser's content-type: detect the real type from the first bytes.
function sniff(buf) {
  if (buf.length < 12) return null;
  const hex = buf.subarray(0, 4).toString('hex'), ascii = buf.subarray(0, 12).toString('latin1');
  if (hex === '89504e47') return { mime: 'image/png', ext: 'png', kind: 'image' };
  if (hex.startsWith('ffd8ff')) return { mime: 'image/jpeg', ext: 'jpg', kind: 'image' };
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp', kind: 'image' };
  if (ascii.slice(4, 8) === 'ftyp') return { mime: 'video/mp4', ext: 'mp4', kind: 'video' };
  if (hex === '1a45dfa3') return { mime: 'video/webm', ext: 'webm', kind: 'video' };
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return { mime: 'audio/wav', ext: 'wav', kind: 'audio' };
  if (ascii.startsWith('ID3') || hex.startsWith('fffb') || hex.startsWith('fff3') || hex.startsWith('fff2')) return { mime: 'audio/mpeg', ext: 'mp3', kind: 'audio' };
  return null;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const validToken = t => /^[A-Za-z0-9_-]{22}$/.test(String(t || ''));

function setupShare(app, pool, { user, admin, origin, track, baseUrl }) {
  const express = require('express'), rateLimit = require('express-rate-limit');
  const MAX_BYTES = Math.max(1, Math.min(25, Number(process.env.SHARE_MAX_MB) || 12)) * 1024 * 1024;
  const TOTAL_BYTES = Math.max(20, Math.min(400, Number(process.env.SHARE_TOTAL_MB) || 200)) * 1024 * 1024;
  const DAYS = Math.max(1, Math.min(14, Number(process.env.SHARE_DAYS) || 3));
  const PER_USER = 20;
  const make = rateLimit({ windowMs: 10 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false });
  const view = rateLimit({ windowMs: 60 * 1000, limit: 90, standardHeaders: true, legacyHeaders: false });
  const read = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const absolute = req => { const b = baseUrl(); return (b ? b.replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`); };

  app.post('/api/share', user, make, origin, express.raw({ type: () => true, limit: MAX_BYTES + 1024 }), async (req, res, next) => {
    try {
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!buf.length) return res.status(400).json({ error: 'Share karne ke liye file nahi mili.' });
      if (buf.length > MAX_BYTES) return res.status(413).json({ error: `Share link ke liye file ${Math.round(MAX_BYTES / 1048576)} MB se chhoti honi chahiye.` });
      const type = sniff(buf);
      if (!type) return res.status(415).json({ error: 'Sirf photo, video ya audio share ho sakti hai.' });
      const uid = req.session.account.id;
      const stat = (await pool.query('SELECT count(*) FILTER (WHERE user_id=$1 AND expires_at>NOW()) AS mine, COALESCE(sum(size) FILTER (WHERE expires_at>NOW()),0) AS total FROM vidora_shares', [uid])).rows[0];
      if (Number(stat.mine) >= PER_USER) return res.status(429).json({ error: `Aapke ${PER_USER} active links ho chuke hain. Purana link delete karo.` });
      if (Number(stat.total) + buf.length > TOTAL_BYTES) return res.status(507).json({ error: 'Share storage abhi full hai. Thodi der baad try karo.' });
      const name = (String(req.get('x-name') || 'vidora-result').replace(/[^\w .()-]/g, '').slice(0, 60) || 'vidora-result').replace(/\.[A-Za-z0-9]{1,5}$/, '') + '.' + type.ext;
      const token = crypto.randomBytes(16).toString('base64url');
      await pool.query("INSERT INTO vidora_shares(token,user_id,mime,name,size,data,expires_at) VALUES($1,$2,$3,$4,$5,$6,NOW()+make_interval(days=>$7::int))", [token, uid, type.mime, name, buf.length, buf, DAYS]);
      track('share', { userId: uid, status: 'ok', tool: type.kind, bytes: buf.length });
      res.status(201).json({ token, url: `${absolute(req)}/s/${token}`, days: DAYS, name, size: buf.length });
    } catch (e) { next(e); }
  });
  app.get('/api/share/mine', read, user, async (req, res, next) => {
    try { const q = await pool.query('SELECT token,name,mime,size,views,created_at,expires_at FROM vidora_shares WHERE user_id=$1 AND expires_at>NOW() ORDER BY created_at DESC LIMIT 50', [req.session.account.id]); res.set('Cache-Control', 'no-store').json({ shares: q.rows.map(r => ({ ...r, url: `${absolute(req)}/s/${r.token}` })) }); } catch (e) { next(e); }
  });
  app.delete('/api/share/:token', user, origin, async (req, res, next) => {
    try {
      if (!validToken(req.params.token)) return res.status(400).json({ error: 'Invalid link.' });
      const isAdmin = req.session.account.role === 'admin';
      const q = await pool.query(isAdmin ? 'DELETE FROM vidora_shares WHERE token=$1 RETURNING token' : 'DELETE FROM vidora_shares WHERE token=$1 AND user_id=$2 RETURNING token', isAdmin ? [req.params.token] : [req.params.token, req.session.account.id]);
      if (!q.rowCount) return res.status(404).json({ error: 'Link nahi mila.' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  const find = async (token, withData) => {
    if (!validToken(token)) return null;
    const q = await pool.query(`SELECT token,mime,name,size,${withData ? 'data,' : ''}expires_at FROM vidora_shares WHERE token=$1 AND expires_at>NOW()`, [token]);
    return q.rows[0] || null;
  };

  app.get('/s/:token', view, async (req, res, next) => {
    try {
      const r = await find(req.params.token, false);
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      if (!r) return res.status(404).type('html').send(page({ title: 'Link expire ho gaya', body: '<p class="muted">Ye share link expire ho gaya ya delete ho chuka hai.</p>', cta: true }));
      pool.query('UPDATE vidora_shares SET views=views+1 WHERE token=$1', [r.token]).catch(() => {});
      const file = `/s/${r.token}/file`, kind = r.mime.split('/')[0];
      const media = kind === 'image' ? `<img class="media" src="${file}" alt="${esc(r.name)}">` : kind === 'video' ? `<video class="media" src="${file}" controls playsinline preload="metadata"></video>` : `<audio class="media" src="${file}" controls preload="metadata"></audio>`;
      const days = Math.max(0, Math.ceil((new Date(r.expires_at) - Date.now()) / 86400000));
      const og = kind === 'image' ? `<meta property="og:image" content="${esc(absolute(req) + file)}">` : '';
      res.type('html').send(page({ title: 'Vidora AI par bana', og, body: `${media}<a class="primary-btn dl" href="${file}?dl=1" download="${esc(r.name)}">Download ↓</a><p class="muted">Ye link ${days} din me expire ho jayega.</p>`, cta: true }));
    } catch (e) { next(e); }
  });

  app.get('/s/:token/file', view, async (req, res, next) => {
    try {
      const r = await find(req.params.token, true);
      if (!r) return res.status(404).json({ error: 'Link expire ho gaya.' });
      const data = r.data, total = data.length;
      res.set({ 'Content-Type': r.mime, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'private, max-age=300', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Disposition': `${req.query.dl ? 'attachment' : 'inline'}; filename="${r.name.replace(/"/g, '')}"` });
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.get('range') || '');
      if (m && (m[1] || m[2])) {
        let start = m[1] === '' ? Math.max(0, total - Number(m[2])) : Number(m[1]), end = m[1] === '' || m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
        if (start > end || start >= total) return res.status(416).set('Content-Range', `bytes */${total}`).end();
        return res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(end - start + 1) }).end(data.subarray(start, end + 1));
      }
      res.set('Content-Length', String(total)).end(data);
    } catch (e) { next(e); }
  });

  const prune = () => pool.query('DELETE FROM vidora_shares WHERE expires_at<NOW()').catch(() => {});
  setTimeout(prune, 90 * 1000).unref(); setInterval(prune, 3600 * 1000).unref();
}

function page({ title, body, og = '', cta }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#07111f"><title>${esc(title)} · Vidora AI</title><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="Vidora AI se bana photo/video."><meta property="og:type" content="website">${og}<link rel="stylesheet" href="/assets/app.css"><link rel="stylesheet" href="/assets/share.css"></head><body class="share-body"><main class="share-card"><a class="brand" href="/"><span class="brand-mark">V</span><span>VIDORA<span class="brand-ai">AI</span></span></a>${body}${cta ? '<a class="outline-btn" href="/">Khud try karo →</a>' : ''}</main></body></html>`;
}

module.exports = { SCHEMA, setupShare, sniff };
