'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mailer = require('../mailer');

test('parseFrom handles plain and named senders', () => {
  assert.deepEqual(mailer.parseFrom('me@gmail.com'), { name: 'Vidora AI', email: 'me@gmail.com' });
  assert.deepEqual(mailer.parseFrom('Vidora Team <me@gmail.com>'), { name: 'Vidora Team', email: 'me@gmail.com' });
});

test('provider selection and Brevo request shape', async () => {
  for (const k of ['BREVO_API_KEY', 'MAIL_FROM', 'RESEND_API_KEY', 'RESEND_FROM']) delete process.env[k];
  assert.equal(mailer.isConfigured(), false);
  await assert.rejects(mailer.sendMail({ to: 'a@b.co', subject: 's', html: 'h' }), /not configured/);
  process.env.BREVO_API_KEY = 'k'; process.env.MAIL_FROM = 'Vidora <me@gmail.com>';
  assert.equal(mailer.provider(), 'brevo');
  const real = global.fetch; let seen;
  global.fetch = async (url, opts) => { seen = { url, opts }; return { ok: true, text: async () => '' }; };
  try {
    await mailer.sendMail({ to: 'u@gmail.com', subject: 'Hi', html: '<p>x</p>', text: 'x' });
    assert.equal(seen.url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(seen.opts.headers['api-key'], 'k');
    const body = JSON.parse(seen.opts.body);
    assert.deepEqual(body.sender, { name: 'Vidora', email: 'me@gmail.com' });
    assert.deepEqual(body.to, [{ email: 'u@gmail.com' }]);
    global.fetch = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
    await assert.rejects(mailer.sendMail({ to: 'u@gmail.com', subject: 'Hi', html: 'x' }), /brevo rejected.*401/);
  } finally { global.fetch = real; delete process.env.BREVO_API_KEY; delete process.env.MAIL_FROM; }
});
