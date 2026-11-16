(function () {
  'use strict';
  // Owner dashboard. Every piece of user-supplied text is inserted with textContent (never innerHTML).
  const app = document.getElementById('app');
  const state = { generated: null, days: 7, auto: false, timer: null, filter: 'open', search: '', data: null, openUser: null };
  const TZ = 'Asia/Kolkata';

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v); // CSSOM is allowed by the site's CSP; style="" attributes are not
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const num = v => Number(v || 0).toLocaleString('en-IN');
  const bytes = b => { b = Number(b || 0); if (b < 1024) return b + ' B'; const u = ['KB', 'MB', 'GB', 'TB']; let i = -1; do { b /= 1024; i++; } while (b >= 1024 && i < 3); return b.toFixed(b < 10 ? 1 : 0) + ' ' + u[i]; };
  const dur = ms => { if (ms === null || ms === undefined) return '—'; const s = Math.round(ms / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; };
  const when = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '—';
  const ago = iso => { if (!iso) return 'never'; const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); if (s < 90) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' hr ago'; return Math.round(s / 86400) + ' d ago'; };
  const uptime = s => { const d = Math.floor(s / 86400), hr = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + (hr ? hr + 'h ' : '') + m + 'm'; };
  function toast(msg) { const t = document.getElementById('toast'); if (!t) return; t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3200); }

  async function api(path, opts) {
    const r = await fetch(path, { credentials: 'same-origin', ...(opts || {}) });
    let body = null; try { body = await r.json(); } catch { /* not json */ }
    if (!r.ok) { const e = new Error((body && body.error) || 'Request failed (' + r.status + ')'); e.status = r.status; throw e; }
    return body;
  }

  function gate(title, text, linkText) {
    app.replaceChildren(h('div', { class: 'admin-gate panel' }, h('h2', { text: title }), h('p', { class: 'muted', text }), linkText ? h('a', { class: 'primary-btn', href: '/', text: linkText }) : null));
  }

  async function boot() {
    try {
      const me = await api('/api/auth/me');
      if (!me.user) return gate('Admin sign-in required', 'First go to the site, sign in with the admin email and password, then come back here.', 'Go to sign in');
      if (me.user.role !== 'admin') return gate('Admin only', 'This page is only for the site owner (admin).', 'Back to site');
      await load();
    } catch (e) { gate('Could not load', e.message, 'Back to site'); }
  }

  async function load(silent) {
    try {
      const d = await api('/api/admin/dashboard?days=' + state.days);
      state.data = d; render();
    } catch (e) {
      if (e.status === 401 || e.status === 403) return gate('Admin sign-in required', 'Your session has ended. Sign in again as admin on the site.', 'Go to sign in');
      if (!silent) toast(e.message); if (!state.data) gate('Could not load dashboard', e.message, null);
    }
  }

  function setAuto(on) { state.auto = on; clearInterval(state.timer); if (on) state.timer = setInterval(() => load(true), 60000); }

  function kpi(label, value, sub, tone) { return h('div', { class: 'kpi ' + (tone || '') }, h('small', { text: label }), h('b', { text: value }), h('span', { text: sub || '' })); }

  function chart(series, unit) {
    const max = Math.max(1, ...series.map(s => Math.max(s.logins, s.uploads, s.runsFailed)));
    const every = Math.ceil(series.length / 8);
    const cols = series.map((s, i) => {
      const bar = (cls, v) => h('i', { class: 'bar ' + cls, style: { height: Math.max(2, Math.round(v / max * 112)) + 'px' } });
      return h('div', { class: 'col', title: s.label + ' · sign-ins ' + s.logins + ' (' + s.signinUsers + ' people) · uploads ' + s.uploads + ' · failures ' + s.runsFailed + ' · new users ' + s.signups },
        h('div', { class: 'bars' }, bar('l', s.logins), bar('u', s.uploads), bar('f', s.runsFailed)),
        h('div', { class: 'lbl', text: i % every === 0 ? s.label : '' }));
    });
    return h('div', null, h('div', { class: 'chart', role: 'img', 'aria-label': 'Activity per ' + unit }, cols),
      h('div', { class: 'legend' }, h('span', null, h('i', { style: { background: 'var(--cyan)' } }), 'Sign-ins'), h('span', null, h('i', { style: { background: 'var(--green)' } }), 'Uploads'), h('span', null, h('i', { style: { background: 'var(--danger)' } }), 'Failures')));
  }

  function reportCard(r) {
    const status = h('select', { 'aria-label': 'Status' }, ...[['received', 'Received'], ['analyzing', 'Analyzing'], ['in_progress', 'In progress'], ['fixed', 'Fixed (verified)']].map(([v, t]) => h('option', { value: v, text: t, selected: v === r.status })));
    const note = h('input', { type: 'text', maxlength: '1000', placeholder: 'Note for the user (optional)', value: r.admin_note || '' });
    const save = h('button', { class: 'primary-btn', type: 'button', text: 'Save', onclick: async () => {
      const st = status.value;
      if (st === 'fixed' && !confirm('Has the fix been deployed and verified? Only then choose Fixed.')) return;
      save.disabled = true;
      try { await api('/api/admin/issues/' + encodeURIComponent(r.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: st, adminNote: note.value, verified: st === 'fixed' }) }); toast('Updated. The user will see the new status.'); await load(true); }
      catch (e) { toast(e.message); save.disabled = false; }
    } });
    return h('article', { class: 'rep ' + r.priority + (r.status === 'fixed' ? ' fixed' : '') },
      h('div', { class: 'rep-top' }, h('span', { class: 'badge ' + r.kind, text: r.kind }), h('span', { class: 'badge ' + r.priority, text: r.priority + ' priority' }), h('span', { class: 'badge ' + r.status, text: r.status.replace('_', ' ') }), h('span', { class: 'who' }, h('b', { text: r.name }), ' · ', r.email, ' · ', when(r.created_at))),
      h('div', { class: 'msg', text: r.body }),
      h('div', { class: 'diag' }, h('b', { text: 'What is wrong: ' }), r.likely.cause, h('br'), h('b', { text: 'What to do: ' }), r.likely.fix),
      r.recentFailures.length ? h('div', null, h('div', { class: 'who', text: 'Recent errors for this user:' }), h('ul', { class: 'fails' }, r.recentFailures.map(f => h('li', null, h('b', { text: f.tool || 'unknown' }), ' · ', when(f.created_at), h('br'), (f.detail || '').slice(0, 220), h('br'), '→ ' + f.cause)))) : h('div', { class: 'who', text: 'No recorded errors for this user.' }),
      r.ai_analysis ? h('div', { class: 'who', text: r.ai_analysis }) : null,
      h('div', { class: 'rep-actions' }, status, note, save));
  }

  function reportsSection(d) {
    const f = state.filter;
    let list = d.reports;
    if (f === 'open') list = list.filter(r => r.status !== 'fixed'); else if (f === 'bug') list = list.filter(r => r.kind === 'bug' && r.status !== 'fixed'); else if (f === 'high') list = list.filter(r => r.priority === 'high' && r.status !== 'fixed'); else if (f === 'fixed') list = list.filter(r => r.status === 'fixed');
    const chips = [['open', 'Open (' + d.kpi.openReports + ')'], ['high', 'High (' + d.kpi.openHigh + ')'], ['bug', 'Bugs (' + d.kpi.openBugs + ')'], ['fixed', 'Fixed'], ['all', 'All']].map(([v, t]) => h('button', { class: 'adm-chip' + (f === v ? ' on' : ''), type: 'button', text: t, onclick: () => { state.filter = v; render(); } }));
    return h('section', { class: 'adm-card' }, h('h2', { text: 'Help messages & reports' }), h('p', { class: 'hint', text: 'What the user wrote, the likely cause and their recent errors in one place. The user sees any status change right away.' }), h('div', { class: 'adm-range' }, chips), list.length ? list.map(reportCard) : h('div', { class: 'empty', text: 'No reports in this filter.' }));
  }

  function errorsSection(d) {
    if (!d.errors.length) return h('section', { class: 'adm-card' }, h('h2', { text: 'Top errors' }), h('div', { class: 'empty', text: 'No errors in this period. 🎉' }));
    return h('section', { class: 'adm-card' }, h('h2', { text: 'Top errors' }), h('p', { class: 'hint', text: 'Which problems happened most often, with the cause and fix.' }),
      h('div', { class: 'scroll-x' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Times', 'Error', 'Cause / Fix', 'Users'].map(t => h('th', { text: t })))),
        h('tbody', null, d.errors.map(e => h('tr', null, h('td', { class: 'num', text: e.count + '×' }), h('td', null, e.message, h('br'), h('span', { class: 'muted', text: (e.tools || []).join(', ') + ' · ' + ago(e.lastAt) })), h('td', null, e.cause, h('br'), h('span', { class: 'muted', text: e.fix })), h('td', { class: 'num', text: e.users })))))));
  }

  function toolsSection(d) {
    if (!d.tools.length) return h('section', { class: 'adm-card' }, h('h2', { text: 'Tools usage' }), h('div', { class: 'empty', text: 'No tool has been used yet.' }));
    return h('section', { class: 'adm-card' }, h('h2', { text: 'Tools usage' }), h('p', { class: 'hint', text: 'How often each tool ran and how often it succeeded.' }),
      h('div', { class: 'scroll-x' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Tool', 'Runs', 'OK', 'Failed', 'Success', 'Avg time'].map((t, i) => h('th', { class: i ? 'num' : '', text: t })))),
        h('tbody', null, d.tools.map(t => { const rate = t.runs ? Math.round(t.ok / t.runs * 100) : 0; return h('tr', null, h('td', { text: t.tool }), h('td', { class: 'num', text: t.runs }), h('td', { class: 'num pill-ok', text: t.ok }), h('td', { class: 'num ' + (t.failed ? 'pill-bad' : ''), text: t.failed }), h('td', { class: 'num', text: rate + '%' }), h('td', { class: 'num', text: dur(t.avgMs) })); })))));
  }

  function userRow(u) {
    const body = h('div', { class: 'uact' }, h('div', { class: 'empty', text: 'Loading activity…' }));
    const row = h('div', { class: 'urow' });
    const extra = h('div', null, body, h('button', { class: 'outline-btn', type: 'button', text: 'Create password reset link', onclick: () => makeLink(u) }));
    const head = h('button', { class: 'uhead', type: 'button', 'aria-expanded': 'false', onclick: async () => {
      const open = row.classList.toggle('open'); head.setAttribute('aria-expanded', String(open));
      if (!open) { extra.remove(); return; } row.append(extra);
      try {
        const { events } = await api('/api/admin/users/' + encodeURIComponent(u.id) + '/activity');
        body.replaceChildren(events.length ? h('ul', { class: 'fails' }, events.map(e => h('li', null, h('b', { text: e.kind + (e.tool ? ' · ' + e.tool : '') }), ' · ', h('span', { class: e.status === 'failed' ? 'pill-bad' : e.status === 'ok' ? 'pill-ok' : '', text: e.status || '' }), ' · ', when(e.created_at), e.bytes ? ' · ' + bytes(e.bytes) : '', e.ms ? ' · ' + dur(e.ms) : '', e.detail ? h('br') : null, e.detail ? e.detail.slice(0, 200) : null, e.cause ? h('br') : null, e.cause ? '→ ' + e.cause : null))) : h('div', { class: 'empty', text: 'No activity recorded for this user.' }));
      } catch (e) { body.replaceChildren(h('div', { class: 'empty', text: e.message })); }
    } },
      h('div', null, h('div', { class: 'uname', text: u.name }), h('div', { class: 'umail', text: u.email })),
      h('div', { class: 'chips' }, h('span', { text: 'Joined ' + when(u.joinedAt) }), h('span', { text: 'Last seen ' + ago(u.lastSeen) }), h('span', { text: u.totalLogins + ' sign-ins total' }), h('span', { text: u.uploads + ' uploads' }), h('span', { text: u.runs + ' runs' }), u.failures ? h('span', { class: 'bad', text: u.failures + ' failed' }) : null, u.openReports ? h('span', { class: 'warn', text: u.openReports + ' open report' + (u.openReports > 1 ? 's' : '') }) : null));
    row.append(head); return row;
  }

  function usersSection(d) {
    const q = state.search.trim().toLowerCase();
    const list = q ? d.users.filter(u => (u.name + ' ' + u.email).toLowerCase().includes(q)) : d.users;
    const input = h('input', { class: 'adm-search', type: 'search', placeholder: 'Search name or email…', value: state.search, 'aria-label': 'Search users' });
    const holder = h('div', null, list.length ? list.map(userRow) : h('div', { class: 'empty', text: 'No users found.' }));
    input.addEventListener('input', () => { state.search = input.value; const ql = input.value.trim().toLowerCase(); const l2 = ql ? d.users.filter(u => (u.name + ' ' + u.email).toLowerCase().includes(ql)) : d.users; holder.replaceChildren(...(l2.length ? l2.map(userRow) : [h('div', { class: 'empty', text: 'No users found.' })])); });
    return h('section', { class: 'adm-card' }, h('h2', { text: 'Users (' + d.kpi.totalUsers + ')' }), h('p', { class: 'hint', text: 'Most recently active first. Tap a user to see their recent activity and errors.' }), input, holder);
  }

  function systemSection(d) {
    const s = d.system; if (!s) return null;
    const yn = v => v ? 'Connected ✓' : 'Not set';
    const cells = [['Uptime', uptime(s.uptimeSeconds)], ['Memory used', s.rssMB + ' MB' + (s.memoryLimitMB ? ' / ' + s.memoryLimitMB + ' MB' : '')], ['Active jobs now', String(s.activeJobs)], ['Files waiting', String(s.heldUploads)], ['Low-resource mode', s.lowResource ? 'ON' : 'off'], ['Max video length', s.maxVideoSeconds + ' s'],
      ['Visual Change', s.providers.visualChange], ['Photo AI (Space)', yn(s.providers.photoAI)], ['Video Enhance AI', yn(s.providers.videoEnhanceAI)], ['Gemini', yn(s.providers.gemini)], ['Reset e-mail', yn(s.providers.resetEmail)], ['Node', s.node]];
    const result = h('p', { class: 'hint', text: state.mailTest || '' });
    const btn = h('button', { class: 'outline-btn', type: 'button', text: '✉ Send test email (to your admin email)', onclick: async () => {
      btn.disabled = true; result.textContent = 'Sending…';
      try { const r = await api('/api/admin/test-email', { method: 'POST' }); state.mailTest = '✓ Email sent (' + r.provider + ') → ' + r.to + '. Check Inbox/Spam.'; }
      catch (e) { state.mailTest = '✗ ' + e.message; }
      result.textContent = state.mailTest; btn.disabled = false;
    } });
    return h('section', { class: 'adm-card' }, h('h2', { text: 'Server health' }), h('p', { class: 'hint', text: 'Render crashes or returns 502 when memory is near the limit.' }), h('div', { class: 'sys' }, cells.map(([a, b]) => h('div', null, a, h('b', { text: b })))), btn, result);
  }

  const PROV = { gmail: 'Gmail', outlook: 'Outlook / Hotmail', yahoo: 'Yahoo', icloud: 'iCloud', other: 'Other email' };
  function lifetimeSection(d) {
    const l = d.lifetime, guests = l.guestVisits;
    const tot = Math.max(1, l.users);
    const rows = d.providers.map(p => h('tr', null, h('td', { text: PROV[p.provider] || p.provider }), h('td', { class: 'num', text: num(p.users) }), h('td', { class: 'num', text: num(p.signedIn) }), h('td', { class: 'num', text: num(p.signIns) }), h('td', { class: 'num', text: Math.round(p.users / tot * 100) + '%' })));
    if (guests) rows.push(h('tr', null, h('td', { text: 'Guest (no login)' }), h('td', { class: 'num', text: '—' }), h('td', { class: 'num', text: '—' }), h('td', { class: 'num', text: num(guests) + ' visits' }), h('td', { class: 'num', text: '' })));
    return h('section', { class: 'adm-card' }, h('h2', { text: 'Lifetime (kept forever)' }), h('p', { class: 'hint', text: 'These counts are never deleted, even when old activity is cleaned up.' }),
      h('div', { class: 'kpis' },
        kpi('Total users', num(l.users), l.firstUserAt ? 'pehla user ' + when(l.firstUserAt) : ''),
        kpi('Ever signed in', num(l.everSignedIn), 'at least once'),
        kpi('Total sign-ins', num(l.signIns), 'all time'),
        kpi('Guest visits', num(guests), 'visited without signing in'),
        kpi('Total uploads', num(l.uploads), bytes(l.uploadBytes)),
        kpi('Tool runs', num(l.runsOk + l.runsFailed), num(l.runsOk) + ' safal · ' + num(l.runsFailed) + ' fail')),
      h('h3', { text: 'Kis email se aaye' }),
      h('div', { class: 'scroll-x' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Provider', 'Users', 'Signed in', 'Sign-ins', 'Share'].map((t, i) => h('th', { class: i ? 'num' : '', text: t })))), h('tbody', null, rows))));
  }

  // The freshly made link is kept in state so a refresh/re-render never wipes it before you copy it.
  async function makeLink(u) {
    try {
      const r = await api('/api/admin/users/' + encodeURIComponent(u.id) + '/reset-link', { method: 'POST' });
      state.generated = { link: r.link, email: r.user.email, minutes: r.expiresInMinutes, at: Date.now() };
      render(); window.scrollTo(0, 0);
    } catch (e) { toast(e.message); }
  }

  function generatedSection() {
    const g = state.generated; if (!g) return null;
    const inp = h('input', { type: 'text', readonly: true, value: g.link, 'aria-label': 'Reset link' });
    return h('section', { class: 'adm-card' }, h('h2', { text: 'Reset link ready' }),
      h('p', { class: 'hint', text: g.email + ' — link (' + g.minutes + ' min valid, works once only). Copy it and send it via WhatsApp:' }), inp,
      h('div', { class: 'rep-actions' },
        h('button', { class: 'primary-btn', type: 'button', text: 'Copy link', onclick: async () => { try { await navigator.clipboard.writeText(g.link); toast('Link copied.'); } catch { inp.focus(); inp.select(); toast('Link selected, now copy it.'); } } }),
        h('button', { class: 'outline-btn', type: 'button', text: 'Close', onclick: () => { state.generated = null; load(true); } })));
  }

  function resetSection(d) {
    if (!d.resetRequests.length) return null;
    return h('section', { class: 'adm-card' }, h('h2', { text: 'Password reset requests (' + d.resetRequests.length + ')' }),
      h('p', { class: 'hint', text: 'These users pressed "Forgot password" but the email could not be sent. Create a link and send it to them by WhatsApp/DM.' }),
      d.resetRequests.map(r => { return h('div', { class: 'urow open' }, h('div', { class: 'uhead' }, h('div', null, h('div', { class: 'uname', text: r.name }), h('div', { class: 'umail', text: r.email }), h('div', { class: 'umail', text: when(r.at) + ' · ' + (r.detail || r.status) })), h('button', { class: 'primary-btn', type: 'button', text: 'Create reset link', onclick: () => makeLink({ id: r.userId }) }))); }));
  }

  function render() {
    const d = state.data; if (!d) return;
    const k = d.kpi, fails = k.runsFailed + k.uploadFailures, label = { 1: 'Last 24 hours', 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days' }[d.days];
    const range = h('div', { class: 'adm-range' }, [[1, '24 h'], [7, '7 days'], [30, '30 days'], [90, '90 days']].map(([v, t]) => h('button', { type: 'button', class: state.days === v ? 'on' : '', text: t, onclick: () => { state.days = v; load(); } })));
    const auto = h('input', { type: 'checkbox', checked: state.auto }); auto.addEventListener('change', () => setAuto(auto.checked));
    const keep = window.scrollY;
    const parts = [
      h('div', { class: 'adm-bar' }, h('div', null, h('div', { class: 'eyebrow', text: 'OWNER DASHBOARD · ' + label.toUpperCase() }), h('h1', { text: 'How Vidora is doing' })), range),
      h('div', { class: 'adm-meta' }, h('button', { class: 'outline-btn', type: 'button', text: '↻ Refresh', onclick: () => load() }), h('label', null, auto, 'Auto-refresh 60s'), h('span', { text: 'Updated ' + when(d.generatedAt) + ' IST' })),
      h('div', { class: 'kpis' },
        kpi('Total users', num(k.totalUsers), '+' + num(k.newUsers) + ' new (' + num(k.newUsers24h) + ' in 24h)'),
        kpi('Active users', num(k.activeUsers), 'did something'),
        kpi('Sign-ins', num(k.signIns), num(k.signInUsers) + ' different people'),
        kpi('Failed sign-ins', num(k.failedSignIns), 'wrong password/email', k.failedSignIns > 10 ? 'warn' : ''),
        kpi('Uploads', num(k.uploads), bytes(k.uploadBytes) + ' total'),
        kpi('Tool runs', num(k.runs), k.successRate === null ? 'no runs yet' : k.successRate + '% successful', k.successRate !== null && k.successRate < 70 ? 'warn' : 'good'),
        kpi('Failures', num(fails), num(k.runsFailed) + ' tool + ' + num(k.uploadFailures) + ' upload', fails ? 'bad' : 'good'),
        kpi('Open reports', num(k.openReports), num(k.openHigh) + ' high priority', k.openHigh ? 'bad' : k.openReports ? 'warn' : 'good')),
      h('section', { class: 'adm-card' }, h('h2', { text: 'Activity' }), h('p', { class: 'hint', text: 'Tap or hover a bar to see the numbers for that day.' }), chart(d.series, d.unit)),
      lifetimeSection(d), generatedSection(), resetSection(d), reportsSection(d), errorsSection(d), toolsSection(d), usersSection(d), systemSection(d)];
    app.replaceChildren(...parts.filter(Boolean));
    window.scrollTo(0, keep);
  }

  boot();
})();
