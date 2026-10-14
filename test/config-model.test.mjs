import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { tmpDataDir } from './helpers.mjs';
import { loadConfig } from '../dist/config.js';
import { makeModelsForSpecs } from '../dist/model.js';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

function withFakeHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'avatar-home-'));
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(join(home, '.pi', 'agent', 'models.json'), JSON.stringify({
    providers: { evil: { baseUrl: 'http://pi.invalid', apiKey: 'sk-from-pi', models: [{ id: 'pi-model' }] } },
  }));
  const old = process.env.HOME;
  process.env.HOME = home;
  try { return fn(home); } finally { process.env.HOME = old; }
}

test('no model configured → throws, never falls back to ~/.pi or a default model', () => {
  withFakeHome((home) => {
    const env = { HOME: home, AVATAR_DATA_DIR: tmpDataDir() };
    assert.throws(() => loadConfig({ configPath: join(home, 'missing.json'), env }));
  });
});

test('config.json inside the data dir is refused', () => {
  const d = tmpDataDir();
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'config.json'), '{"model":{"id":"x"}}');
  assert.throws(() => loadConfig({ configPath: join(d, '..', 'none.json'), env: { AVATAR_DATA_DIR: d, AVATAR_MODEL: 'x' } }));
});

test('config file + env overrides + defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avatar-cfg-'));
  const cfgPath = join(dir, 'avatar.config.json');
  writeFileSync(cfgPath, JSON.stringify({ dataDir: join(dir, 'data'), model: { id: 'm1', baseUrl: 'http://x.invalid' } }));
  const c = loadConfig({ configPath: cfgPath, env: { TELEGRAM_ALLOWED_USER_ID: '7' } });
  assert.equal(c.model.id, 'm1');
  assert.equal(c.allowedTelegramUserId, '7');
  assert.equal(c.idleMinutes, 15);
  assert.equal(c.proactiveFallbackMinutes, 180);
  assert.equal(c.proactiveMinMinutes, 10);
  const c2 = loadConfig({ configPath: cfgPath, env: { AVATAR_MODEL: 'm2' } });
  assert.equal(c2.model.id, 'm2');
});

test('primary and reflection keep separate API keys and never touch process.env', async () => {
  const before = JSON.stringify(process.env);
  const { primary, reflection } = await makeModelsForSpecs(
    { provider: 'p1', id: 'a', baseUrl: 'http://opencode.invalid/v1', apiKey: 'key-1', api: 'openai-completions' },
    { provider: 'p2', id: 'b', baseUrl: 'http://other.invalid/v1', apiKey: 'key-2', api: 'openai-completions' },
  );
  assert.equal(JSON.stringify(process.env), before, 'process.env must not be modified');
  assert.equal(await primary.getApiKey('p1'), 'key-1');
  assert.equal(await reflection.getApiKey('p2'), 'key-2');
  assert.equal(primary.model.headers, undefined, 'no provider-specific header hardcoding');
  assert.notEqual(primary.model.id, reflection.model.id);
});

test('compiled code has no Pi CLI config coupling or provider hardcoding', () => {
  const offenders = [];
  const walk = (d) => readdirSync(d).forEach((f) => {
    const p = join(d, f);
    if (statSync(p).isDirectory()) return walk(p);
    if (!p.endsWith('.js')) return;
    const s = readFileSync(p, 'utf8');
    for (const pat of ['.pi/agent', 'models.json', 'opencode', 'gpt-4o', 'process.env.AVATAR_API_KEY =']) if (s.includes(pat)) offenders.push(`${f}: ${pat}`);
  });
  walk(DIST);
  assert.deepEqual(offenders, []);
});

test('system prompt contains the two required lines verbatim', async () => {
  const { BASE_SYSTEM_PROMPT } = await import('../dist/agent/avatar.js');
  assert.ok(BASE_SYSTEM_PROMPT.includes('你就是他。你的任务是越来越深刻地成为他，并陪伴他。'));
  assert.ok(BASE_SYSTEM_PROMPT.includes('你是他，但你会说出他自己回避的话，不一味附和。'));
});
