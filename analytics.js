'use strict';
// Owner dashboard: event log (sign-ups, sign-ins, uploads, tool runs, failures) + admin-only API.
// Privacy: no IP addresses, no file names, no passwords and no e-mail of failed sign-ins are stored.
const path = require('node:path');

const EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS vidora_events(id BIGSERIAL PRIMARY KEY,user_id BIGINT,kind VARCHAR(24) NOT NULL,tool VARCHAR(48),status VARCHAR(16),detail VARCHAR(300),bytes BIGINT,ms INTEGER,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS vidora_events_created_idx ON vidora_events(created_at DESC);
CREATE INDEX IF NOT EXISTS vidora_events_user_idx ON vidora_events(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS vidora_events_kind_idx ON vidora_events(kind,created_at DESC);`;

const NOT_ADMIN = '(e.user_id IS NULL OR e.user_id <> COALESCE($2::bigint,-1))';

// Plain-language reason + suggested fix for the most common failure messages (owner-facing, Hinglish).
function explainError(message) {
  const m = String(message || '');
  const rules = [
    [/already have a media job/i, 'User ne ek job chalte hue dusri job shuru kar di.', 'Kuch karne ki zaroorat nahi. User ko pehla job khatam ya cancel karne ko bolo.'],
    [/cancel/i, 'User ne khud job cancel kiya.', 'Koi dikkat nahi.'],
    [/not configured|SPACE_URL|API_SECRET|needs .*_SPACE_URL/i, 'Is feature ka AI model/setting Render me jura nahi hai.', 'Render Environment me HF_*/PHOTO_*/VENH_* variables jodo, ya user ko "Instant look" use karne ko bolo.'],
    [/free (ai|photo|video)[^.]* (server|space)|gpu quota|space|rejected the (file|request)|no downloadable file|event id/i, 'Free Hugging Face Space busy, band ya quota khatam hai.', 'Thodi der baad dobara try karo. App apne aap built-in look/enhance par aa jati hai. Space "Running" hai ya nahi check karo.'],
    [/failed to fetch|502|503|504|econnreset|socket hang up|network|server is busy/i, 'Server restart hua ya memory (RAM) khatam hui, ya connection toota.', 'Render Logs me "Out of memory" dekho. Chhoti file/kam duration try karo, MAX_VIDEO_SECONDS kam rakho, ya bada server lo.'],
    [/longer than|too long|duration|5 minutes|30 minutes|exceeds the/i, 'File ki length limit se zyada hai.', 'User ko chhota clip upload karne ko bolo (video 5 min, audio 30 min).'],
    [/larger than|too large|413|25 MB|250 MB|50 MB|file size/i, 'File ka size limit se bada hai.', 'User ko chhoti file bhejne ko bolo (photo 25 MB, video 250 MB, audio 50 MB).'],
    [/valid (video|audio|image|photo|media)|stream|codec|corrupt|invalid data|moov|unsupported|only (mp4|jpg)/i, 'File kharab ya unsupported format ki hai.', 'User ko MP4/JPG/PNG/MP3 jaisi standard file dobara export karke bhejne ko bolo.'],
    [/too many|rate limit|429/i, 'User ne bahut jaldi-jaldi requests bheji.', 'Normal hai. Kuch minute baad chalega.'],
    [/database|connection terminated|ECONNREFUSED/i, 'Database connection ki dikkat.', 'Neon database chal raha hai ya nahi dekho aur DATABASE_URL check karo.'],
    [/ffmpeg|filter|invalid argument|error while|conversion failed/i, 'FFmpeg processing me error aaya (filter ya file ki dikkat).', 'Render Logs me ffmpeg ki poori error line dekho aur wo line mujhe bhejo.']
  ];
  for (const [re, cause, fix] of rules) if (re.test(m)) return { cause, fix };
  return { cause: 'Wajah pakki nahi hai.', fix: 'Render Logs me is samay ke aas-paas ki error line dekho aur mujhe bhejo.' };
}

function makeTrack(pool) {
  let warned = false;
  return function track(kind, { userId = null, tool = null, status = null, detail = null, bytes = null, ms = null } = {}) {
    try {
      const uid = /^\d{1,18}$/.test(String(userId)) ? String(userId) : null;
      pool.query('INSERT INTO vidora_events(user_id,kind,tool,status,detail,bytes,ms) VALUES($1,$2,$3,$4,$5,$6,$7)', [
        uid, String(kind).slice(0, 24), tool ? String(tool).slice(0, 48) : null, status ? String(status).slice(0, 16) : null,
        detail ? String(detail).replace(/\s+/g, ' ').slice(0, 300) : null,
        Number.isFinite(Number(bytes)) && bytes !== null ? Math.round(Number(bytes)) : null,
        Number.isFinite(Number(ms)) && ms !== null ? Math.round(Number(ms)) : null
      ]).catch(e => { if (!warned) { warned = true; console.warn('[Vidora] event log unavailable:', e.message); } });
    } catch { /* tracking must never break a request */ }
  };
}

const safeTz = () => (/^[A-Za-z_/+-]{1,40}$/.test(process.env.DASHBOARD_TZ || '') ? process.env.DASHBOARD_TZ : 'Asia/Kolkata');
const clampDays = v => ([1, 7, 30, 90].includes(Number(v)) ? Number(v) : 7);

async function buildDashboard(pool, { days = 7, adminId = null, system = null } = {}) {
  days = clampDays(days);
  const tz = safeTz(), unit = days <= 1 ? 'hour' : 'day', admin = adminId === null || adminId === undefined ? null : String(adminId);
  const since = (await pool.query(
    `SELECT CASE WHEN $1::int<=1 THEN now()-interval '24 hours'
       ELSE (date_trunc('day', now() AT TIME ZONE $2) - make_interval(days=>$1::int-1)) AT TIME ZONE $2 END AS since`, [days, tz])).rows[0].since;

  const q = (sql, params) => pool.query(sql, params).then(r => r.rows);
  const [kpiRows, seriesRows, toolRows, errorRows, userRows, userTotals, reportCounts, reportRows] = await Promise.all([
    q(`SELECT count(*) FILTER (WHERE e.kind='login') AS logins,
              count(DISTINCT e.user_id) FILTER (WHERE e.kind='login') AS signin_users,
              count(*) FILTER (WHERE e.kind='login_failed') AS failed_logins,
              count(*) FILTER (WHERE e.kind='signup') AS signups,
              count(*) FILTER (WHERE e.kind='upload' AND e.status='ok') AS uploads,
              count(*) FILTER (WHERE e.kind='upload' AND e.status='failed') AS upload_failures,
              COALESCE(sum(e.bytes) FILTER (WHERE e.kind='upload' AND e.status='ok'),0) AS upload_bytes,
              count(*) FILTER (WHERE e.kind IN ('job','analysis')) AS runs,
              count(*) FILTER (WHERE e.kind IN ('job','analysis') AND e.status='ok') AS runs_ok,
              count(*) FILTER (WHERE e.kind IN ('job','analysis') AND e.status='failed') AS runs_failed,
              count(DISTINCT e.user_id) AS active_users
       FROM vidora_events e WHERE e.created_at >= $1::timestamptz AND ${NOT_ADMIN}`, [since, admin]),
    q(`WITH b AS (SELECT generate_series(date_trunc($3, $1::timestamptz AT TIME ZONE $4), date_trunc($3, now() AT TIME ZONE $4), ('1 '||$3)::interval) AS bucket)
       SELECT to_char(b.bucket, CASE WHEN $3='hour' THEN 'HH24:00' ELSE 'DD Mon' END) AS label,
              count(e.id) FILTER (WHERE e.kind='login') AS logins,
              count(DISTINCT e.user_id) FILTER (WHERE e.kind='login') AS signin_users,
              count(e.id) FILTER (WHERE e.kind='signup') AS signups,
              count(e.id) FILTER (WHERE e.kind='upload' AND e.status='ok') AS uploads,
              count(e.id) FILTER (WHERE e.kind IN ('job','analysis') AND e.status='ok') AS runs_ok,
              count(e.id) FILTER (WHERE e.kind IN ('job','analysis') AND e.status='failed') AS runs_failed
       FROM b LEFT JOIN vidora_events e ON date_trunc($3, e.created_at AT TIME ZONE $4)=b.bucket AND e.created_at >= $1::timestamptz AND ${NOT_ADMIN}
       GROUP BY b.bucket ORDER BY b.bucket`, [since, admin, unit, tz]),
    q(`SELECT e.tool, count(*) AS runs, count(*) FILTER (WHERE e.status='ok') AS ok, count(*) FILTER (WHERE e.status='failed') AS failed,
              count(*) FILTER (WHERE e.status='cancelled') AS cancelled, round(avg(e.ms) FILTER (WHERE e.status='ok'))::int AS avg_ms
       FROM vidora_events e WHERE e.kind IN ('job','analysis') AND e.tool IS NOT NULL AND e.created_at >= $1::timestamptz AND ${NOT_ADMIN}
       GROUP BY e.tool ORDER BY runs DESC LIMIT 30`, [since, admin]),
    q(`SELECT left(e.detail,160) AS message, count(*) AS n, array_agg(DISTINCT e.tool) FILTER (WHERE e.tool IS NOT NULL) AS tools,
              count(DISTINCT e.user_id) AS users, max(e.created_at) AS last_at
       FROM vidora_events e WHERE e.status='failed' AND e.kind IN ('job','analysis','upload') AND e.detail IS NOT NULL AND e.created_at >= $1::timestamptz AND ${NOT_ADMIN}
       GROUP BY 1 ORDER BY n DESC, last_at DESC LIMIT 10`, [since, admin]),
    q(`SELECT u.id::text AS id, u.name, u.email, u.created_at,
              max(e.created_at) FILTER (WHERE e.kind='login') AS last_login,
              max(e.created_at) AS last_seen,
              count(*) FILTER (WHERE e.kind='login' AND e.created_at >= $1::timestamptz) AS logins,
              count(*) FILTER (WHERE e.kind='upload' AND e.status='ok' AND e.created_at >= $1::timestamptz) AS uploads,
              count(*) FILTER (WHERE e.kind IN ('job','analysis') AND e.created_at >= $1::timestamptz) AS runs,
              count(*) FILTER (WHERE e.kind IN ('job','analysis') AND e.status='failed' AND e.created_at >= $1::timestamptz) AS failures,
              (SELECT count(*) FROM vidora_comments c WHERE c.user_id=u.id AND c.status<>'fixed') AS open_reports
       FROM vidora_users u LEFT JOIN vidora_events e ON e.user_id=u.id
       WHERE u.id <> COALESCE($2::bigint,-1)
       GROUP BY u.id ORDER BY COALESCE(max(e.created_at), u.created_at) DESC LIMIT 200`, [since, admin]),
    q(`SELECT count(*) AS total, count(*) FILTER (WHERE created_at >= $1::timestamptz) AS new_users,
              count(*) FILTER (WHERE created_at >= now()-interval '24 hours') AS new_24h
       FROM vidora_users WHERE id <> COALESCE($2::bigint,-1)`, [since, admin]),
    q(`SELECT count(*) FILTER (WHERE status<>'fixed') AS open_total, count(*) FILTER (WHERE status<>'fixed' AND priority='high') AS open_high,
              count(*) FILTER (WHERE status='received') AS received, count(*) FILTER (WHERE status='analyzing') AS analyzing,
              count(*) FILTER (WHERE status='in_progress') AS in_progress, count(*) FILTER (WHERE status='fixed') AS fixed,
              count(*) FILTER (WHERE kind='bug' AND status<>'fixed') AS open_bugs FROM vidora_comments`, []),
    q(`SELECT c.id::text AS id, c.body, c.kind, c.status, c.priority, c.ai_analysis, c.admin_note, c.created_at, c.updated_at,
              u.id::text AS user_id, u.name, u.email
       FROM vidora_comments c JOIN vidora_users u ON u.id=c.user_id
       WHERE c.status<>'fixed' OR c.updated_at >= $1::timestamptz
       ORDER BY (c.status='fixed'), CASE c.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, c.created_at DESC LIMIT 60`, [since])
  ]);

  // What went wrong for the people who wrote in: their latest failures, with a plain-language reason.
  const ids = [...new Set(reportRows.map(r => r.user_id))];
  const failRows = ids.length ? await q(
    `SELECT user_id::text AS user_id, tool, detail, created_at FROM (
       SELECT e.*, row_number() OVER (PARTITION BY e.user_id ORDER BY e.created_at DESC) AS rn
       FROM vidora_events e WHERE e.status='failed' AND e.user_id = ANY($1::bigint[])) t WHERE rn <= 4 ORDER BY created_at DESC`, [ids]) : [];
  const byUser = new Map();
  for (const f of failRows) { const l = byUser.get(f.user_id) || []; l.push({ ...f, ...explainError(f.detail) }); byUser.set(f.user_id, l); }
  const reports = reportRows.map(r => ({
    ...r, recentFailures: byUser.get(r.user_id) || [],
    likely: (byUser.get(r.user_id) || [])[0] ? explainError(byUser.get(r.user_id)[0].detail) : explainError(r.body)
  }));

  const k = kpiRows[0] || {}, n = v => Number(v || 0);
  const runs = n(k.runs), ok = n(k.runs_ok);
  return {
    generatedAt: new Date().toISOString(), days, unit, tz, since,
    kpi: {
      totalUsers: n(userTotals[0]?.total), newUsers: n(userTotals[0]?.new_users), newUsers24h: n(userTotals[0]?.new_24h),
      signIns: n(k.logins), signInUsers: n(k.signin_users), failedSignIns: n(k.failed_logins), signUps: n(k.signups), activeUsers: n(k.active_users),
      uploads: n(k.uploads), uploadFailures: n(k.upload_failures), uploadBytes: n(k.upload_bytes),
      runs, runsOk: ok, runsFailed: n(k.runs_failed), successRate: runs ? Math.round(ok / runs * 1000) / 10 : null,
      openReports: n(reportCounts[0]?.open_total), openHigh: n(reportCounts[0]?.open_high), openBugs: n(reportCounts[0]?.open_bugs)
    },
    reportCounts: Object.fromEntries(Object.entries(reportCounts[0] || {}).map(([a, b]) => [a, n(b)])),
    series: seriesRows.map(r => ({ label: r.label, logins: n(r.logins), signinUsers: n(r.signin_users), signups: n(r.signups), uploads: n(r.uploads), runsOk: n(r.runs_ok), runsFailed: n(r.runs_failed) })),
    tools: toolRows.map(r => ({ tool: r.tool, runs: n(r.runs), ok: n(r.ok), failed: n(r.failed), cancelled: n(r.cancelled), avgMs: r.avg_ms === null ? null : n(r.avg_ms) })),
    errors: errorRows.map(r => ({ message: r.message, count: n(r.n), tools: r.tools || [], users: n(r.users), lastAt: r.last_at, ...explainError(r.message) })),
    users: userRows.map(r => ({ id: r.id, name: r.name, email: r.email, joinedAt: r.created_at, lastLogin: r.last_login, lastSeen: r.last_seen, logins: n(r.logins), uploads: n(r.uploads), runs: n(r.runs), failures: n(r.failures), openReports: n(r.open_reports) })),
    reports,
    system
  };
}

function setupAnalytics(app, pool, { user, admin, readLimit }) {
  const track = makeTrack(pool);
  app.locals.track = track;
  app.get('/admin', (_req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
  app.get('/api/admin/dashboard', readLimit, user, admin, async (req, res, next) => {
    try {
      const system = typeof app.locals.systemInfo === 'function' ? app.locals.systemInfo() : null;
      const data = await buildDashboard(pool, { days: req.query.days, adminId: app.locals.adminAccount?.id ?? null, system });
      res.set('Cache-Control', 'no-store').json(data);
    } catch (e) { next(e); }
  });
  app.get('/api/admin/users/:id/activity', readLimit, user, admin, async (req, res, next) => {
    try {
      if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid user id.' });
      const q = await pool.query('SELECT kind,tool,status,detail,bytes,ms,created_at FROM vidora_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 40', [req.params.id]);
      res.set('Cache-Control', 'no-store').json({ events: q.rows.map(r => ({ ...r, ...(r.status === 'failed' ? explainError(r.detail) : {}) })) });
    } catch (e) { next(e); }
  });
  // Keep the free database small: drop old events once a day.
  const retention = Math.max(14, Math.min(730, Number(process.env.DASHBOARD_RETENTION_DAYS) || 120));
  const prune = () => pool.query('DELETE FROM vidora_events WHERE created_at < now() - make_interval(days=>$1::int)', [retention]).catch(() => {});
  setTimeout(prune, 60 * 1000).unref(); setInterval(prune, 24 * 3600 * 1000).unref();
  return track;
}

module.exports = { EVENTS_SCHEMA, setupAnalytics, buildDashboard, explainError, makeTrack };
