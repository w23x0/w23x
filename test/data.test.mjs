import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tmpDataDir } from './helpers.mjs';
import * as U from '../dist/data/understanding.js';
import * as R from '../dist/data/raw.js';
import { ensureDataDirs } from '../dist/data/store.js';

const git = (cwd, ...a) => execFileSync('git', a, { cwd }).toString();

function setup() {
  const d = tmpDataDir();
  ensureDataDirs(d);
  U.ensureUnderstandingRepo(d);
  return d;
}

test('git lives only inside understanding/, commits contain only understanding files', () => {
  const d = setup();
  R.appendRaw(d, { ts: Date.now(), channel: 'telegram', userId: 'u', role: 'user', text: 'hello' });
  U.writeFileUnder(d, 'notes/a.md', 'A');
  assert.equal(existsSync(join(d, '.git')), false, 'dataDir root must not be a git repo');
  assert.ok(existsSync(join(d, 'understanding', '.git')));
  const files = git(join(d, 'understanding'), 'ls-files').trim().split('\n');
  assert.deepEqual(files, ['notes/a.md']);
  assert.match(U.understandingHistory(d), /\S/);
});

test('path guard rejects traversal, .git, base itself and symlink escape', () => {
  const d = setup();
  writeFileSync(join(d, 'raw', 'victim.jsonl'), 'orig\n');
  const bad = ['../raw/victim.jsonl', '/etc/passwd', 'a/../../raw/victim.jsonl', '../understanding-evil/x',
    '.git/config', 'sub/.git/hooks/pre-commit', '', '.'];
  for (const p of bad) {
    assert.throws(() => U.writeFileUnder(d, p, 'pwn'), `write ${JSON.stringify(p)} must be rejected`);
  }
  assert.throws(() => U.readFileUnder(d, '../raw/victim.jsonl'));
  assert.throws(() => U.deleteFileUnder(d, '.git/HEAD'));
  symlinkSync(join(d, 'raw'), join(d, 'understanding', 'link'));
  assert.throws(() => U.writeFileUnder(d, 'link/victim.jsonl', 'pwn'), 'symlink escape must be rejected');
  assert.equal(readFileSync(join(d, 'raw', 'victim.jsonl'), 'utf8'), 'orig\n');
  U.writeFileUnder(d, 'ok/nested.md', 'fine');
  assert.equal(U.readFileUnder(d, 'ok/nested.md'), 'fine');
  assert.ok(!U.listFiles(d).some((f) => f.includes('.git')));
});

test('rollback restores understanding as a new commit and never touches raw/ or state/', () => {
  const d = setup();
  U.writeFileUnder(d, 'a.md', 'v1');
  const first = git(join(d, 'understanding'), 'rev-parse', 'HEAD').trim();
  R.appendRaw(d, { ts: Date.now(), channel: 't', userId: 'u', role: 'user', text: 'm1' });
  U.writeFileUnder(d, 'a.md', 'v2');
  U.writeFileUnder(d, 'b.md', 'new');
  R.appendRaw(d, { ts: Date.now(), channel: 't', userId: 'u', role: 'assistant', text: 'm2' });
  writeFileSync(join(d, 'state', 'reflection-cursor.json'), '{"count":2}');
  const commitsBefore = Number(git(join(d, 'understanding'), 'rev-list', '--count', 'HEAD'));

  U.rollbackUnderstanding(d, first);

  assert.equal(U.readFileUnder(d, 'a.md'), 'v1');
  assert.equal(existsSync(join(d, 'understanding', 'b.md')), false, 'files added after ref must be removed');
  assert.ok(Number(git(join(d, 'understanding'), 'rev-list', '--count', 'HEAD')) > commitsBefore, 'rollback must be a new commit');
  assert.deepEqual(R.allRaw(d).map((m) => m.text), ['m1', 'm2']);
  assert.equal(readFileSync(join(d, 'state', 'reflection-cursor.json'), 'utf8'), '{"count":2}');
});

test('raw: proactive role, paging, media never overwritten, no mutation API', () => {
  const d = setup();
  const base = Date.now();
  for (let i = 0; i < 5; i++) R.appendRaw(d, { ts: base + i, channel: 't', userId: 'u', role: i === 4 ? 'proactive' : 'user', text: 'm' + i });
  assert.equal(R.allRaw(d)[4].role, 'proactive');
  const p = R.readRaw(d, { offset: 1, limit: 2 });
  assert.equal(p.total, 5);
  assert.deepEqual(p.messages.map((m) => m.text), ['m1', 'm2']);
  const tail = R.readRaw(d, { fromEnd: true, limit: 2 });
  assert.deepEqual(tail.messages.map((m) => m.text), ['m3', 'm4']);
  assert.deepEqual(R.searchRaw(d, 'm3').map((m) => m.text), ['m3']);
  const f1 = R.saveRawMedia(d, Buffer.from('one'), 'jpg');
  const f2 = R.saveRawMedia(d, Buffer.from('two'), 'jpg');
  assert.notEqual(f1, f2);
  assert.equal(readFileSync(join(d, 'raw', f1), 'utf8'), 'one');
  const mutators = Object.keys(R).filter((k) => /delete|remove|rewrite|update|truncate|clear/i.test(k));
  assert.deepEqual(mutators, []);
});

test('contentHash is sha256 hex', () => {
  assert.match(U.contentHash('x'), /^[0-9a-f]{64}$/);
});
