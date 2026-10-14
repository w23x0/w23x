import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { tmpDataDir, sleep } from './helpers.mjs';
const ch = async () => ({ ...(await import('../dist/channels/telegram.js')), ...(await import('../dist/channels/discord.js')) });
import { ensureDataDirs } from '../dist/data/store.js';
import { ensureUnderstandingRepo, writeFileUnder, readFileUnder } from '../dist/data/understanding.js';
import { appendRaw, allRaw } from '../dist/data/raw.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('adapters fail closed without an allowed user id', async () => {
  const { TelegramAdapter, DiscordAdapter } = await ch();
  assert.throws(() => new TelegramAdapter('123:fake'));
  assert.throws(() => new TelegramAdapter('123:fake', ''));
  assert.throws(() => new DiscordAdapter('fake-token'));
});

test('discord client is configured to receive DMs (Partials.Channel)', () => {
  const src = readFileSync(join(ROOT, 'dist', 'channels', 'discord.js'), 'utf8');
  assert.match(src, /Partials\.Channel/);
  assert.match(src, /DirectMessages/);
});

async function telegramWithStubs() {
  const { TelegramAdapter } = await ch();
  const a = new TelegramAdapter('123:fake', '424242');
  const bot = Object.values(a).find((v) => v && typeof v === 'object' && v.telegram && typeof v.handleUpdate === 'function');
  assert.ok(bot, 'adapter holds a Telegraf instance');
  const sent = [];
  bot.telegram.sendMessage = async (chatId, text) => { sent.push({ chatId: String(chatId), text }); return {}; };
  bot.telegram.callApi = async (method, payload) => { sent.push({ method, payload }); return {}; };
  bot.launch = async () => {};
  bot.botInfo = { id: 1, is_bot: true, first_name: 'b', username: 'b' };
  return { a, bot, sent };
}

test('telegram: long replies are split under 4096 chars without losing content', async () => {
  const { a, sent } = await telegramWithStubs();
  const text = Array.from({ length: 300 }, (_, i) => `第${i}行：` + '字'.repeat(25)).join('\n');
  await a.send('424242', text);
  const parts = sent.map((s) => s.text ?? s.payload?.text);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 4096));
  assert.equal(parts.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
});

test('telegram: only private chats from the allowed user reach the handler', async () => {
  const { a, bot } = await telegramWithStubs();
  const got = [];
  await a.start(async (m) => { got.push(m); });
  const upd = (id, fromId, chatType) => ({ update_id: id, message: { message_id: id, date: 1, text: 'hi' + id,
    from: { id: fromId, is_bot: false, first_name: 'x' }, chat: { id: chatType === 'private' ? fromId : -100, type: chatType } } });
  await bot.handleUpdate(upd(1, 424242, 'private'));
  await bot.handleUpdate(upd(2, 999, 'private'));
  await bot.handleUpdate(upd(3, 424242, 'group'));
  assert.deepEqual(got.map((m) => m.text), ['hi1']);
  assert.equal(got[0].userId, '424242');
  await a.stop().catch(() => {});
});

test('encrypted backup round-trips, hides plaintext, rejects wrong passphrase and tampering', async () => {
  const { createEncryptedBackup, restoreBackup } = await import('../dist/backup.js');
  const d = tmpDataDir();
  ensureDataDirs(d); ensureUnderstandingRepo(d);
  writeFileUnder(d, 'self.md', 'PLAINTEXT_MARKER 他害怕冲突');
  appendRaw(d, { ts: Date.now(), channel: 'telegram', userId: 'u', role: 'user', text: 'RAW_MARKER' });
  const out = mkdtempSync(join(tmpdir(), 'avatar-bk-'));
  const file = createEncryptedBackup(d, out, 'correct horse');
  const buf = readFileSync(file);
  assert.equal(buf.subarray(0, 5).toString(), 'AVBK1');
  assert.ok(!buf.includes(Buffer.from('PLAINTEXT_MARKER')) && !buf.includes(Buffer.from('RAW_MARKER')));

  const target = join(mkdtempSync(join(tmpdir(), 'avatar-rs-')), 'restored');
  restoreBackup(file, target, 'correct horse');
  assert.equal(readFileUnder(target, 'self.md'), 'PLAINTEXT_MARKER 他害怕冲突');
  assert.equal(allRaw(target)[0].text, 'RAW_MARKER');
  assert.ok(existsSync(join(target, 'understanding', '.git', 'HEAD')), 'git history included');

  const t2 = join(mkdtempSync(join(tmpdir(), 'avatar-rs-')), 'x');
  assert.throws(() => restoreBackup(file, t2, 'wrong'));
  assert.ok(!existsSync(t2) || readdirSync(t2).length === 0, 'nothing written on wrong passphrase');
  const tampered = Buffer.from(buf); tampered[tampered.length - 5] ^= 0xff;
  const tf = join(out, 'tampered.bin'); writeFileSync(tf, tampered);
  assert.throws(() => restoreBackup(tf, join(out, 't3'), 'correct horse'));
});

function cli(args, env) {
  return spawnSync('node', [join(ROOT, 'dist', 'index.js'), ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15000 });
}

test('CLI: commands never build models or adapters; rollback leaves raw intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avatar-cli-'));
  const d = join(dir, 'data');
  ensureDataDirs(d); ensureUnderstandingRepo(d);
  writeFileUnder(d, 'a.md', 'v1');
  const first = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(d, 'understanding') }).toString().trim();
  writeFileUnder(d, 'a.md', 'v2');
  appendRaw(d, { ts: Date.now(), channel: 'telegram', userId: 'u', role: 'user', text: 'keep me' });
  const cfg = join(dir, 'avatar.config.json');
  // A model that cannot be resolved, and a Discord token that would hit the network if an adapter were built.
  writeFileSync(cfg, JSON.stringify({ dataDir: d, model: { provider: 'no-such-provider', id: 'no-such-model' },
    discordToken: 'fake', allowedDiscordUserId: '1', telegramToken: '1:fake', allowedTelegramUserId: '1' }));
  const env = { AVATAR_CONFIG: cfg };

  const h = cli(['history'], env);
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /[0-9a-f]{7}/);
  const v = cli(['view'], env);
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /v2/);
  const s = cli(['search', 'keep'], env);
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /keep me/);
  const r = cli(['rollback', first], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileUnder(d, 'a.md'), 'v1');
  assert.deepEqual(allRaw(d).map((m) => m.text), ['keep me']);
  for (const out of [h, v, s, r]) assert.doesNotMatch(out.stdout + out.stderr, /TokenInvalid|model not found|no-such-model/i);
});
