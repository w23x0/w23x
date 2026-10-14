// v4: the persona copies how he types — verbatim samples, IM-shaped replies, resettable chat session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createApp, SESSION_START_FILE, splitParagraphs } from '../dist/app.js';
import { BASE_SYSTEM_PROMPT, OBSERVER_SYSTEM_PROMPT, collectVoiceSamples } from '../dist/agent/avatar.js';
import { appendRaw } from '../dist/data/raw.js';
import { tmpDataDir, fauxModel, mockAdapter, baseConfig, inbound, say, txt, ALLOWED_TG } from './helpers.mjs';

function makeApp(brain, dataDir = tmpDataDir()) {
  const primary = fauxModel(brain);
  const tg = mockAdapter('telegram');
  const app = createApp({ config: baseConfig(dataDir), models: { primary, reflection: primary }, adapters: [tg] });
  return { app, tg, primary, dataDir };
}

test('prompts: persona has IM reply rules; observer is told how to shape persona.md', () => {
  assert.ok(BASE_SYSTEM_PROMPT.includes('不分段'));
  assert.ok(BASE_SYSTEM_PROMPT.includes('他打字的样子'));
  assert.ok(OBSERVER_SYSTEM_PROMPT.includes('表层书写'));
});

test('voice samples: his own messages from every channel, verbatim, deduped, no placeholders, no other roles', () => {
  const dataDir = tmpDataDir();
  const t = Date.now() - 10_000;
  appendRaw(dataDir, { ts: t, channel: 'import', userId: 'import', role: 'import', text: 'IMPORTED_ESSAY' });
  appendRaw(dataDir, { ts: t + 1, channel: 'cli', userId: 'local', role: 'user', text: '样本一 空格断句 没有标点' });
  appendRaw(dataDir, { ts: t + 2, channel: 'cli', userId: 'local', role: 'assistant', text: 'OBSERVER_Q' });
  appendRaw(dataDir, { ts: t + 3, channel: 'telegram', userId: ALLOWED_TG, role: 'user', text: '样本二' });
  appendRaw(dataDir, { ts: t + 4, channel: 'discord', userId: ALLOWED_TG, role: 'user', text: '样本二' });
  appendRaw(dataDir, { ts: t + 5, channel: 'telegram', userId: ALLOWED_TG, role: 'user', text: '[语音转写] 嗯' });
  appendRaw(dataDir, { ts: t + 6, channel: 'telegram', userId: ALLOWED_TG, role: 'assistant', text: 'AVATAR_REPLY' });
  assert.deepEqual(collectVoiceSamples(dataDir), ['样本一 空格断句 没有标点', '样本二']);
});

test('voice samples are bounded in size', () => {
  const dataDir = tmpDataDir();
  for (let i = 0; i < 200; i++) appendRaw(dataDir, { ts: Date.now() - 1000 + i, channel: 'telegram', userId: ALLOWED_TG, role: 'user', text: `第${i}条 ` + '字'.repeat(500) });
  const s = collectVoiceSamples(dataDir);
  assert.ok(s.length >= 1 && s.length <= 40);
  assert.ok(s.join('').length <= 3000 + 400);
  assert.ok(s[s.length - 1].startsWith('第199条'), 'newest kept');
});

test('chat: the system prompt carries his latest message as a typing sample', async () => {
  const { app, primary } = makeApp(() => say('嗯'));
  await app.handleInbound(inbound('样本三 空格断句'));
  const sys = primary.calls[0].sysText;
  assert.ok(sys.includes('[他打字的样子]'));
  assert.ok(sys.includes('- 样本三 空格断句'));
});

test('a reply with blank lines goes out as separate messages; raw keeps one record', async () => {
  assert.deepEqual(splitParagraphs('段一\n\n  段二 \n\n'), ['段一', '段二']);
  assert.deepEqual(splitParagraphs('一行\n第二行'), ['一行\n第二行']);
  const { app, tg } = makeApp(() => say('段一\n\n段二'));
  await app.handleInbound(inbound('问一句'));
  assert.deepEqual(tg.sent.map((m) => m.text), ['段一', '段二']);
});

test('session-start marker: chat history before it is not restored into the persona context', () => {
  const dataDir = tmpDataDir();
  const t = Date.now() - 100_000;
  appendRaw(dataDir, { ts: t, channel: 'telegram', userId: ALLOWED_TG, role: 'assistant', text: 'OLD_STYLE。\n\n很长' });
  mkdirSync(join(dataDir, 'state'), { recursive: true });
  writeFileSync(join(dataDir, 'state', SESSION_START_FILE), JSON.stringify({ ts: t + 10 }));
  appendRaw(dataDir, { ts: t + 20, channel: 'telegram', userId: ALLOWED_TG, role: 'user', text: 'NEW_MSG' });
  const { app } = makeApp(() => say('ok'), dataDir);
  const sess = app.sessionMessages().map(txt).join('\n');
  assert.ok(sess.includes('NEW_MSG'));
  assert.ok(!sess.includes('OLD_STYLE'));
});
