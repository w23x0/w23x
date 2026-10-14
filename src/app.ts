import { ensureDataDirs } from './data/store.js';
import { ensureUnderstandingRepo, listFiles } from './data/understanding.js';
import { createEncryptedBackup } from './backup.js';
import { allRaw, appendRaw, saveRawMedia } from './data/raw.js';
import type { RawMessage, RawAttachment } from './data/raw.js';
import { createAvatarAgent, runAgentTurn } from './agent/avatar.js';
import { createMemoryTools } from './agent/tools.js';
import type { ResolvedModel } from './model.js';
import type { ChannelAdapter, InboundMessage } from './channels/types.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { transcribe as transcribeVoice } from './transcribe.js';
import { join } from 'node:path';

export interface AppDeps {
  config: any;
  models: { primary: ResolvedModel; reflection: ResolvedModel };
  adapters: ChannelAdapter[];
  now?: () => number;
  transcribe?: (voice: any) => Promise<string>;
}

export interface ProactiveDecision {
  ts: number;
  trigger: 'scheduled' | 'cold-start' | 'manual';
  sent: boolean;
  channel?: string;
  texts: string[];
  agentNote: string;
  nextWakeAt?: number;
  error?: string;
}

export interface App {
  handleInbound(msg: InboundMessage): Promise<void>;
  runReflection(): Promise<{ ran: boolean; reason?: string }>;
  runProactiveWake(trigger?: 'scheduled' | 'cold-start' | 'manual'): Promise<ProactiveDecision>;
  sessionMessages(): any[];
  start(): Promise<void>;
  stop(): Promise<void>;
}

function joinState(dataDir: string, name: string): string {
  return join(dataDir, 'state', name);
}

function readJsonSafe(path: string): any {
  try { if (!existsSync(path)) return null; return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJson(path: string, v: any): void {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(v), 'utf8');
}

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function isCjk(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff);
}

function estimateTextTokens(s: string): number {
  let cjk = 0; let other = 0;
  for (const ch of s) { if (isCjk(ch)) cjk++; else other++; }
  return cjk + Math.ceil(other / 4);
}

function msgContentTokens(m: any): number {
  const c = m?.content;
  if (typeof c === 'string') return estimateTextTokens(c);
  if (Array.isArray(c)) {
    return c.reduce((n: number, x: any) => {
      if (typeof x?.text === 'string') return n + estimateTextTokens(x.text);
      if (typeof x?.data === 'string') return n + Math.ceil(x.data.length / 4);
      return n + 25;
    }, 0);
  }
  return 0;
}

function trimMessages(messages: any[], tokenBudget: number): any[] {
  const system = messages.filter((m) => m?.role === 'system');
  const others = messages.filter((m) => m?.role !== 'system');
  const blocks: any[][] = [];
  let cur: any[] = [];
  for (const m of others) {
    if (m?.role === 'user' && cur.length > 0) {
      blocks.push(cur);
      cur = [];
    }
    cur.push(m);
  }
  if (cur.length) blocks.push(cur);
  let total = system.reduce((n, m) => n + msgContentTokens(m), 0) +
    others.reduce((n, m) => n + msgContentTokens(m), 0);
  while (blocks.length > 1 && total > tokenBudget) {
    const removed = blocks.shift()!;
    total -= removed.reduce((n, m) => n + msgContentTokens(m), 0);
  }
  return [...system, ...blocks.flat()];
}

