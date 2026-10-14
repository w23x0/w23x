import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createApp } from '../dist/app.js';
import { createInterview } from '../dist/interview.js';
import { allRaw, appendRaw } from '../dist/data/raw.js';
import { readFileUnder, writeFileUnder } from '../dist/data/understanding.js';
import { tmpDataDir, fauxModel, mockAdapter, baseConfig, inbound, say, call, sleep, txt, ALLOWED_TG } from './helpers.mjs';

function makeApp(brain, { dataDir = tmpDataDir(), reflectionBrain, modelOpts, cfg = {} } = {}) {
  const primary = fauxModel(brain, modelOpts);
  const reflection = reflectionBrain ? fauxModel(reflectionBrain, { id: 'reflector' }) : primary;
  const tg = mockAdapter('telegram');
  const app = createApp({ config: baseConfig(dataDir, cfg), models: { primary, reflection }, adapters: [tg] });
  return { app, tg, primary, reflection, dataDir };
}

test('concurrent inbound messages are queued and all answered in order', async () => {
  const { app, tg, primary, dataDir } = makeApp(async (ctx, i) => { await sleep(300); return say('re:' + i.userText.slice(-3)); });
  await Promise.all([app.handleInbound(inbound('第一条AAA')), sleep(50).then(() => app.handleInbound(inbound('第二条BBB')))]);
  assert.deepEqual(tg.sent.map((s) => s.text), ['re:AAA', 're:BBB']);
  assert.ok(tg.sent.every((s) => s.chatId === ALLOWED_TG));
  const second = primary.calls[primary.calls.length - 1];
  assert.ok(second.msgs.some((m) => txt(m).includes('第一条AAA')), 'second turn sees the first exchange');
  assert.deepEqual(allRaw(dataDir).map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
});

test('user text reaches the agent with time + channel metadata; raw keeps the original text', async () => {
  const { app, primary, dataDir } = makeApp(() => say('ok'));
  await app.handleInbound(inbound('原文XYZ'));
  const seen = primary.calls[0].userText;
  assert.match(seen, /\d{4}-\d{2}-\d{2}/);
  assert.match(seen, /telegram/);
  assert.match(seen, /原文XYZ/);
  assert.equal(allRaw(dataDir)[0].text, '原文XYZ');
});

test('session is restored from raw after restart, including proactive messages', async () => {
  const dataDir = tmpDataDir();
  const a1 = makeApp(() => say('我记得你叫小王'), { dataDir });
  await a1.app.handleInbound(inbound('我叫小王'));
  appendRaw(dataDir, { ts: Date.now(), channel: 'telegram', userId: ALLOWED_TG, role: 'proactive', text: '最近怎么样PROACTIVE1' });
  const a2 = makeApp(() => say('ok'), { dataDir });
  const texts = a2.app.sessionMessages().map(txt);
  assert.ok(texts.some((t) => t.includes('我叫小王')));
  assert.ok(texts.some((t) => t.includes('我记得你叫小王')));
  assert.ok(texts.some((t) => t.includes('[主动消息]') && t.includes('PROACTIVE1')));
  await a2.app.handleInbound(inbound('还记得我吗'));
  assert.ok(a2.primary.calls[0].msgs.some((m) => txt(m).includes('我叫小王')), 'restored history is sent to the model');
  assert.equal(a2.primary.calls[0].msgs[0].role, 'system');
  assert.ok(a2.primary.calls[0].sysText.includes('你就是他'), 'identity system prompt survives restore');
  assert.ok(a2.primary.calls[0].tools.includes('read_understanding'), 'tools survive restore');
  assert.equal(a2.app.sessionMessages()[0].role, 'system');
});

test('context stays within budget, system message kept, tool call/result pairs never split', async () => {
  const contextWindow = 3000; // tokens
  const { app, primary } = makeApp((ctx, i) => {
    if (i.last.role === 'user' && i.userText.includes('写文件')) return call('read_raw', { from_end: true, limit: 1 });
    return say('好'.repeat(300));
  }, { modelOpts: { contextWindow } });
  for (let k = 0; k < 40; k++) await app.handleInbound(inbound((k % 3 === 0 ? '写文件 ' : '') + '内容'.repeat(400) + k));
  for (const c of primary.calls) {
    const chars = c.msgs.reduce((n, m) => n + JSON.stringify(m.content ?? '').length, 0);
    // Chinese text is roughly 1 token per character, so CJK characters alone must fit in the window.
    const cjk = c.msgs.reduce((n, m) => n + (JSON.stringify(m.content ?? '').match(/[\u4e00-\u9fff]/g) || []).length, 0);
    assert.ok(cjk < contextWindow, `context has ${cjk} CJK chars for a ${contextWindow}-token window`);
    assert.ok(c.sysText.includes('你就是他'), 'system prompt kept');
    assert.equal(c.msgs[0].role, 'system');
    const callIds = new Set(c.msgs.filter((m) => m.role === 'assistant').flatMap((m) => m.content.filter((x) => x.type === 'toolCall').map((x) => x.id)));
    for (const r of c.msgs.filter((m) => m.role === 'toolResult')) assert.ok(callIds.has(r.toolCallId), 'orphan toolResult');
  }
  const lastCall = primary.calls[primary.calls.length - 1];
  assert.ok(lastCall.msgs.some((m) => txt(m).includes('39')), 'latest message present');
  assert.ok(!lastCall.msgs.some((m) => m.role === 'user' && /内容(内容)*0$/.test(txt(m))), 'oldest message trimmed');
});

test('model error: no empty assistant record, user gets a notice, session rolled back', async () => {
  let fail = true;
  const { app, tg, dataDir } = makeApp(() => { if (fail) throw new Error('upstream 500'); return say('恢复了'); });
  await app.handleInbound(inbound('这条会失败'));
  assert.equal(tg.sent.length, 1);
  assert.ok(tg.sent[0].text.trim().length > 0, 'a non-empty notice is sent');
  assert.deepEqual(allRaw(dataDir).map((m) => m.role), ['user'], 'no assistant record for a failed turn');
  assert.ok(!app.sessionMessages().some((m) => m.stopReason === 'error'));
  fail = false;
  await app.handleInbound(inbound('再来'));
  assert.equal(tg.sent[1].text, '恢复了');
});

test('stale write is rejected: reflection cannot overwrite what the interview just wrote', async () => {
  const dataDir = tmpDataDir();
  let release; const gate = new Promise((r) => { release = r; });
  const results = [];
  const interviewer = fauxModel((ctx, i) => {
    if (i.userText.includes('v1')) return i.results.length ? say('ok') : call('write_understanding', { path: 'u.md', content: 'v1' });
    if (i.userText.includes('clarify')) {
      if (i.results.length === 0) return call('read_understanding', { path: 'u.md' });
      if (i.results.length === 1) return call('write_understanding', { path: 'u.md', content: 'INTERVIEW-v2' });
      return say('ok');
    }
    return say('你好');
  }, { id: 'interviewer' });
  const reflector = async (ctx, i) => {
    if (i.results.length === 0) return call('read_understanding', { path: 'u.md' });
    if (i.results.length === 1) { await gate; return call('write_understanding', { path: 'u.md', content: txt(i.results[0]) + '\nREFLECTION-stale' }); }
    results.push(i.results[1]);
    return say('done');
  };
  const { app, primary } = makeApp(() => say('ok'), { dataDir, reflectionBrain: reflector });
  const iv = createInterview({ config: baseConfig(dataDir), models: { primary, reflection: interviewer } });
  await iv.open();
  await iv.reply('write v1');
  const refl = app.runReflection();
  await sleep(200);
  await iv.reply('clarify');
  release();
  await refl;
  assert.equal(readFileUnder(dataDir, 'u.md'), 'INTERVIEW-v2');
  assert.equal(results[0].isError, true, 'stale write must return an error tool result');
});

test('writing an existing file without reading it first is rejected; new files are fine', async () => {
  const dataDir = tmpDataDir();
  const seen = [];
  const { app } = makeApp(() => say('ok'), { dataDir, reflectionBrain: (ctx, i) => {
    if (i.results.length === 0) return call('write_understanding', { path: 'exists.md', content: 'blind' });
    if (i.results.length === 1) { seen.push(i.results[0]); return call('write_understanding', { path: 'fresh.md', content: 'new' }); }
    seen.push(i.results[1]);
    return say('ok');
  } });
  // createApp ran ensureDataDirs/ensureUnderstandingRepo; seed a file as if the user edited it
  writeFileUnder(dataDir, 'exists.md', 'user wrote this');
  appendRaw(dataDir, { ts: Date.now(), channel: 'telegram', userId: ALLOWED_TG, role: 'user', text: 'something new' });
  await app.runReflection();
  assert.equal(seen[0].isError, true);
  assert.equal(seen[1].isError, false);
  assert.equal(readFileUnder(dataDir, 'exists.md'), 'user wrote this');
});

test('online agent reads but never writes the understanding layer, and has no send_message / schedule_next_wake', async () => {
  const { app, primary } = makeApp(() => say('ok'));
  await app.handleInbound(inbound('hi'));
  const tools = primary.calls[0].tools;
  assert.ok(tools.includes('read_understanding') && tools.includes('list_understanding') && tools.includes('read_raw') && tools.includes('search_raw'));
  assert.ok(!tools.includes('write_understanding') && !tools.includes('delete_understanding'), `online tools: ${tools}`);
  assert.ok(!tools.includes('send_message') && !tools.includes('schedule_next_wake'));
});

test('images: stored in raw/media and passed to an image-capable model; noted for text-only models', async () => {
  const png = Buffer.from('fake-png-bytes').toString('base64');
  const vis = makeApp(() => say('看到了'), { modelOpts: { input: ['text', 'image'] } });
  await vis.app.handleInbound(inbound('看这个', { images: [{ mimeType: 'image/png', data: png }] }));
  const content = vis.primary.calls[0].lastUser.content;
  assert.ok(Array.isArray(content) && content.some((c) => c.type === 'image'), 'image block sent to model');
  const rec = allRaw(vis.dataDir)[0];
  assert.equal(rec.attachments?.[0]?.kind, 'image');
  assert.equal(readFileSync(join(vis.dataDir, 'raw', rec.attachments[0].file)).toString('base64'), png);

  const blind = makeApp(() => say('嗯'));
  await blind.app.handleInbound(inbound('看这个', { images: [{ mimeType: 'image/png', data: png }] }));
  const c2 = blind.primary.calls[0].lastUser.content;
  assert.ok(!(Array.isArray(c2) && c2.some((c) => c.type === 'image')));
  assert.match(txt(blind.primary.calls[0].lastUser), /图片/);
});

test('voice: transcribed via deps.transcribe, transcript stored, agent sees it; no transcriber → notice', async () => {
  const dataDir = tmpDataDir();
  const primary = fauxModel(() => say('听到了'));
  const tg = mockAdapter('telegram');
  const app = createApp({ config: baseConfig(dataDir), models: { primary, reflection: primary }, adapters: [tg],
    transcribe: async () => '我今天很累' });
  const ogg = Buffer.from('fake-ogg').toString('base64');
  await app.handleInbound(inbound('', { voice: { mimeType: 'audio/ogg', data: ogg } }));
  assert.match(txt(primary.calls[0].lastUser), /我今天很累/);
  const rec = allRaw(dataDir)[0];
  assert.equal(rec.attachments?.[0]?.kind, 'voice');
  assert.equal(rec.attachments[0].transcript, '我今天很累');

  const d2 = tmpDataDir();
  const p2 = fauxModel(() => say('?'));
  const tg2 = mockAdapter('telegram');
  const app2 = createApp({ config: baseConfig(d2), models: { primary: p2, reflection: p2 }, adapters: [tg2] });
  await app2.handleInbound(inbound('', { voice: { mimeType: 'audio/ogg', data: ogg } }));
  assert.ok(tg2.sent.length >= 1 && tg2.sent[0].text.length > 0, 'user is told voice cannot be transcribed');
  assert.equal(allRaw(d2)[0]?.attachments?.[0]?.kind, 'voice', 'voice original still archived');
});
