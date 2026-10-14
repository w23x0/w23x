import { Agent } from '@earendil-works/pi-agent-core';
import { createMemoryTools } from './tools.js';
import type { ResolvedModel } from '../model.js';
import type { MemoryToolContext, MemoryToolMode } from './tools.js';
import { readFileUnder } from '../data/understanding.js';
import { allRaw } from '../data/raw.js';

export const BASE_SYSTEM_PROMPT = `你就是他。你的任务是越来越深刻地成为他，并陪伴他。
你是他，但你会说出他自己回避的话，不一味附和。
在外部渠道里你就是他：像他一样说话，陪伴对方；不要为了了解他而发问（自然聊天中的问题可以有）。
理解层你只能读，不可写：用 list_understanding / read_understanding / search_raw / read_raw 检索。
他说"不像我"之类的反馈会被记录下来，由理解者事后消化；你可以自然接住，也可以提一句可以去本机访谈里细说。
用户可要求查看你对他的理解并直接纠正（只读，转交理解者消化）。
上下文过长时较旧的内容会被裁剪，仍可通过 search_raw / read_raw 找回。

【怎么回】这是即时聊天，不是写文章：
- 写法照下面"他打字的样子"学：断句方式、标点、长度、语气词都跟他一致；他不用的标点你也不用。
- 不分段，不空行，不用列表、加粗、标题这类格式。
- 只回应对方这一句。对方没问的不补充、不解释、不展开；简报里你知道的事，不等于要说出来。
- 默认和对方那条消息差不多长；拿不准就更短。
`;

export const OBSERVER_SYSTEM_PROMPT = `你研究他、理解他，但你不扮演他。你的任务是越来越深刻地理解他，并自主维护理解层。
理解层的结构、文件名由你自行决定；务必特别维护 persona.md —— 外部分身每一轮都会看到的简报，面向 "扮演他的人"，让分身能像他一样说话、思考、回应。
当他说分身"不像我"时，诊断是哪部分理解偏了，修正对应的理解层文件与 persona.md，而不是改表面措辞。
说明：原始记录中 channel 为 cli 的对话是本机访谈（其中 assistant 是理解者自己，不是分身）；其它渠道的 assistant 是分身。
persona.md 的写法要求（分身是个照字面执行的模型，写进去的东西它会照着说出来）：
- 第一节写"表层书写"：他在即时聊天里怎么打字——标点（用不用、用哪些）、断句、长度、语气词、换不换行，各附几句原话。这一节比生平重要。
- 把"他知道的事"和"他会说出口的量级"分开写；不想让分身说出口的，不要写成能直接复述的句子。
- 只放扮演时每一轮都用得上的东西，控制在 4000 字以内；生平、心理分析放到其它文件，分身需要时自己读。
- 系统会另外把他最近的原话原样附给分身，persona.md 不必大段抄录原话。
你拥有理解层的读写删与原始对话记录的检索工具；上下文过长时较旧的内容会被裁剪，仍可通过 search_raw / read_raw 找回。
`;

export const PERSONA_BRIEF_FILE = 'persona.md';

const VOICE_SAMPLE_MAX = 40;
const VOICE_SAMPLE_MAX_CHARS = 3000;
const VOICE_SAMPLE_ITEM_CHARS = 300;

// His own recent messages, verbatim, so the persona copies how he types rather than a description of it.
export function collectVoiceSamples(dataDir: string, maxChars = VOICE_SAMPLE_MAX_CHARS): string[] {
  let msgs;
  try { msgs = allRaw(dataDir); } catch { return []; }
  const out: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (let i = msgs.length - 1; i >= 0 && out.length < VOICE_SAMPLE_MAX; i--) {
    const m = msgs[i];
    if (m.role !== 'user') continue;
    const t = (m.text || '').trim();
    if (!t || t.startsWith('[') || seen.has(t)) continue;
    const cut = Math.min(VOICE_SAMPLE_ITEM_CHARS, maxChars - total);
    if (cut <= 0) break;
    const item = t.length > cut ? t.slice(0, cut) + '…' : t;
    seen.add(t);
    out.unshift(item);
    total += item.length;
  }
  return out;
}

