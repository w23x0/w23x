import { loadConfig } from './config.js';
import { ensureDataDirs } from './data/store.js';
import {
  ensureUnderstandingRepo,
  listFiles,
  readFileUnder,
  writeFileUnder,
  understandingHistory,
  rollbackUnderstanding,
  resolveUnderstandingPath,
} from './data/understanding.js';
import { searchRaw } from './data/raw.js';
import { TelegramAdapter } from './channels/telegram.js';
import { DiscordAdapter } from './channels/discord.js';
import type { ChannelAdapter } from './channels/types.js';
import { makeModelsForSpecs } from './model.js';
import { createApp } from './app.js';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
let configPathFlag: string | undefined;
const argIndex = args.indexOf('--config');
if (argIndex >= 0 && args[argIndex + 1]) configPathFlag = args[argIndex + 1];
const effectiveArgs = argIndex >= 0
  ? args.filter((_, idx) => idx !== argIndex && idx !== argIndex + 1)
  : args;

// git's empty tree: diffing against it lists every file when the repo had no commit yet
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
function understandingHead(dataDir: string): string | null {
  try {
    return execFileSync('git', ['-C', join(dataDir, 'understanding'), 'rev-parse', '--verify', '-q', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch { return null; }
}
function understandingDiffStat(dataDir: string, since: string | null): string {
  try {
    return execFileSync('git', ['-C', join(dataDir, 'understanding'), 'diff', '--stat', since || EMPTY_TREE, 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return ''; }
}

function loadCfg() {
  return loadConfig({ configPath: configPathFlag });
}
async function main() {
  const cmd = effectiveArgs[0];

  if (cmd === 'view') {
    const cfg = loadCfg();
    ensureDataDirs(cfg.dataDir);
    ensureUnderstandingRepo(cfg.dataDir);
    if (!listFiles(cfg.dataDir).length) { console.log('(empty)'); process.exit(0); }
    for (const f of listFiles(cfg.dataDir)) {
      console.log(f);
      try { console.log(readFileUnder(cfg.dataDir, f)); } catch (e: any) { console.log(`(error: ${e?.message || e})`); }
      console.log('---');
    }
    process.exit(0);
  }

  if (cmd === 'history') {
    const cfg = loadCfg();
    ensureDataDirs(cfg.dataDir);
    ensureUnderstandingRepo(cfg.dataDir);
    console.log(understandingHistory(cfg.dataDir, Number(effectiveArgs[1]) || undefined));
    process.exit(0);
  }

  if (cmd === 'rollback' && effectiveArgs[1]) {
    const cfg = loadCfg();
    ensureDataDirs(cfg.dataDir);
    ensureUnderstandingRepo(cfg.dataDir);
    rollbackUnderstanding(cfg.dataDir, effectiveArgs[1]);
    console.log('rolled back to', effectiveArgs[1]);
    process.exit(0);
  }

  if (cmd === 'search' && effectiveArgs[1]) {
    const cfg = loadCfg();
    const hits = searchRaw(cfg.dataDir, effectiveArgs.slice(1).join(' '));
    for (const h of hits) console.log(`[${new Date(h.ts).toISOString()}][${h.channel}][${h.role}] ${h.text}`);
    process.exit(0);
  }

  if (cmd === 'edit' && effectiveArgs[1]) {
    const cfg = loadCfg();
    ensureDataDirs(cfg.dataDir);
    ensureUnderstandingRepo(cfg.dataDir);
    const rel = effectiveArgs[1];
    const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
    const full = resolveUnderstandingPath(cfg.dataDir, rel);
    const r = spawnSync(editor, [full], { stdio: 'inherit' });
    if (r.status !== 0) {
      console.error('editor exited with', r.status);
      process.exit(r.status ?? 1);
    }
    // read new content and commit if changed
    try {
      const content = readFileUnder(cfg.dataDir, rel);
      writeFileUnder(cfg.dataDir, rel, content, `user correction: ${rel}`);
      console.log('saved', rel);
    } catch (e: any) {
      console.error(e?.message || e);
      process.exit(1);
    }
    process.exit(0);
  }

  if (cmd === 'backup') {
    const cfg = loadCfg();
    ensureDataDirs(cfg.dataDir);
    ensureUnderstandingRepo(cfg.dataDir);
    const envName = cfg.backup?.passphraseEnv || 'AVATAR_BACKUP_PASSPHRASE';
    const passphrase = process.env[envName];
    if (!cfg.backup?.dir) { console.error('backup not configured'); process.exit(1); }
    if (!passphrase) { console.error(`passphrase env ${envName} not set`); process.exit(1); }
    const { createEncryptedBackup } = await import('./backup.js');
    const file = createEncryptedBackup(cfg.dataDir, cfg.backup.dir, passphrase);
    console.log(file);
    process.exit(0);
  }

  if (cmd === 'restore' && effectiveArgs[1] && effectiveArgs[2]) {
    const file = effectiveArgs[1];
    const targetDir = effectiveArgs[2];
    const envName = (loadCfg().backup?.passphraseEnv) || 'AVATAR_BACKUP_PASSPHRASE';
    const passphrase = process.env[envName] || process.env.AVATAR_BACKUP_PASSPHRASE;
    if (!passphrase) { console.error(`passphrase env ${envName} not set`); process.exit(1); }
    try {
      const { restoreBackup } = await import('./backup.js');
      restoreBackup(file, targetDir, passphrase);
      console.log('restored to', targetDir);
      process.exit(0);
    } catch (e: any) {
      console.error(e?.message || e);
      process.exit(1);
    }
  }

  if (cmd === 'import' && effectiveArgs[1]) {
    const filePath = effectiveArgs[1];
    let label = '';
    let date = '';
    for (let i = 2; i < effectiveArgs.length; i++) {
      if (effectiveArgs[i] === '--label' && effectiveArgs[i + 1]) { label = effectiveArgs[++i]; }
      else if (effectiveArgs[i] === '--date' && effectiveArgs[i + 1]) { date = effectiveArgs[++i]; }
    }
    if (!label || !date) { console.error('import requires --label and --date'); process.exit(1); }
    const cfg = loadCfg();
    ensureDataDirs(cfg.dataDir);
    ensureUnderstandingRepo(cfg.dataDir);
    const text = readFileSync(filePath, 'utf8');
    const oldHead = understandingHead(cfg.dataDir);
    const { runSeedImport } = await import('./import.js');
    const { primary, reflection } = await makeModelsForSpecs(cfg.model, cfg.reflectionModel);
    const res = await runSeedImport({ config: cfg, models: { primary, reflection } }, { text, label, date });
    console.log(`imported ${res.imported}; skipped=${res.skipped}; reflection ran=${res.reflection.ran}${res.reflection.reason ? ' (' + res.reflection.reason + ')' : ''}`);
    const stat = understandingDiffStat(cfg.dataDir, oldHead);
    if (stat) console.log(stat);
    process.exit(0);
  }
  if (cmd === 'interview') {
    const cfg = loadCfg();
    ensureDataDirs(cfg.dataDir);
    ensureUnderstandingRepo(cfg.dataDir);
    const { primary, reflection } = await makeModelsForSpecs(cfg.model, cfg.reflectionModel);
    const oldHead = understandingHead(cfg.dataDir);
    const { createInterview } = await import('./interview.js');
    const iv = createInterview({ config: cfg, models: { primary, reflection } });
    console.log(await iv.open());
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '你> ' });
    let interrupted = false;
    rl.on('SIGINT', () => { interrupted = true; rl.close(); });
    rl.prompt();
    for await (const line of rl) {
      const trimmed = String(line).trim();
      if (trimmed === '/exit') { rl.close(); break; }
      if (trimmed === '') { rl.prompt(); continue; }
      try {
        const reply = await iv.reply(trimmed);
        console.log(reply);
      } catch (e: any) {
        console.log(`⚠️ 出错了：${e?.message || e}，可以再说一次`);
      }
      rl.prompt();
    }
    if (!interrupted) {
      console.log('整理中…');
      try {
        const res = await iv.close();
        if (res.wrappedUp) {
          const stat = understandingDiffStat(cfg.dataDir, oldHead);
          if (stat) console.log(stat);
        }
      } catch (e: any) {
        console.error(e?.message || e);
      }
    } else {
      console.log('未整理；对话已保存，之后的反思会消化它');
    }
    process.exit(0);
  }

  // daemon or run
  if (cmd && cmd !== 'run') {
    console.error('unknown command', cmd);
    process.exit(1);
  }

  const cfg = loadConfig({ configPath: configPathFlag });
  ensureDataDirs(cfg.dataDir);
  ensureUnderstandingRepo(cfg.dataDir);
  const adapters: ChannelAdapter[] = [];
  if (cfg.telegramToken) {
    try {
      adapters.push(new TelegramAdapter(cfg.telegramToken, cfg.allowedTelegramUserId));
    } catch (e: any) {
      console.error(`[channels] Telegram adapter disabled: ${e?.message || e}`);
    }
  }
  if (cfg.discordToken) {
    try {
      adapters.push(new DiscordAdapter(cfg.discordToken, cfg.allowedDiscordUserId));
    } catch (e: any) {
      console.error(`[channels] Discord adapter disabled: ${e?.message || e}`);
    }
  }
  if (adapters.length === 0) {
    console.error('[daemon] no channel adapters available; configure telegram and/or discord with an allowed user id');
    process.exit(1);
  }
  const { primary, reflection } = await makeModelsForSpecs(cfg.model, cfg.reflectionModel);
  const app = createApp({ config: cfg, models: { primary, reflection }, adapters });
  await app.start();
  const shutdown = async () => {
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`avatar companion running. data=${cfg.dataDir} channels=${adapters.map((a) => a.name).join(',') || 'none'}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});