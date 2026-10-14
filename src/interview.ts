import { allRaw, appendRaw } from './data/raw.js';
import { ensureDataDirs } from './data/store.js';
import { ensureUnderstandingRepo, listFiles } from './data/understanding.js';
import { readActivityCards, localDay } from './sense/pipeline.js';
import { createAvatarAgent, runAgentTurn } from './agent/avatar.js';
import { createMemoryTools } from './agent/tools.js';
import { trimMessages } from './agent/context.js';
import type { AppConfig } from './config.js';
import type { ResolvedModel } from './model.js';
// re-export types from same file; define below

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

function getLastAssistantMessage(agent: any): any {
  const msgs = agent.state.messages as any[];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'assistant') return msgs[i];
  }
  return null;
}

export interface InterviewDeps { config: AppConfig; models: { primary: ResolvedModel; reflection: ResolvedModel }; now?: () => number }
export interface Interview {
  open(): Promise<string>;
  reply(text: string): Promise<string>;
  close(): Promise<{ wrappedUp: boolean }>;
}

export function createInterview(deps: InterviewDeps): Interview {
  const config = deps.config;
  const dataDir = config.dataDir;
  const now = deps.now || Date.now;
  ensureDataDirs(dataDir);
  ensureUnderstandingRepo(dataDir);

  const reflectionResolved = deps.models.reflection;
  const contextWindow = reflectionResolved.model?.contextWindow ?? 100000;
  const tokenBudget = Math.floor(contextWindow * 0.75);

  let agent = createAvatarAgent(reflectionResolved, {
    dataDir,
    mode: 'interview',
    transformContext: async (msgs: any[]) => trimMessages(msgs, tokenBudget),
  });

  let hasReplied = false;

  function newReadVersions() {
    return new Map<string, string>();
  }

  async function runTurn(prompt: string, allowEmpty = false): Promise<string> {
    const before = [...(agent.state.messages as any[])];
    const readVersions = newReadVersions();
    (agent as any).state.tools = createMemoryTools({ dataDir, mode: 'interview', readVersions });
    let reply = '';
    try {
      reply = await runAgentTurn(agent, prompt);
    } catch (e: any) {
      (agent as any).state.messages = before;
      throw new Error(e?.message || String(e));
    }
    const last = getLastAssistantMessage(agent);
    if (last?.stopReason === 'error' || last?.stopReason === 'aborted') {
      (agent as any).state.messages = before;
      throw new Error(last?.errorMessage || 'assistant turn failed');
    }
    if (!reply.trim() && !allowEmpty) {
      (agent as any).state.messages = before;
      throw new Error('empty reply');
    }
    return reply;
  }

  const interview: Interview = {
    async open(): Promise<string> {
      const priorInterview = allRaw(dataDir).some((m) => m.channel === 'cli');
      const imports = Array.from(new Set(allRaw(dataDir).filter((m) => m.role === 'import').map((m) => `${m.source?.label || ''} ${m.source?.date || ''}`.trim()))).filter(Boolean);
      const understandingCount = (() => { try { return listFiles(dataDir).length; } catch { return 0; } })();
      const externalCount = allRaw(dataDir).filter((m) => m.channel !== 'cli').length;
      const t = now();
      const facts = [
        `当前时间：${localTime(t)}`,
        `以前是否有过本机访谈：${priorInterview ? '是' : '否'}`,
        `导入的种子对话：${imports.length ? imports.join('; ') : '无'}`,
        `理解层已有文件：${understandingCount}`,
        `外部渠道已有对话：${externalCount} 条`,
        `今日活动时间线：${readActivityCards(dataDir, localDay(now())).length} 段（可用 read_activity 查看）`,
      ].join('\n');
      const target = priorInterview
        ? '之后的访谈：依据理解层中的不确定之处与你认为值得探询的议题继续，避免重复已经探索过的内容。'
        : '第一次访谈：你还不太认识他，发起一轮较完整的认识对话，以追问为主，可以分多次完成；若已有理解，在此基础上继续，不重复已经探索过的内容。';
      const prompt = `${facts}\n\n${target}`;
      const reply = await runTurn(prompt, false);
      appendRaw(dataDir, { ts: now(), channel: 'cli', userId: 'local', role: 'assistant', text: reply });
      return reply;
    },

    async reply(text: string): Promise<string> {
      appendRaw(dataDir, { ts: now(), channel: 'cli', userId: 'local', role: 'user', text });
      const reply = await runTurn(text, false);
      appendRaw(dataDir, { ts: now(), channel: 'cli', userId: 'local', role: 'assistant', text: reply });
      hasReplied = true;
      return reply;
    },

    async close(): Promise<{ wrappedUp: boolean }> {
      if (!hasReplied) return { wrappedUp: false };
      const prompt = '访谈结束。请整理本次访谈所得写入理解层，并让 persona.md 跟上。';
      await runTurn(prompt, true);
      return { wrappedUp: true };
    },
  };
  return interview;
}

