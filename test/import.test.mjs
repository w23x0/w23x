import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpDataDir, fauxModel, mockAdapter, baseConfig, inbound, say, call, txt, readJsonl, waitFor, ALLOWED_TG } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mods = async () => ({
  ...(await import('../dist/import.js')),
  ...(await import('../dist/data/raw.js')),
  ...(await import('../dist/app.js')),
  ...(await import('../dist/data/store.js')),
  ...(await import('../dist/data/understanding.js')),
});

// Synthetic transcript (no real user data): unlabeled turns, like a copy-paste from a chat UI.
const para = (i) => `第${i}段。我想追问：你觉得这件事和你小时候的经历有关吗？\n嗯 可能有关 我不太确定 SEEDMARK${i}`;
const SEED = Array.from({ length: 30 }, (_, i) => para(i) + '\n' + '补充说明'.repeat(40)).join('\n\n');

function setup(dataDir) { const m = dataDir; return m; }

test('importSeed archives the transcript verbatim as import records with source + date, chunked at paragraph boundaries', async () => {
  const { importSeed, allRaw, searchRaw, ensureDataDirs } = await mods();
  const d = tmpDataDir(); ensureDataDirs(d);
  const r = importSeed(d, { text: SEED, label: '与AI的自我探索对话A', date: '2026-09-01' });
  assert.equal(r.skipped, false);
  const recs = allRaw(d).filter((m) => m.role === 'import');
  assert.ok(recs.length >= 2, 'long transcript is split');
  assert.equal(r.imported, recs.length);
  assert.ok(recs.every((m) => m.text.length <= 4500));
  assert.equal(recs.map((m) => m.text).join('\n\n'), SEED, 'verbatim, split only at blank lines');
  for (const [i, m] of recs.entries()) {
    assert.equal(m.channel, 'import');
    assert.equal(m.source.kind, 'import');
    assert.equal(m.source.label, '与AI的自我探索对话A');
    assert.equal(m.source.date, '2026-09-01');
    assert.equal(m.source.part, i + 1);
    assert.equal(m.source.parts, recs.length);
    assert.match(m.source.hash, /^[0-9a-f]{64}$/);
  }
  assert.ok(searchRaw(d, 'SEEDMARK17').length === 1);
  const again = importSeed(d, { text: SEED, label: 'dup', date: '2026-09-01' });
  assert.equal(again.skipped, true);
  assert.equal(allRaw(d).filter((m) => m.role === 'import').length, recs.length, 'no duplicate import');
});

test('imports are not loaded into the online session, but the agent can search and read them', async () => {
  const { importSeed, createApp, ensureDataDirs } = await mods();
  const d = tmpDataDir(); ensureDataDirs(d);
  importSeed(d, { text: SEED, label: 'L', date: '2026-09-01' });
  const results = [];
  const primary = fauxModel((ctx, i) => {
    if (i.results.length === 0) return call('search_raw', { query: 'SEEDMARK5' });
    if (i.results.length === 1) { results.push(txt(i.results[0])); return say('找到了'); }
    return say('ok');
  });
  const app = createApp({ config: baseConfig(d), models: { primary, reflection: primary }, adapters: [mockAdapter()] });
  assert.ok(!app.sessionMessages().some((m) => txt(m).includes('SEEDMARK')), 'imports not resident in context');
  await app.handleInbound(inbound('我之前聊过什么'));
  assert.match(results[0], /SEEDMARK5/);
  assert.ok(results[0].length < 2500, 'search returns a snippet, not whole records');
  assert.match(results[0], /offset/i);
});

test('runSeedImport triggers one reflection immediately; prompt states facts about the import without dumping it', async () => {
  const { runSeedImport, readFileUnder, ensureDataDirs } = await mods();
  const d = tmpDataDir(); ensureDataDirs(d);
  const prompts = []; const readOut = [];
  const reflection = fauxModel((ctx, i) => {
    if (i.results.length === 0) { prompts.push(i.userText); return call('read_raw', { offset: 0, limit: 3 }); }
    if (i.results.length === 1) { readOut.push(txt(i.results[0])); return call('write_understanding', { path: 'seed-understanding.md', content: '初步理解（来自导入）' }); }
    return say('done');
  }, { id: 'reflector' });
  const primary = fauxModel(() => say('x'));
  const r = await runSeedImport({ config: baseConfig(d), models: { primary, reflection } }, { text: SEED, label: '自我探索A', date: '2026-09-01' });
  assert.ok(r.imported >= 2);
  assert.equal(r.reflection.ran, true);
  assert.equal(primary.calls.length, 0, 'only the reflection model is used');
  assert.match(prompts[0], /自我探索A/);
  assert.match(prompts[0], /2026-09-01/);
  assert.ok(!prompts[0].includes('SEEDMARK'), 'raw text not dumped into the prompt');
  assert.match(readOut[0], /SEEDMARK0/);
  assert.match(readOut[0], /自我探索A/, 'read_raw labels the import source');
  assert.equal(readFileUnder(d, 'seed-understanding.md'), '初步理解（来自导入）');
});

test('the first interview builds on imported seeds: told about the seed, not preloaded, runs on the reflection model', async () => {
  const { importSeed, ensureDataDirs, ensureUnderstandingRepo, writeFileUnder } = await mods();
  const { createInterview } = await import('../dist/interview.js');
  const d = tmpDataDir(); ensureDataDirs(d); ensureUnderstandingRepo(d);
  importSeed(d, { text: SEED, label: '自我探索A', date: '2026-09-01' });
  writeFileUnder(d, 'from-seed.md', '已有初步理解');
  const primary = fauxModel(() => { throw new Error('interview must not use the primary model'); });
  const prompts = [];
  const reflection = fauxModel((ctx, i) => { prompts.push(i.userText); return say('我们从哪里开始？'); }, { id: 'reflector' });
  const iv = createInterview({ config: baseConfig(d), models: { primary, reflection } });
  assert.equal(await iv.open(), '我们从哪里开始？');
  assert.match(prompts[0], /导入|import/i);
  assert.match(prompts[0], /自我探索A/);
  assert.ok(!prompts[0].includes('已有初步理解'), 'understanding content is read via tools, not preloaded');
});

test('no communication preferences or psychological conclusions are hardcoded', () => {
  const banned = ['先收集再分析', '问题简短', '回顾式', '即时感受', '理智化', '沉默'];
  const hits = [];
  const walk = (dir) => readdirSync(dir).forEach((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    const s = readFileSync(p, 'utf8');
    for (const b of banned) if (s.includes(b)) hits.push(`${f}: ${b}`);
  });
  walk(join(ROOT, 'src'));
  assert.deepEqual(hits, []);
});