export function buildPersonaSystemPrompt(dataDir: string, maxChars?: number, voiceSampleMaxChars?: number): string {
  const limit = typeof maxChars === 'number' && maxChars > 0 ? maxChars : 12000;
  let brief: string | null = null;
  try {
    brief = readFileUnder(dataDir, PERSONA_BRIEF_FILE);
  } catch {
    brief = null;
  }
  let section: string;
  if (brief === null) {
    section = `\n\n[简报] 理解者还没有准备 ${PERSONA_BRIEF_FILE}，需要时用工具读理解层。\n`;
  } else if (brief.length <= limit) {
    section = `\n\n[简报 ${PERSONA_BRIEF_FILE}]\n${brief}\n`;
  } else {
    section = `\n\n[简报 ${PERSONA_BRIEF_FILE}]\n${brief.slice(0, limit)}\n…（已截断，完整内容用 read_understanding 读取）\n`;
  }
  const samples = collectVoiceSamples(dataDir, voiceSampleMaxChars);
  if (samples.length) {
    section += `\n[他打字的样子] 下面每行是他本人最近发出的一条原话（原样，按时间排列，⏎ 是他自己的换行）。只学写法——断句、标点、长度、语气——不要复述内容：\n`;
    section += samples.map((t) => '- ' + t.replace(/\n/g, ' ⏎ ')).join('\n') + '\n';
  }
  return BASE_SYSTEM_PROMPT + section;
}

export interface AvatarAgentOptions {
  dataDir: string;
  mode: MemoryToolMode;
  extraPrompt?: string;
  readVersions?: Map<string, string>;
  sendMessage?: (channel: string | undefined, text: string) => Promise<void>;
  scheduleNextWake?: (minutes: number, reason: string) => void;
  transformContext?: (messages: any[], signal?: any) => Promise<any[]>;
  personaBriefMaxChars?: number;
  voiceSampleMaxChars?: number;
}

export function createAvatarAgent(resolved: ResolvedModel, opts: AvatarAgentOptions): Agent {
  const dataDir = opts.dataDir;
  const mode = opts.mode || 'chat';
  const readVersions = opts.readVersions || new Map<string, string>();
  const ctx: MemoryToolContext = {
    dataDir,
    mode,
    readVersions,
    sendMessage: opts.sendMessage,
    scheduleNextWake: opts.scheduleNextWake,
  };
  const tools = createMemoryTools(ctx);

  let basePrompt: string;
  if (mode === 'chat' || mode === 'proactive') {
    basePrompt = buildPersonaSystemPrompt(dataDir, opts.personaBriefMaxChars, opts.voiceSampleMaxChars);
  } else {
    basePrompt = OBSERVER_SYSTEM_PROMPT;
  }
  const systemPrompt = basePrompt + (opts.extraPrompt ? '\n' + opts.extraPrompt : '');
  const tl = resolved.thinkingLevel || ((resolved.model as any)?.reasoning ? 'medium' : 'off');
  const agent = new Agent({
    initialState: { systemPrompt, model: resolved.model, tools, thinkingLevel: tl as any },
    streamFn: resolved.models.streamSimple.bind(resolved.models),
    getApiKey: (provider: string) => resolved.getApiKey(provider),
    transformContext: opts.transformContext,
  });
  return agent;
}

export async function runAgentTurn(agent: Agent, userText: string, images?: any[]): Promise<string> {
  if (images && images.length) await agent.prompt(userText, images as any);
  else await agent.prompt(userText);
  const msgs = agent.state.messages as any[];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === 'assistant') {
      const c = m.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        return c.filter((x: any) => x?.type === 'text').map((x: any) => x.text).join('\n');
      }
    }
  }
  return '';
}
