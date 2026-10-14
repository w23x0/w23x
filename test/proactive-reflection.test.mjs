import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { createApp } from '../dist/app.js';
import { allRaw, appendRaw } from '../dist/data/raw.js';
import { writeFileUnder } from '../dist/data/understanding.js';
import { tmpDataDir, fauxModel, mockAdapter, baseConfig, inbound, say, call, sleep, txt, readJsonl, waitFor, ALLOWED_TG } from './helpers.mjs';

function makeApp(brain, { dataDir = tmpDataDir(), reflectionBrain, cfg = {} } = {}) {
  const primary = fauxModel(brain);
  const reflection = reflectionBrain ? fauxModel(reflectionBrain, { id: 'reflector' }) : primary;
  const tg = mockAdapter('telegram');
  const app = createApp({ config: baseConfig(dataDir, cfg), models: { primary, reflection }, adapters: [tg] });
  return { app, tg, primary, reflection, dataDir };
}
const isProactive = (i) => i.tools.includes('send_message');
const log = (d) => readJsonl(join(d, 'state', 'proactive-log.jsonl'));

test('a wake may decide to send nothing; decision is logged', async () => {
  const { app, tg, dataDir } = makeApp(() => say('现在不打扰他'));
  const d = await app.runProactiveWake('manual');
  assert.equal(d.sent, false);
  assert.equal(tg.sent.length, 0);
  assert.match(d.agentNote, /不打扰/);
  const l = log(dataDir);
  assert.equal(l.length, 1);
  assert.equal(l[0].sent, false);
  assert.equal(l[0].trigger, 'manual');
});

test('send_message reaches the user before any inbound (contact from config), is archived and injected into the session', async () => {
  const { app, tg, primary, dataDir } = makeApp((ctx, i) => {
    if (isProactive(i)) return i.results.length ? say('发了') : call('send_message', { text: '最近还好吗PING' });
    return say('嗯');
  });
  const d = await app.runProactiveWake('manual');
  assert.equal(d.sent, true);
  assert.deepEqual(d.texts, ['最近还好吗PING']);
  assert.deepEqual(tg.sent, [{ chatId: ALLOWED_TG, text: '最近还好吗PING' }]);
  const raw = allRaw(dataDir);
  assert.equal(raw.at(-1).role, 'proactive');
  assert.equal(raw.at(-1).text, '最近还好吗PING');
  assert.ok(app.sessionMessages().some((m) => m.role === 'assistant' && txt(m).includes('[主动消息]') && txt(m).includes('PING')));
  await app.handleInbound(inbound('还行吧'));
  const onlineCall = primary.calls.filter((c) => !isProactive(c)).at(-1);
  assert.ok(onlineCall.msgs.some((m) => txt(m).includes('PING')), 'online turn knows what was proactively asked');
  assert.equal(log(dataDir)[0].sent, true);
});

test('send_message takes no userId; reflection mode has neither send_message nor schedule_next_wake', async () => {
  const seen = {};
  const { app } = makeApp((ctx, i) => {
    if (isProactive(i)) {
      seen.proactive = i.sys.toolsAdded;
      return say('no');
    }
    return say('ok');
  }, { reflectionBrain: (ctx, i) => { seen.reflectionTools = i.tools; return say('done'); } });
  await app.runProactiveWake('manual');
  const sm = seen.proactive.find((t) => t.name === 'send_message');
  assert.ok(sm, 'send_message available in proactive mode');
  assert.ok(seen.proactive.some((t) => t.name === 'schedule_next_wake'));
  const props = Object.keys(sm.parameters?.properties ?? sm.inputSchema?.properties ?? {});
  assert.ok(props.includes('text') && !props.some((p) => /user/i.test(p)), `send_message params: ${props}`);
  await app.handleInbound(inbound('hi'));
  await app.runReflection();
  assert.ok(seen.reflectionTools.length > 0);
  assert.ok(!seen.reflectionTools.includes('send_message') && !seen.reflectionTools.includes('schedule_next_wake'));
});

test('schedule_next_wake is stored and clamped to the safety floor', async () => {
  const { app, dataDir } = makeApp((ctx, i) => i.results.length ? say('ok') : call('schedule_next_wake', { minutes: 1, reason: '他在忙' }));
  const t0 = Date.now();
  const d = await app.runProactiveWake('manual');
  const nw = JSON.parse(readFileSync(join(dataDir, 'state', 'next-wake.json'), 'utf8'));
  assert.ok(nw.at >= t0 + 10 * 60_000 - 1000, 'clamped to proactiveMinMinutes');
  assert.ok(nw.at < t0 + 11 * 60_000);
  assert.equal(d.nextWakeAt, nw.at);
});

