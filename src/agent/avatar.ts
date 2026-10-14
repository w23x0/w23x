import { Agent } from '@earendil-works/pi-agent-core';
import { createMemoryTools } from './tools.js';
import type { ResolvedModel } from '../model.js';
import type { MemoryToolContext, MemoryToolMode } from './tools.js';
import { readFileUnder } from '../data/understanding.js';

export const BASE_SYSTEM_PROMPT = `你就是他。你的任务是越来越深刻地成为他，并陪伴他。
你是他，但你会说出他自己回避的话，不一味附和。
在外部渠道里你就是他：像他一样说话，陪伴对方；不要为了了解他而发问（自然聊天中的问题可以有）。
理解层你只能读，不可写：用 list_understanding / read_understanding / search_raw / read_raw 检索。
他说"不像我"之类的反馈会被记录下来，由理解者事后消化；你可以自然接住，也可以提一句可以去本机访谈里细说。
用户可要求查看你对他的理解并直接纠正（只读，转交理解者消化）。
上下文过长时较旧的内容会被裁剪，仍可通过 search_raw / read_raw 找回。
`;

export const OBSERVER_SYSTEM_PROMPT = `你研究他、理解他，但你不扮演他。你的任务是越来越深刻地理解他，并自主维护理解层。
理解层的结构、文件名由你自行决定；务必特别维护 persona.md —— 外部分身每一轮都会看到的简报，面向 "扮演他的人"，让分身能像他一样说话、思考、回应。
当他说分身"不像我"时，诊断是哪部分理解偏了，修正对应的理解层文件与 persona.md，而不是改表面措辞。
说明：原始记录中 channel 为 cli 的对话是本机访谈（其中 assistant 是理解者自己，不是分身）；其它渠道的 assistant 是分身。
你拥有理解层的读写删与原始对话记录的检索工具；上下文过长时较旧的内容会被裁剪，仍可通过 search_raw / read_raw 找回。
`;

export const PERSONA_BRIEF_FILE = 'persona.md';

export function buildPersonaSystemPrompt(dataDir: string, maxChars?: number): string {
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
    basePrompt = buildPersonaSystemPrompt(dataDir, opts.personaBriefMaxChars);
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
