'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { explainError, makeTrack, EVENTS_SCHEMA } = require('../analytics');

test('explainError gives a cause and a fix for common failures', () => {
  assert.match(explainError('Failed to fetch').cause, /memory|restart/i);
  assert.match(explainError('AI Visual Change is not configured yet. Set HF_SPACE_URL').fix, /Environment|Instant look/i);
  assert.match(explainError('Free AI server failed or timed out (the free Space may be busy)').cause, /Space/i);
  assert.match(explainError('Video must be no longer than 300 seconds.').cause, /length|limit/i);
  assert.match(explainError('You already have a media job processing.').cause, /job/i);
  assert.match(explainError('something totally new').cause, /pakki nahi/i);
  assert.ok(explainError('').fix);
});

test('track never throws and sanitises its input', async () => {
  const calls = [];
  const all = [];
  const pool = { query: (sql, params) => { all.push([sql, params]); if (/INSERT INTO vidora_events/.test(sql)) calls.push(params); return Promise.resolve({}); } };
  const track = makeTrack(pool);
  track('login', { userId: '42', status: 'ok' });
  track('job', { userId: 'abc; DROP TABLE x', tool: 'x'.repeat(200), status: 'failed', detail: 'line1\n\n   line2 ' + 'z'.repeat(500), bytes: 12.7, ms: 'nope' });
  track('login_failed', {});
  assert.equal(calls[0][0], '42');
  assert.equal(calls[1][0], null);                 // non-numeric user ids are dropped, never inserted
  assert.equal(calls[1][2].length, 48);
  assert.ok(calls[1][4].length <= 300 && !/\n/.test(calls[1][4]));
  assert.equal(calls[1][5], 13);
  assert.equal(calls[1][6], null);
  assert.equal(calls[2][0], null);
  const failing = makeTrack({ query: () => Promise.reject(new Error('db down')) });
  assert.doesNotThrow(() => failing('login', { userId: 1 }));
  const throwing = makeTrack({ query: () => { throw new Error('sync boom'); } });
  assert.doesNotThrow(() => throwing('login', { userId: 1 }));
});

test('schema creates the events table and indexes', () => {
  assert.match(EVENTS_SCHEMA, /CREATE TABLE IF NOT EXISTS vidora_events/);
  assert.match(EVENTS_SCHEMA, /vidora_events_created_idx/);
});

test('lifetime counters and login_count are bumped by track', () => {
  const all = [];
  const track = makeTrack({ query: (sql, params) => { all.push([sql, params]); return Promise.resolve({}); } });
  track('login', { userId: 7, status: 'ok' });
  track('guest', { status: 'ok' });
  track('upload', { status: 'ok', bytes: 1000 });
  track('job', { status: 'failed' });
  const names = all.filter(([q]) => /vidora_counters/.test(q)).map(([, p]) => p[0]);
  assert.deepEqual(names, ['guest_visits', 'uploads', 'upload_bytes', 'runs_failed']);
  assert.ok(all.some(([q, p]) => /login_count=login_count\+1/.test(q) && p[0] === '7'));
});