test('wake prompt gives facts, does not preload understanding, and shows prior outreach', async () => {
  const dataDir = tmpDataDir();
  const prompts = [];
  const { app } = makeApp((ctx, i) => { if (isProactive(i)) prompts.push(i.userText); return say('no'); }, { dataDir });
  writeFileUnder(dataDir, 'secret-notes.md', 'MARKER_UNDERSTANDING_CONTENT');
  appendRaw(dataDir, { ts: Date.now() - 3600_000, channel: 'telegram', userId: ALLOWED_TG, role: 'proactive', text: '上次的问题OUTREACH1' });
  await app.runProactiveWake('manual');
  const p = prompts[0];
  assert.ok(!p.includes('MARKER_UNDERSTANDING_CONTENT'), 'understanding must be read by the agent via tools, not preloaded');
  assert.match(p, /telegram/);
  assert.match(p, /OUTREACH1/);
  assert.match(p, /\d{4}-\d{2}-\d{2}/);
});

test('single-flight proactive wake', async () => {
  const { app } = makeApp(async () => { await sleep(300); return say('no'); });
  const [a, b] = await Promise.all([app.runProactiveWake('manual'), app.runProactiveWake('manual')]);
  assert.equal([a, b].filter((d) => d.sent === false).length, 2);
  assert.ok(a.agentNote !== b.agentNote, 'second call reports it was skipped');
});

test('cold start: start() on an empty profile triggers one cold-start wake; not after conversations exist', async () => {
  const prompts = [];
  const { app, dataDir } = makeApp((ctx, i) => { if (isProactive(i)) prompts.push(i); return say('稍后'); });
  await app.start();
  try {
    assert.ok(await waitFor(() => log(dataDir).length > 0, 5000), 'cold-start wake happened');
    assert.equal(log(dataDir)[0].trigger, 'cold-start');
  } finally { await app.stop(); }

  const d2 = tmpDataDir();
  const p2 = [];
  const b = makeApp((ctx, i) => { if (isProactive(i)) p2.push(i); return say('x'); }, { dataDir: d2 });
  appendRaw(d2, { ts: Date.now(), channel: 'telegram', userId: ALLOWED_TG, role: 'user', text: '之前聊过' });
  await b.app.start();
  await sleep(1500);
  await b.app.stop();
  assert.equal(log(d2).filter((l) => l.trigger === 'cold-start').length, 0);
});

test('reflection: only with new messages, uses reflection model, pages instead of dumping, advances cursor', async () => {
  const reflPrompts = [];
  const { app, primary, reflection, dataDir } = makeApp(() => say('ok'), {
    reflectionBrain: (ctx, i) => { reflPrompts.push(i.userText); return say('reflected'); },
  });
  assert.equal((await app.runReflection()).ran, false);
  await app.handleInbound(inbound('REFLECT_MARKER_XYZ 我今天辞职了'));
  const r = await app.runReflection();
  assert.equal(r.ran, true);
  assert.equal(reflection.calls.length, 1, 'reflection runs on the reflection model');
  assert.equal(primary.calls.length, 1, 'primary model only served the online turn');
  assert.ok(!reflPrompts[0].includes('REFLECT_MARKER_XYZ'), 'new conversation must not be dumped into the prompt');
  assert.match(reflPrompts[0], /read_raw/);
  assert.equal((await app.runReflection()).ran, false, 'cursor advanced');
  assert.ok(existsSync(join(dataDir, 'state', 'reflection-cursor.json')));
});

test('reflection failure does not advance the cursor; concurrent reflection is single-flight', async () => {
  let fail = true;
  const { app } = makeApp(() => say('ok'), {
    reflectionBrain: async () => { await sleep(200); if (fail) throw new Error('boom'); return say('fine'); },
  });
  await app.handleInbound(inbound('something'));
  await app.runReflection();
  fail = false;
  const [a, b] = await Promise.all([app.runReflection(), app.runReflection()]);
  assert.equal([a, b].filter((x) => x.ran).length, 1, 'exactly one reflection runs; it re-covers the failed range');
});

test('an overdue wake fires once and then falls back to the normal schedule (no tight wake loop)', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const dataDir = tmpDataDir();
  let wakes = 0;
  const { app } = makeApp((ctx, i) => { if (isProactive(i)) wakes++; return say('不打扰'); }, { dataDir });
  appendRaw(dataDir, { ts: Date.now() - 86400_000, channel: 'telegram', userId: ALLOWED_TG, role: 'user', text: '早就聊过' });
  mkdirSync(join(dataDir, 'state'), { recursive: true });
  writeFileSync(join(dataDir, 'state', 'next-wake.json'), JSON.stringify({ at: Date.now() - 3600_000, reason: 'overdue' }));
  await app.start();
  await sleep(1500);
  await app.stop();
  assert.ok(wakes <= 1, `overdue wake must not loop: ${wakes} wakes in 1.5s`);
  const nw = JSON.parse(readFileSync(join(dataDir, 'state', 'next-wake.json'), 'utf8'));
  if (wakes === 1) assert.ok(nw.at > Date.now() + 60_000, 'after the wake, next wake is in the future');
});
