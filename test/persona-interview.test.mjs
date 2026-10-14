// v2: external persona (chat / proactive) vs local observer (reflection / interview).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../dist/app.js';
import { createInterview } from '../dist/interview.js';
import { BASE_SYSTEM_PROMPT, OBSERVER_SYSTEM_PROMPT, PERSONA_BRIEF_FILE } from '../dist/agent/avatar.js';
import { allRaw, appendRaw } from '../dist/data/raw.js';
import { readFileUnder, writeFileUnder, listFiles } from '../dist/data/understanding.js';
import { tmpDataDir, fauxModel, mockAdapter, baseConfig, inbound, say, call, sleep, txt, readJsonl, ALLOWED_TG } from './helpers.mjs';

function makeApp(brain, { dataDir = tmpDataDir(), reflectionBrain, cfg = {} } = {}) {
  const primary = fauxModel(brain);
  const reflection = reflectionBrain ? fauxModel(reflectionBrain, { id: 'reflector' }) : primary;
  const tg = mockAdapter('telegram');
  const app = createApp({ config: baseConfig(dataDir, cfg), models: { primary, reflection }, adapters: [tg] });
  return { app, tg, primary, reflection, dataDir };
}
function makeInterview(brain, { dataDir = tmpDataDir(), cfg = {} } = {}) {
  const primary = fauxModel(() => { throw new Error('interview must not use the primary model'); });
  const reflection = fauxModel(brain, { id: 'observer' });
  const iv = createInterview({ config: baseConfig(dataDir, cfg), models: { primary, reflection } });
  return { iv, reflection, dataDir };
}
const isProactive = (i) => i.tools.includes('send_message');

test('prompts: persona keeps the two required lines; observer is a separate prompt that names the brief file', () => {
  assert.equal(PERSONA_BRIEF_FILE, 'persona.md');
  assert.ok(BASE_SYSTEM_PROMPT.includes('你就是他。你的任务是越来越深刻地成为他，并陪伴他。'));
  assert.ok(typeof OBSERVER_SYSTEM_PROMPT === 'string' && OBSERVER_SYSTEM_PROMPT.length > 0);
  assert.ok(!OBSERVER_SYSTEM_PROMPT.includes('你就是他。'), 'observer does not play him');
  assert.ok(OBSERVER_SYSTEM_PROMPT.includes(PERSONA_BRIEF_FILE), 'observer knows it maintains the brief');
});

test('chat: persona.md is injected into the system prompt every turn and follows edits; other files are not', async () => {
  const dataDir = tmpDataDir();
  const { app, primary } = makeApp(() => say('嗯'), { dataDir });
  writeFileUnder(dataDir, 'persona.md', 'BRIEF_V1 说话很短');
  writeFileUnder(dataDir, 'agenda.md', 'AGENDA_SECRET 要问他的问题');
  await app.handleInbound(inbound('hi'));
  writeFileUnder(dataDir, 'persona.md', 'BRIEF_V2 爱用省略号');
  await app.handleInbound(inbound('again'));
  const [c1, c2] = [primary.calls[0], primary.calls[primary.calls.length - 1]];
  assert.ok(c1.sysText.includes('BRIEF_V1'), 'brief injected');
  assert.ok(c1.sysText.includes('你就是他'), 'persona prompt');
  assert.ok(c2.sysText.includes('BRIEF_V2') && !c2.sysText.includes('BRIEF_V1'), 'brief re-read each turn');
  for (const c of primary.calls) assert.ok(!c.msgs.some((m) => txt(m).includes('AGENDA_SECRET')), 'only the brief is preloaded');
});

test('chat: missing persona.md does not break the turn; an oversized brief is truncated to personaBriefMaxChars', async () => {
  const d1 = tmpDataDir();
  const a = makeApp(() => say('ok'), { dataDir: d1 });
  await a.app.handleInbound(inbound('hi'));
  assert.equal(a.tg.sent[0].text, 'ok');

  const d2 = tmpDataDir();
  const b = makeApp(() => say('ok'), { dataDir: d2, cfg: { personaBriefMaxChars: 500 } });
  writeFileUnder(d2, 'persona.md', 'HEAD' + '长'.repeat(5000) + 'TAILMARK');
  await b.app.handleInbound(inbound('hi'));
  const sys = b.primary.calls[0].sysText;
  assert.ok(sys.includes('HEAD') && !sys.includes('TAILMARK'));
  assert.ok((sys.match(/长/g) || []).length <= 500);
});

test('proactive: persona prompt with the brief, read-only understanding, no cold-start trigger', async () => {
  const dataDir = tmpDataDir();
  const seen = [];
  const { app } = makeApp((ctx, i) => { if (isProactive(i)) seen.push(i); return say('不发'); }, { dataDir });
  writeFileUnder(dataDir, 'persona.md', 'BRIEF_P');
  const d = await app.runProactiveWake('manual');
  assert.equal(d.trigger, 'manual');
  const i = seen[0];
  assert.ok(i.sysText.includes('你就是他') && i.sysText.includes('BRIEF_P'));
  assert.ok(i.tools.includes('read_understanding') && i.tools.includes('schedule_next_wake'));
  assert.ok(!i.tools.includes('write_understanding') && !i.tools.includes('delete_understanding'), `proactive tools: ${i.tools}`);
});

