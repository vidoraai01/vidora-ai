'use strict';
// Owner dashboard: event log (sign-ups, sign-ins, uploads, tool runs, failures) + admin-only API.
// Privacy: no IP addresses, no file names, no passwords and no e-mail of failed sign-ins are stored.
const path = require('node:path');

const EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS vidora_events(id BIGSERIAL PRIMARY KEY,user_id BIGINT,kind VARCHAR(24) NOT NULL,tool VARCHAR(48),status VARCHAR(16),detail VARCHAR(300),bytes BIGINT,ms INTEGER,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS vidora_events_created_idx ON vidora_events(created_at DESC);
CREATE INDEX IF NOT EXISTS vidora_events_user_idx ON vidora_events(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS vidora_events_kind_idx ON vidora_events(kind,created_at DESC);
ALTER TABLE vidora_users ADD COLUMN IF NOT EXISTS login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vidora_users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
UPDATE vidora_users u SET login_count=s.n, last_login_at=s.last FROM (SELECT user_id, count(*) AS n, max(created_at) AS last FROM vidora_events WHERE kind='login' AND user_id IS NOT NULL GROUP BY user_id) s WHERE u.id=s.user_id AND u.login_count=0;
CREATE TABLE IF NOT EXISTS vidora_counters(name VARCHAR(32) PRIMARY KEY, value BIGINT NOT NULL DEFAULT 0);
INSERT INTO vidora_counters(name,value) SELECT 'guest_visits',0 WHERE NOT EXISTS (SELECT 1 FROM vidora_counters WHERE name='guest_visits');
INSERT INTO vidora_counters(name,value) SELECT x.name, x.v FROM (SELECT 'uploads' AS name, count(*) AS v FROM vidora_events WHERE kind='upload' AND status='ok'
  UNION ALL SELECT 'upload_bytes', COALESCE(sum(bytes),0) FROM vidora_events WHERE kind='upload' AND status='ok'
  UNION ALL SELECT 'runs_ok', count(*) FROM vidora_events WHERE kind IN ('job','analysis') AND status='ok'
  UNION ALL SELECT 'runs_failed', count(*) FROM vidora_events WHERE kind IN ('job','analysis') AND status='failed'
  UNION ALL SELECT 'failed_signins', count(*) FROM vidora_events WHERE kind='login_failed') x
  WHERE NOT EXISTS (SELECT 1 FROM vidora_counters c WHERE c.name=x.name);`;

// Lifetime counters are kept forever (events are pruned after DASHBOARD_RETENTION_DAYS, these are not).
const COUNTER_FOR = (kind, status) => {
  if (kind === 'login_failed') return 'failed_signins';
  if (kind === 'guest') return 'guest_visits';
  if (kind === 'upload' && status === 'ok') return 'uploads';
  if ((kind === 'job' || kind === 'analysis') && status === 'ok') return 'runs_ok';
  if ((kind === 'job' || kind === 'analysis') && status === 'failed') return 'runs_failed';
  return null;
};

const NOT_ADMIN = '(e.user_id IS NULL OR e.user_id <> COALESCE($2::bigint,-1))';

// Plain-language reason + suggested fix for the most common failure messages (owner-facing, Hinglish).
function explainError(message) {
  const m = String(message || '');
  const rules = [
    [/already have a media job/i, 'The user started a second job while one was already running.', 'Nothing to fix. Ask the user to finish or cancel the first job.'],
    [/cancel/i, 'The user cancelled the job.', 'No problem.'],
    [/not configured|SPACE_URL|API_SECRET|needs .*_SPACE_URL/i, 'The AI model for this feature is not set up in Render.', 'Add the HF_*/PHOTO_*/VENH_* variables in Render Environment, or ask the user to use an "Instant look".'],
    [/free (ai|photo|video)[^.]* (server|space)|gpu quota|space|rejected the (file|request)|no downloadable file|event id/i, 'The free Hugging Face Space is busy, stopped or out of quota.', 'Try again later. The app falls back to the built-in look/enhance automatically. Check that the Space is "Running".'],
    [/failed to fetch|502|503|504|econnreset|socket hang up|network|server is busy/i, 'The server restarted, ran out of memory (RAM), or the connection dropped.', 'Look for "Out of memory" in the Render Logs. Try a smaller file or shorter duration, lower MAX_VIDEO_SECONDS, or use a bigger server.'],
    [/longer than|too long|duration|5 minutes|30 minutes|exceeds the/i, 'The file is longer than the limit.', 'Ask the user to upload a shorter clip (video 5 min, audio 30 min).'],
    [/larger than|too large|413|25 MB|250 MB|50 MB|file size/i, 'The file is larger than the size limit.', 'Ask the user to send a smaller file (photo 25 MB, video 250 MB, audio 50 MB).'],
    [/valid (video|audio|image|photo|media)|stream|codec|corrupt|invalid data|moov|unsupported|only (mp4|jpg)/i, 'The file is damaged or in an unsupported format.', 'Ask the user to re-export it as a standard MP4/JPG/PNG/MP3 file and upload again.'],
    [/too many|rate limit|429/i, 'The user sent too many requests too quickly.', 'Normal. It will work again after a few minutes.'],
    [/database|connection terminated|ECONNREFUSED/i, 'Database connection problem.', 'Check that the Neon database is running and verify DATABASE_URL.'],
    [/ffmpeg|filter|invalid argument|error while|conversion failed/i, 'FFmpeg failed while processing (a filter or file problem).', 'Open the Render Logs, find the full ffmpeg error line and send it to the developer.']
  ];
  for (const [re, cause, fix] of rules) if (re.test(m)) return { cause, fix };
  return { cause: 'The cause is not certain.', fix: 'Open the Render Logs, find the error lines around this time and send them to the developer.' };
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
      const bump = (name, by = 1) => pool.query('INSERT INTO vidora_counters(name,value) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET value=vidora_counters.value+EXCLUDED.value', [name, by]).catch(() => {});
      const counter = COUNTER_FOR(kind, status);
      if (counter) bump(counter);
      if (counter === 'uploads' && Number.isFinite(Number(bytes)) && bytes !== null) bump('upload_bytes', Math.round(Number(bytes)));
      if (kind === 'login' && uid) pool.query('UPDATE vidora_users SET login_count=login_count+1,last_login_at=now() WHERE id=$1', [uid]).catch(() => {});
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
  const [kpiRows, seriesRows, toolRows, errorRows, userRows, userTotals, reportCounts, reportRows, lifeRows, counterRows, providerRows, resetRows] = await Promise.all([
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
              (SELECT count(*) FROM vidora_comments c WHERE c.user_id=u.id AND c.status<>'fixed') AS open_reports,
              u.login_count AS total_logins
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
       ORDER BY (c.status='fixed'), CASE c.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, c.created_at DESC LIMIT 60`, [since]),
    q(`SELECT count(*) AS users, count(*) FILTER (WHERE login_count>0) AS ever_signed_in, COALESCE(sum(login_count),0) AS signins,
              min(created_at) AS first_at, max(last_login_at) AS last_login_at
       FROM vidora_users WHERE id <> COALESCE($1::bigint,-1)`, [admin]),
    q('SELECT name, value FROM vidora_counters', []),
    q(`SELECT CASE WHEN d IN ('gmail.com','googlemail.com') THEN 'gmail'
                   WHEN d IN ('outlook.com','hotmail.com','live.com','msn.com') OR d LIKE 'outlook.%' OR d LIKE 'hotmail.%' THEN 'outlook'
                   WHEN d LIKE 'yahoo.%' OR d='ymail.com' THEN 'yahoo'
                   WHEN d IN ('icloud.com','me.com','mac.com') THEN 'icloud'
                   ELSE 'other' END AS provider,
              count(*) AS users, count(*) FILTER (WHERE login_count>0) AS signed_in, COALESCE(sum(login_count),0) AS signins
       FROM (SELECT split_part(lower(email),'@',2) AS d, login_count FROM vidora_users WHERE id <> COALESCE($1::bigint,-1)) t
       GROUP BY 1 ORDER BY users DESC`, [admin]),
    q(`SELECT DISTINCT ON (e.user_id) e.user_id::text AS user_id, u.name, u.email, e.status, e.detail, e.created_at
       FROM vidora_events e JOIN vidora_users u ON u.id=e.user_id
       WHERE e.kind='reset_request' AND e.created_at >= now()-interval '7 days'
         AND NOT EXISTS (SELECT 1 FROM vidora_events r WHERE r.kind='reset_link' AND r.user_id=e.user_id AND r.created_at>e.created_at)
       ORDER BY e.user_id, e.created_at DESC`, [])
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
    users: userRows.map(r => ({ id: r.id, name: r.name, email: r.email, joinedAt: r.created_at, lastLogin: r.last_login, lastSeen: r.last_seen, logins: n(r.logins), uploads: n(r.uploads), runs: n(r.runs), failures: n(r.failures), openReports: n(r.open_reports), totalLogins: n(r.total_logins) })),
    reports,
    lifetime: (() => {
      const c = Object.fromEntries(counterRows.map(r => [r.name, n(r.value)])), l = lifeRows[0] || {};
      return {
        users: n(l.users), everSignedIn: n(l.ever_signed_in), signIns: n(l.signins), firstUserAt: l.first_at, lastLoginAt: l.last_login_at,
        guestVisits: c.guest_visits || 0, failedSignIns: c.failed_signins || 0, uploads: c.uploads || 0, uploadBytes: c.upload_bytes || 0,
        runsOk: c.runs_ok || 0, runsFailed: c.runs_failed || 0
      };
    })(),
    providers: providerRows.map(r => ({ provider: r.provider, users: n(r.users), signedIn: n(r.signed_in), signIns: n(r.signins) })),
    resetRequests: resetRows.map(r => ({ userId: r.user_id, name: r.name, email: r.email, status: r.status, detail: r.detail, at: r.created_at })).sort((a, b) => new Date(b.at) - new Date(a.at)),
    system
  };
}

function setupAnalytics(app, pool, { user, admin, readLimit, origin = (_q, _r, next) => next(), guestLimit = (_q, _r, next) => next() }) {
  const track = makeTrack(pool);
  app.locals.track = track;
  app.get('/admin', (_req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
  // "Continue as guest" is client-side only; this tiny endpoint just counts the visit (no IP, no cookie, no data).
  app.post('/api/analytics/guest', guestLimit, origin, (_req, res) => { track('guest', { status: 'ok' }); res.status(204).end(); });
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
