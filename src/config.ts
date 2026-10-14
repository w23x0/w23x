import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

export interface ModelSpec {
  provider?: string;
  id: string;
  baseUrl?: string;
  apiKey?: string;
  api?: 'openai-completions' | 'anthropic-messages' | 'openai-responses';
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  input?: ('text' | 'image')[];
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
}

export interface TranscriptionConfig { baseUrl: string; apiKey?: string; model: string }

export interface BackupConfig { dir: string; intervalHours: number; passphraseEnv?: string }



export interface SenseConfig {
  activityWatchUrl: string;
  blockMinutes: number;
  lagMinutes: number;
  maxCatchupBlocks: number;
  exclude: { apps: string[]; titlePatterns: string[]; domains: string[] };
  githubUser?: string;
  githubTokenEnv: string;
  gitRoots: string[];
  claudeProjectsDir?: string;
}

export interface AppConfig {
  dataDir: string;
  model: ModelSpec;
  reflectionModel?: ModelSpec;
  idleMinutes: number;
  proactiveFallbackMinutes: number;
  proactiveMinMinutes: number;
  personaBriefMaxChars: number;
  sense?: SenseConfig;
  telegramToken?: string;
  allowedTelegramUserId?: string;
  discordToken?: string;
  allowedDiscordUserId?: string;
  transcription?: TranscriptionConfig;
  backup?: BackupConfig;
}

function loadJson(path: string): any {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function strEnv(env: Record<string,string|undefined>, key: string): string | undefined {
  const v = env[key];
  return v && v.trim() ? v.trim() : undefined;
}

function applyModelEnv(base: any, env: Record<string,string|undefined>, prefix: string): ModelSpec {
  const id = strEnv(env, `${prefix}MODEL`) ?? base?.id;
  if (!id) throw new Error(`model.id is required (${prefix || 'primary'})`);
  const api = (strEnv(env, `${prefix}API`) ?? base?.api) as ModelSpec['api'];
  return {
    provider: strEnv(env, `${prefix}PROVIDER`) ?? base?.provider,
    id,
    baseUrl: strEnv(env, `${prefix}BASE_URL`) ?? base?.baseUrl,
    apiKey: strEnv(env, `${prefix}API_KEY`) ?? base?.apiKey,
    api,
    reasoning: base?.reasoning,
    contextWindow: base?.contextWindow,
    maxTokens: base?.maxTokens,
    headers: base?.headers,
    input: base?.input,
    thinkingLevel: base?.thinkingLevel,
  };
}

export function loadConfig(opts?: { configPath?: string; env?: Record<string, string | undefined> }): AppConfig {
  const env = opts?.env ?? process.env as Record<string, string | undefined>;
  const resolvedConfigPath =
    opts?.configPath ??
    strEnv(env, 'AVATAR_CONFIG') ??
    (existsSync(resolve('./avatar.config.json')) ? resolve('./avatar.config.json') : undefined);

  const fileCfg = resolvedConfigPath ? loadJson(resolvedConfigPath) : null;

  const dataDir = resolve(strEnv(env, 'AVATAR_DATA_DIR') ?? fileCfg?.dataDir ?? './data');

  if (existsSync(join(dataDir, 'config.json'))) {
    throw new Error('config.json must not be inside dataDir; move it out of the data directory');
  }

  const model = applyModelEnv(fileCfg?.model || {}, env, 'AVATAR_');

  let reflectionModel: ModelSpec | undefined;
  const r = fileCfg?.reflectionModel;
  if (strEnv(env, 'REFLECTION_MODEL') || r?.id) {
    reflectionModel = applyModelEnv(r || {}, env, 'REFLECTION_');
  }

  const transcriptionRaw = fileCfg?.transcription;
  const transcription = transcriptionRaw?.baseUrl
    ? { baseUrl: transcriptionRaw.baseUrl, apiKey: transcriptionRaw.apiKey, model: transcriptionRaw.model } as TranscriptionConfig
    : undefined;

  const backupRaw = fileCfg?.backup;
  const backup = backupRaw?.dir
    ? { dir: backupRaw.dir, intervalHours: backupRaw.intervalHours ?? 24, passphraseEnv: backupRaw.passphraseEnv } as BackupConfig
    : undefined;

  const expandPath = (p: any) => (typeof p === 'string' && p.startsWith('~/')) ? join(homedir(), p.slice(2)) : p;
  let sense: SenseConfig | undefined;
  const senseRaw = fileCfg?.sense;
  const senseProvided = senseRaw !== null && senseRaw !== undefined && typeof senseRaw === 'object' && !Array.isArray(senseRaw);
  if (senseProvided) {
    const exRaw = (senseRaw.exclude && typeof senseRaw.exclude === 'object') ? senseRaw.exclude : {};
    const blockMinutes = senseRaw.blockMinutes ?? 30;
    if (!blockMinutes || 1440 % Number(blockMinutes) !== 0) {
      throw new Error('blockMinutes must divide 1440');
    }
    sense = {
      activityWatchUrl: senseRaw.activityWatchUrl ?? 'http://127.0.0.1:5600',
      blockMinutes: Number(blockMinutes),
      lagMinutes: senseRaw.lagMinutes ?? 5,
      maxCatchupBlocks: senseRaw.maxCatchupBlocks ?? 48,
      exclude: {
        apps: Array.isArray(exRaw.apps) ? exRaw.apps : [],
        titlePatterns: Array.isArray(exRaw.titlePatterns) ? exRaw.titlePatterns : [],
        domains: Array.isArray(exRaw.domains) ? exRaw.domains : [],
      },
      githubUser: senseRaw.githubUser,
      githubTokenEnv: senseRaw.githubTokenEnv ?? 'GITHUB_TOKEN',
      gitRoots: Array.isArray(senseRaw.gitRoots) ? senseRaw.gitRoots.map(expandPath) : [],
      claudeProjectsDir: expandPath(senseRaw.claudeProjectsDir),
    };
  }

  return {
    dataDir,
    model,
    reflectionModel,
    idleMinutes: fileCfg?.idleMinutes ?? 15,
    proactiveFallbackMinutes: fileCfg?.proactiveFallbackMinutes ?? 180,
    proactiveMinMinutes: fileCfg?.proactiveMinMinutes ?? 10,
    personaBriefMaxChars: fileCfg?.personaBriefMaxChars ?? 12000,
    telegramToken: strEnv(env, 'TELEGRAM_BOT_TOKEN') ?? fileCfg?.telegramToken,
    allowedTelegramUserId: strEnv(env, 'TELEGRAM_ALLOWED_USER_ID') ?? fileCfg?.allowedTelegramUserId,
    discordToken: strEnv(env, 'DISCORD_BOT_TOKEN') ?? fileCfg?.discordToken,
    allowedDiscordUserId: strEnv(env, 'DISCORD_ALLOWED_USER_ID') ?? fileCfg?.allowedDiscordUserId,
    transcription,
    backup,
    sense,
  };
}