test('reflection runs as the observer with full understanding tools and is told about interview records', async () => {
  const dataDir = tmpDataDir();
  const seen = [];
  const { app } = makeApp(() => say('ok'), { dataDir, reflectionBrain: (ctx, i) => { seen.push(i); return say('done'); } });
  appendRaw(dataDir, { ts: Date.now(), channel: 'telegram', userId: ALLOWED_TG, role: 'user', text: '外部' });
  appendRaw(dataDir, { ts: Date.now(), channel: 'cli', userId: 'local', role: 'user', text: '访谈回答' });
  await app.runReflection();
  const i = seen[0];
  assert.ok(i.sysText.includes(PERSONA_BRIEF_FILE) && !i.sysText.includes('你就是他。'));
  assert.ok(i.tools.includes('write_understanding') && i.tools.includes('delete_understanding'));
  assert.ok(!i.tools.includes('send_message'));
  assert.match(i.userText, /interview|访谈|cli/i, 'reflection prompt mentions interview records');
});

test('interview: observer speaks first, every line is archived on channel cli, uses the reflection model', async () => {
  const prompts = [];
  const { iv, reflection, dataDir } = makeInterview((ctx, i) => {
    prompts.push(i);
    if (i.userText.includes('我喜欢爬山')) return i.results.length ? say('记下了') : call('write_understanding', { path: 'notes.md', content: '爬山' });
    return say('你最近在想什么？');
  });
  assert.equal(await iv.open(), '你最近在想什么？');
  assert.equal(await iv.reply('我喜欢爬山'), '记下了');
  const raw = allRaw(dataDir);
  assert.deepEqual(raw.map((m) => [m.channel, m.role, m.text]), [
    ['cli', 'assistant', '你最近在想什么？'],
    ['cli', 'user', '我喜欢爬山'],
    ['cli', 'assistant', '记下了'],
  ]);
  assert.equal(readFileUnder(dataDir, 'notes.md'), '爬山');
  const i = prompts[0];
  assert.ok(i.sysText.includes(PERSONA_BRIEF_FILE) && !i.sysText.includes('你就是他。'), 'observer prompt');
  assert.ok(!i.tools.includes('send_message') && !i.tools.includes('schedule_next_wake'));
  assert.ok(reflection.calls.length >= 3);
});

test('interview: first vs later sessions get different facts; understanding is never preloaded', async () => {
  const dataDir = tmpDataDir();
  const opens = [];
  const brain = (ctx, i) => { opens.push(i.userText); return say('开场'); };
  const a = makeInterview(brain, { dataDir });
  writeFileUnder(dataDir, 'agenda.md', 'AGENDA_MARK');
  await a.iv.open();
  await a.iv.reply('第一次');
  const b = makeInterview(brain, { dataDir });
  await b.iv.open();
  const first = opens[0]; const later = opens[opens.length - 1];
  assert.notEqual(first, later);
  assert.match(first, /\d{4}-\d{2}-\d{2}/);
  for (const p of opens) assert.ok(!p.includes('AGENDA_MARK'));
});

test('interview close: wrap-up turn may write understanding; nothing said → no wrap-up, no model call', async () => {
  const { iv, reflection, dataDir } = makeInterview((ctx, i) => {
    if (i.userText.includes('XYZ-ANSWER')) return say('好');
    if (reflection.calls.length > 2 && i.results.length === 0) return call('write_understanding', { path: 'persona.md', content: 'WRAPPED' });
    return say('开场');
  });
  await iv.open();
  await iv.reply('XYZ-ANSWER');
  const before = reflection.calls.length;
  assert.deepEqual(await iv.close(), { wrappedUp: true });
  assert.ok(reflection.calls.length > before);
  assert.equal(readFileUnder(dataDir, 'persona.md'), 'WRAPPED');

  const e = makeInterview(() => say('开场'));
  await e.iv.open();
  const n = e.reflection.calls.length;
  assert.deepEqual(await e.iv.close(), { wrappedUp: false });
  assert.equal(e.reflection.calls.length, n);
});

test('interview: model error throws, leaves no assistant record, and the session recovers', async () => {
  let fail = false;
  const { iv, dataDir } = makeInterview((ctx, i) => {
    if (fail) throw new Error('upstream 500');
    return say(i.userText.includes('再来') ? '恢复了' : '开场');
  });
  await iv.open();
  fail = true;
  await assert.rejects(iv.reply('这条会失败'));
  assert.deepEqual(allRaw(dataDir).map((m) => m.role), ['assistant', 'user']);
  fail = false;
  assert.equal(await iv.reply('再来'), '恢复了');
});

test('interview records stay out of the external persona: not restored into chat, not counted as replies to outreach', async () => {
  const dataDir = tmpDataDir();
  appendRaw(dataDir, { ts: Date.now() - 7200_000, channel: 'telegram', userId: ALLOWED_TG, role: 'proactive', text: 'OUTREACH_X' });
  appendRaw(dataDir, { ts: Date.now() - 3600_000, channel: 'cli', userId: 'local', role: 'user', text: 'CLI_ANSWER' });
  appendRaw(dataDir, { ts: Date.now() - 3500_000, channel: 'cli', userId: 'local', role: 'assistant', text: 'CLI_QUESTION' });
  const prompts = [];
  const { app } = makeApp((ctx, i) => { if (isProactive(i)) prompts.push(i.userText); return say('ok'); }, { dataDir });
  const all = app.sessionMessages();
  const sess = all.filter((m) => m.role !== 'system').map(txt).join('\n');
  assert.ok(sess.includes('OUTREACH_X'));
  assert.ok(!sess.includes('CLI_ANSWER') && !sess.includes('CLI_QUESTION'), 'interview turns are not chat history');
  // his own interview lines may appear only as verbatim typing samples; the observer's questions never do
  assert.ok(!all.map(txt).join('\n').includes('CLI_QUESTION'));
  await app.runProactiveWake('manual');
  const line = prompts[0].split('\n').find((l) => l.includes('OUTREACH_X'));
  assert.ok(line && !/\d+\s*分钟后回复/.test(line), `outreach must not count the cli answer as a reply: ${line}`);
});