function formatTime(ts: number, channel: string): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `[${y}-${m}-${day} ${hh}:${mm} ${wd} · ${channel}] `;
}
function localTime(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${y}-${m}-${day} ${hh}:${mm} ${wd}`;
}
export function createApp(deps: AppDeps): App {
  const config = deps.config;
  const dataDir = config.dataDir;
  const now = deps.now || Date.now;
  const models = deps.models;
  const adapters = deps.adapters;

  ensureDataDirs(dataDir);
  ensureUnderstandingRepo(dataDir);
  mkdirSync(join(dataDir, 'state'), { recursive: true });

  const transcribe = deps.transcribe || (async (voice: any) => {
    if (!config.transcription) throw new Error('no transcription configured');
    return transcribeVoice(voice, config.transcription);
  });

  // contacts
  const contactsPath = joinState(dataDir, 'contacts.json');
  const contacts: Record<string, { userId: string; chatId: string; lastTs?: number }> = readJsonSafe(contactsPath) || {};
  if (!contacts['telegram'] && config.allowedTelegramUserId) {
    contacts['telegram'] = { userId: config.allowedTelegramUserId, chatId: config.allowedTelegramUserId };
  }
  if (!contacts['discord'] && config.allowedDiscordUserId) {
    contacts['discord'] = { userId: config.allowedDiscordUserId, chatId: config.allowedDiscordUserId };
  }
  function persistContacts() { writeJson(contactsPath, contacts); }
  try { persistContacts(); } catch {}

  // cursor
  const cursorPath = joinState(dataDir, 'reflection-cursor.json');
  function loadCursor(): number {
    const c = readJsonSafe(cursorPath);
    return typeof c?.cursor === 'number' ? c.cursor : 0;
  }
  function saveCursor(v: number) { writeJson(cursorPath, { cursor: v }); }

  // next wake
  const nextWakePath = joinState(dataDir, 'next-wake.json');
  let nextWakeAt: number | null = null;
  let nextWakeReason: string | undefined;
  const nw = readJsonSafe(nextWakePath);
  if (typeof nw?.at === 'number') { nextWakeAt = nw.at; nextWakeReason = nw.reason; }
  function saveNextWake(reason?: string) {
    if (nextWakeAt === null) return;
    if (reason !== undefined) nextWakeReason = reason;
    writeJson(nextWakePath, { at: nextWakeAt, reason: nextWakeReason });
  }
  let started = false;
  let idleTimer: any = null;
  let proactiveTimer: any = null;
  let coldStartTimer: any = null;
  let backupTimer: any = null;

  let reflectionRunning = false;
  let proactiveRunning = false;

  let processing: Promise<void> = Promise.resolve();

  const sentTextsForRun: string[] = [];

  const contextWindow = models.primary.model?.contextWindow ?? 100000;
  const tokenBudget = Math.floor(contextWindow * 0.75);

  function resetIdle() {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { app.runReflection().catch((e) => console.error('reflection timer', e)); }, config.idleMinutes * 60_000);
  }

  const chatAgent = createAvatarAgent(models.primary, { dataDir, mode: 'chat', transformContext: async (msgs: any[]) => trimMessages(msgs, tokenBudget) });

  // restore session
  try {
    const restored: any[] = [];
    let total = 0;
    const raws = allRaw(dataDir);
    const m = models.primary.model;
    for (let i = raws.length - 1; i >= 0; i--) {
      const r = raws[i];
      if (r.role === 'import') continue;
      let msg: any;
      if (r.role === 'user') {
        msg = { role: 'user', content: r.text, timestamp: r.ts };
      } else {
        const text = r.role === 'proactive' ? '[主动消息] ' + r.text : r.text;
        msg = { role: 'assistant', content: [{ type: 'text', text }], api: m.api, provider: m.provider, model: m.id, usage: ZERO_USAGE, stopReason: 'stop', timestamp: r.ts };
      }
      const c = msgContentTokens(msg);
      if (restored.length > 0 && total + c > tokenBudget) break;
      restored.unshift(msg);
      total += c;
    }
    const systemMsgs = ((chatAgent as any).state.messages || []).filter((m: any) => m?.role === 'system');
    (chatAgent as any).state.messages = [...systemMsgs, ...restored];
  } catch (e) { console.error('session restore failed', e); }

  let lastActiveChannel: string | undefined = adapters[0]?.name;
  function getLastChannel(): string | undefined {
    let best: string | undefined;
    let bestTs = -1;
    for (const k of Object.keys(contacts)) {
      const c = contacts[k];
      if (c?.lastTs && c.lastTs > bestTs) { bestTs = c.lastTs; best = k; }
    }
    return best || lastActiveChannel || Object.keys(contacts)[0] || adapters[0]?.name;
  }

  async function sendToContact(channel: string | undefined, text: string): Promise<void> {
    const ch = channel || getLastChannel();
    if (!ch) throw new Error('no channel');
    const contact = contacts[ch];
    if (!contact) throw new Error('no contact for channel');
    const adapter = adapters.find((a) => a.name === ch) || adapters[0];
    if (!adapter) throw new Error('no adapter');
    await adapter.send(contact.chatId, text);
    sentTextsForRun.push(text);
    const rawMsg: RawMessage = { ts: now(), channel: ch, userId: contact.userId, role: 'proactive', text };
    appendRaw(dataDir, rawMsg);
    const m = models.primary.model;
    const injMsg: any = { role: 'assistant', content: [{ type: 'text', text: '[主动消息] ' + text }], api: m.api, provider: m.provider, model: m.id, usage: ZERO_USAGE, stopReason: 'stop', timestamp: now() };
    const injection = processing.then(() => { (chatAgent as any).state.messages.push(injMsg); });
    processing = injection.catch(() => {});
    await injection;
  }


  const app: App = {
    async handleInbound(msg: InboundMessage): Promise<void> {
      const task = processing.then(async () => {
        // record contact
        contacts[msg.channel] = { userId: msg.userId, chatId: msg.chatId, lastTs: now() };
        lastActiveChannel = msg.channel;
        persistContacts();

        // save media
        let text = msg.text || '';
        const attachments: RawAttachment[] = [];
        if (msg.images && msg.images.length) {
          for (const img of msg.images) {
            const buf = Buffer.from(img.data, 'base64');
            const ext = img.mimeType.includes('png') ? 'png' : 'jpg';
            const rel = saveRawMedia(dataDir, buf, ext);
            attachments.push({ kind: 'image', mimeType: img.mimeType, file: rel });
          }
        }
        if (msg.voice) {
          const buf = Buffer.from(msg.voice.data, 'base64');
          const ext = msg.voice.mimeType.includes('wav') ? 'wav' : 'ogg';
          const rel = saveRawMedia(dataDir, buf, ext);
          let transcript: string | undefined;
          try { transcript = await transcribe(msg.voice); } catch {}
          attachments.push({ kind: 'voice', mimeType: msg.voice.mimeType, file: rel, transcript });
          if (transcript) text = (text ? text + '\n' : '') + `[语音转写] ${transcript}`; else text = (text ? text + '\n' : '') + '[用户发了一条语音，当前无法转写]';
        }

        appendRaw(dataDir, {
          ts: now(),
          channel: msg.channel,
          userId: msg.userId,
          role: 'user',
          text,
          attachments: attachments.length ? attachments : undefined,
        });

        const supportsImage = Array.isArray(models.primary.model?.input) && models.primary.model.input.includes('image');
        const hasImages = !!(msg.images && msg.images.length);

        // agent input text with metadata
        let agentText = text;
        if (hasImages && !supportsImage) agentText = (agentText ? agentText + '\n' : '') + `[用户发了一张图片，当前模型无法查看]（收到 ${msg.images!.length} 张图片）`;
        const prefix = formatTime(now(), msg.channel);
        agentText = prefix + (agentText.trim() ? agentText : '(no text)');

        const runReadVersions = new Map<string, string>();
        chatAgent.state.tools = createMemoryTools({ dataDir, mode: 'chat', readVersions: runReadVersions });

        const beforeMessages = [...(chatAgent.state.messages as any[])];
        let reply = '';
        let failed = false;
        let failReason = '';
        const imageArgs = (hasImages && supportsImage)
          ? (msg.images || []).map((img: any) => ({ type: 'image', mimeType: img.mimeType, data: img.data }))
          : undefined;
        try {
          reply = await runAgentTurn(chatAgent, agentText, imageArgs);
        } catch (e: any) {
          failed = true;
          failReason = e?.message || String(e);
        }
        const msgs = chatAgent.state.messages as any[];
        let lastAssistant: any = null;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i]?.role === 'assistant') { lastAssistant = msgs[i]; break; }
        }
        if (!failed && (lastAssistant?.stopReason === 'error' || lastAssistant?.stopReason === 'aborted' || !reply.trim())) {
          failed = true;
          failReason = lastAssistant?.errorMessage || (reply.trim() ? 'empty reply' : 'empty reply');
        }

        const adapter = adapters.find((a) => a.name === msg.channel) || adapters[0];
        if (failed) {
          (chatAgent as any).state.messages = beforeMessages;
          console.error('online turn failed:', failReason);
          if (lastAssistant?.errorMessage) console.error(lastAssistant.errorMessage);
          if (adapter) await adapter.send(msg.chatId, '⚠️ 系统：刚才出错了，请稍后再说');
        } else {
          appendRaw(dataDir, {
            ts: now(),
            channel: msg.channel,
            userId: msg.userId,
            role: 'assistant',
            text: reply,
          });
          if (adapter) await adapter.send(msg.chatId, reply);
        }
        resetIdle();
      });
      processing = task.catch(() => {});
      return task;
    },

    async runReflection(): Promise<{ ran: boolean; reason?: string }> {
      if (reflectionRunning) return { ran: false, reason: 'already running' };
      reflectionRunning = true;
      try {
        const msgs = allRaw(dataDir);
        const cursor = loadCursor();
        const newOnes = msgs.slice(cursor);
        if (newOnes.length === 0) return { ran: false, reason: 'no new messages' };
        const startOffset = cursor;
        const endOffset = msgs.length - 1;
        const startTs = newOnes[0]?.ts;
        const endTs = newOnes[newOnes.length - 1]?.ts;
        const imports = newOnes.filter((m) => m.role === 'import');
        const importSummary = imports.length
          ? `Imports among them: ${imports.length} (${Array.from(new Set(imports.map((m) => `${m.source?.label || ''} ${m.source?.date || ''}`.trim()))).join('; ')})`
          : 'Imports among them: 0';
        const prompt =
          `Reflection. New raw messages since last reflection: ${newOnes.length} (offset ${startOffset} to ${endOffset}).\n` +
          `Time range: ${startTs ? localTime(startTs) : ''} to ${endTs ? localTime(endTs) : ''}.\n` +
          `${importSummary}\n` +
          `Use tools (read_raw with offset/limit) to page through them; do not expect full content here. ` +
          `Update your understanding layer if warranted; you may decide nothing is needed.\n`;
        const readVersions = new Map<string, string>();
        const reflAgent = createAvatarAgent(models.reflection, { dataDir, mode: 'reflection', readVersions });
        let failed = false;
        try {
          await runAgentTurn(reflAgent, prompt);
          const mlist = reflAgent.state.messages as any[];
          let lastAssistant: any = null;
          for (let i = mlist.length - 1; i >= 0; i--) { if (mlist[i]?.role === 'assistant') { lastAssistant = mlist[i]; break; } }
          if (lastAssistant?.stopReason === 'error' || lastAssistant?.stopReason === 'aborted') failed = true;
        } catch (e) {
          console.error('reflection turn failed', e);
          failed = true;
        }
        if (!failed) saveCursor(msgs.length);
        return { ran: true };
      } finally {
        reflectionRunning = false;
      }
    },

    async runProactiveWake(trigger: 'scheduled' | 'cold-start' | 'manual' = 'manual'): Promise<ProactiveDecision> {
      if (proactiveRunning) {
        return { ts: now(), trigger, sent: false, texts: [], agentNote: 'already running' };
      }
      proactiveRunning = true;
      sentTextsForRun.length = 0;
      try {
        nextWakeAt = null;
        nextWakeReason = undefined;
        const schedCallback = (minutes: number, reason: string) => {
          const requested = Number(minutes);
          const mins = Math.max(config.proactiveMinMinutes || 1, requested || config.proactiveFallbackMinutes);
          const clamped = mins !== requested;
          nextWakeAt = now() + mins * 60_000;
          saveNextWake(reason);
          return clamped ? `clamped to minimum ${config.proactiveMinMinutes}; scheduled in ${mins} minutes` : `scheduled in ${mins} minutes`;
        };
        const proactiveAgent = createAvatarAgent(models.primary, {
          dataDir,
          mode: 'proactive',
          sendMessage: async (channel: string | undefined, text: string) => { await sendToContact(channel, text); },
          scheduleNextWake: schedCallback,
        });
        const ch = getLastChannel();
        const channels = adapters.length ? adapters.map((a: any) => a.name).join(', ') : 'none';
        const lastContactTs = Object.values(contacts).reduce((acc: number, c: any) => Math.max(acc, c?.lastTs || 0), 0);
        const pRaw = allRaw(dataDir);
        const recentProactive = pRaw.filter((m) => m.role === 'proactive').slice(-5);
        const outreachLines = recentProactive.map((pm) => {
          const reply = pRaw.find((m) => m.role === 'user' && m.ts > pm.ts);
          const lag = reply ? Math.round((reply.ts - pm.ts) / 60000) : null;
          const replyInfo = reply ? `用户在 ${lag} 分钟后回复` : '暂无回复';
          return `- ${localTime(pm.ts)}: ${pm.text} (${replyInfo})`;
        });
        const uCount = pRaw.filter((m) => m.role === 'user' || m.role === 'proactive').length === 0;
        const coldStart = trigger === 'cold-start';
        const imports = pRaw.filter((m) => m.role === 'import');
        const importLabels = Array.from(new Set(imports.map((m) => `${m.source?.label || ''} ${m.source?.date || ''}`.trim()))).filter(Boolean);
        const understandingCount = (() => { try { return listFiles(dataDir).length; } catch { return 0; } })();
        const prompt = [
          `当前时间：${localTime(now())}`,
          `可用渠道：${channels}`,
          `用户最后一次来信时间：${lastContactTs ? localTime(lastContactTs) : '从未'}`,
          recentProactive.length ? `最近主动消息及后续回复：\n${outreachLines.join('\n')}` : '最近主动消息：无',
          coldStart ? `冷启动：${uCount ? '是（尚未与用户直接对话）' : '否'}` : '',
          coldStart ? `导入的种子对话：${imports.length ? '有（' + importLabels.join('; ') + '）' : '无'}` : '',
          coldStart ? `理解层已有内容：${understandingCount > 0 ? understandingCount + ' 个文件' : '空'}` : '',
          '',
          coldStart
            ? '目标：你还几乎不认识他。主动发起一轮较完整的认识对话，以追问为主，可以分多次完成，不必一次问完。若理解层已有内容，在此基础上继续，不重复已经探索过的内容。'
            : '目标：依据你对他的理解，特别是理解层中的不确定之处，判断现在是否值得主动找他、说什么；他冷淡或没回应时应当收敛；可以什么都不发；用 schedule_next_wake 安排下次醒来。',
        ].filter(Boolean).join('\n');
        let note = '';
        try {
          note = await runAgentTurn(proactiveAgent, prompt);
        } catch (e: any) {
          note = `error: ${e?.message || e}`;
        }

        const decision: ProactiveDecision = {
          ts: now(),
          trigger,
          sent: sentTextsForRun.length > 0,
          channel: getLastChannel(),
          texts: [...sentTextsForRun],
          agentNote: note,
          nextWakeAt: nextWakeAt || undefined,
        };

        try {
          const logPath = join(dataDir, 'state', 'proactive-log.jsonl');
          mkdirSync(join(dataDir, 'state'), { recursive: true });
          appendFileSync(logPath, JSON.stringify(decision) + '\n', 'utf8');
        } catch {}

        if (!nextWakeAt || nextWakeAt <= now()) {
          nextWakeAt = now() + (config.proactiveFallbackMinutes || 180) * 60_000;
          saveNextWake();
        }
        if (started) {
          if (proactiveTimer) clearTimeout(proactiveTimer);
          const delay = Math.max(0, (nextWakeAt as number) - now());
          proactiveTimer = setTimeout(() => { app.runProactiveWake('scheduled').catch((e) => console.error('proactive timer', e)); }, delay);
        }

        return decision;
      } catch (e: any) {
        const decision: ProactiveDecision = {
          ts: now(),
          trigger,
          sent: false,
          texts: [],
          agentNote: `error: ${e?.message || e}`,
        };
        return decision;
      } finally {
        proactiveRunning = false;
      }
    },

    sessionMessages(): any[] {
      return (chatAgent as any).state?.messages || [];
    },

    async start(): Promise<void> {
      started = true;
      for (const a of adapters) {
        await a.start(async (m) => { await app.handleInbound(m); });
      }
      // idle timer exists now
      idleTimer = setTimeout(() => { app.runReflection().catch((e) => console.error('reflection timer', e)); }, config.idleMinutes * 60_000);
      // arm proactive
      if (nextWakeAt === null) {
        nextWakeAt = now() + (config.proactiveFallbackMinutes || 180) * 60_000;
        saveNextWake();
      }
      const delay = (nextWakeAt as number) <= now() ? 50 : Math.max(0, (nextWakeAt as number) - now());
      proactiveTimer = setTimeout(() => { app.runProactiveWake('scheduled').catch((e) => console.error('proactive timer', e)); }, delay);

    if (config.backup) {
      const envName = config.backup.passphraseEnv || 'AVATAR_BACKUP_PASSPHRASE';
      const passphrase = (process.env as Record<string, string | undefined>)[envName];
      if (!passphrase) {
        console.warn(`backup configured but passphrase env ${envName} is not set; backups disabled`);
      } else {
        backupTimer = setInterval(() => {
          try { createEncryptedBackup(dataDir, config.backup.dir, passphrase); }
          catch (e) { console.error('backup timer', e); }
        }, (config.backup.intervalHours || 24) * 3600_000);
      }
    }

      try {
        const raws = allRaw(dataDir);
        const hasDirect = raws.some((m) => m.role === 'user' || m.role === 'proactive');
        if (!hasDirect) {
          coldStartTimer = setTimeout(() => { app.runProactiveWake('cold-start').catch((e) => console.error('cold start', e)); }, 50);
        }
      } catch {}
    },

    async stop(): Promise<void> {
      started = false;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (proactiveTimer) { clearTimeout(proactiveTimer); proactiveTimer = null; }
      if (coldStartTimer) { clearTimeout(coldStartTimer); coldStartTimer = null; }
      if (backupTimer) { clearInterval(backupTimer); backupTimer = null; }
      for (const a of adapters) {
        try { await a.stop(); } catch {}
      }
    },
  };
  return app;
}