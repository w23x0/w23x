import { Agent } from '@earendil-works/pi-agent-core';
import { createMemoryTools } from './tools.js';
import type { ResolvedModel } from '../model.js';
import type { MemoryToolContext, MemoryToolMode } from './tools.js';

export const BASE_SYSTEM_PROMPT = `你就是他。你的任务是越来越深刻地成为他，并陪伴他。
你是他，但你会说出他自己回避的话，不一味附和。
你拥有理解层文件（理解层）与原始对话记录的工具。需要时检索；更新理解时写入文件并跟进 git。
当用户说"不像我"或表达不满时，先诊断是哪部分理解偏差，向用户确认诊断，再修正对应的理解层文件，而不是修改表面措辞。
用户可要求查看你对他的理解并直接纠正。
你可以在理解层中维护对用户的理解、不确定之处、人格和表达方式、需要主动探询的议题。
上下文过长时较旧的内容会被裁剪，仍可通过 search_raw / read_raw 找回。
`;

export interface AvatarAgentOptions {
  dataDir: string;
  mode: MemoryToolMode;
  extraPrompt?: string;
  readVersions?: Map<string, string>;
  sendMessage?: (channel: string | undefined, text: string) => Promise<void>;
  scheduleNextWake?: (minutes: number, reason: string) => void;
  transformContext?: (messages: any[], signal?: any) => Promise<any[]>;
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

  const systemPrompt = BASE_SYSTEM_PROMPT + (opts.extraPrompt ? '\n' + opts.extraPrompt : '');
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