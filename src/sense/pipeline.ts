import { Agent } from '@earendil-works/pi-agent-core';
import { runAgentTurn } from '../agent/avatar.js';
import { trimMessages } from '../agent/context.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createActivityWatchSource } from './activitywatch.js';
import { findGitRepos, gitCommits } from './localgit.js';
import { claudePrompts } from './claudecode.js';
import { fetchGithubReport } from './github.js';
import { applyExclusions, clipPauses, summarizeBlock, formatDayDigest } from './summarize.js';
import type { ActivityCard, SenseSources, BlockSignals } from './types.js';
import type { AppConfig } from '../config.js';
import type { ResolvedModel } from '../model.js';

// re-export
export { applyExclusions, clipPauses, summarizeBlock, formatDayDigest } from './summarize.js';

export const TIMELINE_PROMPT = `你在为他记录电脑上的时间线。根据一段时间的客观信号，用简短中文写一张卡片：他这段时间主要在做什么（具体到项目、内容、对象）、是否在电脑前、节奏与状态。只写信号支持的内容，推测要标明是推测；不评价、不说教。`;

export function localDay(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function readActivityCards(dataDir: string, day: string): ActivityCard[] {
  const file = join(dataDir, 'raw', `activity-${day}.jsonl`);
  if (!existsSync(file)) return [];
  const out: ActivityCard[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function dayStartMs(ts: number): number {
  return new Date(ts).setHours(0, 0, 0, 0);
}

function getLastAssistant(agent: any): any {
  const msgs = agent.state.messages as any[];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === 'assistant') return msgs[i];
  return null;
}

export interface SenseDeps {
  config: AppConfig; // must have config.sense
  models: { primary: ResolvedModel; reflection: ResolvedModel };
  sources?: SenseSources;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export interface Sense {
  tick(): Promise<{ processed: number; digests: string[]; error?: string }>;
  pause(minutes: number): { start: number; end: number };
  resume(): void;
  status(): Promise<{ awAvailable: boolean; buckets: string[]; cursor: number | null; pausedUntil: number | null }>;
  githubBackfill(): Promise<string>;
}

function readCursor(dataDir: string): number | null {
  const p = join(dataDir, 'state', 'sense-cursor.json');
  try {
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return typeof j?.blockEnd === 'number' ? j.blockEnd : null;
  } catch { return null; }
}
function writeCursor(dataDir: string, v: number): void {
  mkdirSync(join(dataDir, 'state'), { recursive: true });
  writeFileSync(join(dataDir, 'state', 'sense-cursor.json'), JSON.stringify({ blockEnd: v }), 'utf8');
}
function readPauses(dataDir: string): { start: number; end: number }[] {
  const p = join(dataDir, 'state', 'sense-pauses.json');
  try {
    if (!existsSync(p)) return [];
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}
function writePauses(dataDir: string, v: any[]): void {
  mkdirSync(join(dataDir, 'state'), { recursive: true });
  writeFileSync(join(dataDir, 'state', 'sense-pauses.json'), JSON.stringify(v), 'utf8');
}

export function createSense(deps: SenseDeps): Sense {
  const config = deps.config;
  const dataDir = config.dataDir;
  const senseCfg = config.sense!;
  const now = deps.now || Date.now;
  const fetchImpl = deps.fetchImpl;
  const models = deps.models;

  mkdirSync(join(dataDir, 'state'), { recursive: true });

  let awSource: ReturnType<typeof createActivityWatchSource> | undefined;
  let sources: SenseSources;
  if (deps.sources) {
    sources = deps.sources;
  } else {
    awSource = createActivityWatchSource(senseCfg.activityWatchUrl, fetchImpl);
    const gitRoots = senseCfg.gitRoots || [];
    const claudeDir = senseCfg.claudeProjectsDir;
    sources = {
      async collect(start, end) {
        let window: any[] = [];
        let afk: any[] = [];
        let web: any[] = [];
        let media: any[] = [];
        let awAvailable = false;
        try {
          const r = await awSource!.collect(start, end);
          window = r.window; afk = r.afk; web = r.web; media = r.media; awAvailable = true;
        } catch { awAvailable = false; }
        const repos = gitRoots.length ? findGitRepos(gitRoots) : [];
        const commits = gitRoots.length ? gitCommits(repos, start, end) : [];
        const prompts = claudeDir ? claudePrompts(claudeDir, start, end) : [];
        return { start, end, awAvailable, window, afk, web, media, commits, prompts } as BlockSignals;
      },
    };
  }

  const B = senseCfg.blockMinutes;

  function lastBoundary(ts: number): number {
    const ds = dayStartMs(ts);
    const mins = (ts - ds) / 60000;
    const floored = Math.floor(mins / B) * B;
    return ds + floored * 60000;
  }

  const sense: Sense = {
    async tick() {
      const processedStart = 0;
      let processed = processedStart;
      const digests: string[] = [];

      const nowMs = now();
      const cursor0 = readCursor(dataDir);
      let cursor = cursor0 === null ? dayStartMs(nowMs) : cursor0;

      const E = lastBoundary(nowMs - (senseCfg.lagMinutes || 0) * 60000);
      if (E - cursor > (senseCfg.maxCatchupBlocks || 1) * B * 60000) {
        cursor = E - (senseCfg.maxCatchupBlocks || 1) * B * 60000;
      }

      const pauses = () => readPauses(dataDir);

      while (cursor + B * 60000 <= E) {
        const s = cursor;
        const e = cursor + B * 60000;
        let sig: BlockSignals;
        try {
          sig = await sources.collect(s, e);
        } catch (err: any) {
          return { processed, digests, error: err?.message || String(err) };
        }
        const sig2 = clipPauses(applyExclusions(sig, senseCfg.exclude), pauses());
        const paused = pauses().some((p) => p.start <= s && e <= p.end);
        const sm = summarizeBlock(sig2);

        let cardText: string | null = null;
        if (!sm.empty && !paused) {
          const tokenBudget = Math.floor((models.reflection.model?.contextWindow ?? 100000) * 0.75);
          const r = models.reflection;
          const agent = new Agent({
            initialState: { systemPrompt: TIMELINE_PROMPT, model: r.model, tools: [], thinkingLevel: ((r.model as any)?.reasoning ? 'low' : 'off') as any },
            streamFn: r.models.streamSimple.bind(r.models),
            getApiKey: (provider: string) => r.getApiKey(provider),
            transformContext: async (msgs: any[]) => trimMessages(msgs, tokenBudget),
          });
          try {
            const reply = await runAgentTurn(agent, sm.text);
            const last = getLastAssistant(agent);
            if (last?.stopReason === 'error' || last?.stopReason === 'aborted' || !reply.trim()) {
              throw new Error(last?.errorMessage || 'empty timeline card');
            }
            cardText = reply;
          } catch (err: any) {
            return { processed, digests, error: err?.message || String(err) };
          }
        }

        const card: ActivityCard = {
          start: s,
          end: e,
          activeMinutes: sm.activeMinutes,
          afkMinutes: sm.afkMinutes,
          empty: sm.empty,
          paused,
          summary: sm.text,
          card: cardText,
        };
        mkdirSync(join(dataDir, 'raw'), { recursive: true });
        appendFileSync(join(dataDir, 'raw', `activity-${localDay(s)}.jsonl`), JSON.stringify(card) + '\n', 'utf8');
        cursor = e;
        writeCursor(dataDir, cursor);
        processed++;
      }

      // digests
      try {
        const rawDir = join(dataDir, 'raw');
        if (existsSync(rawDir)) {
          const days = readdirSync(rawDir)
            .filter((f) => f.startsWith('activity-') && f.endsWith('.jsonl'))
            .map((f) => f.slice('activity-'.length, -'.jsonl'.length));
          const uniqueDays = Array.from(new Set(days));
          for (const day of uniqueDays) {
            const dayStart = new Date(day + 'T00:00:00').getTime();
            const nextMidnight = dayStart + 24 * 60 * 60 * 1000;
            if (cursor < nextMidnight) continue;
            const digestPath = join(rawDir, 'digests', `day-${day}.md`);
            if (existsSync(digestPath)) continue;
            mkdirSync(join(rawDir, 'digests'), { recursive: true });
            try {
              const sig = await sources.collect(dayStart, nextMidnight);
              const sig2 = clipPauses(applyExclusions(sig, senseCfg.exclude), pauses());
              const sm = summarizeBlock(sig2);
              const cards = readActivityCards(dataDir, day);
              const md = formatDayDigest(day, sm.text, cards);
              writeFileSync(digestPath, md, 'utf8');
              digests.push(`digests/day-${day}.md`);
            } catch { /* skip, retry later */ }
          }
        }
      } catch { /* ignore */ }

      return { processed, digests };
    },
    pause(minutes: number): { start: number; end: number } {
      const p = { start: now(), end: now() + minutes * 60000 };
      const pauses = readPauses(dataDir);
      pauses.push(p);
      writePauses(dataDir, pauses);
      return p;
    },
    resume() {
      const nowMs = now();
      const pauses = readPauses(dataDir).map((p) => (p.end > nowMs ? { ...p, end: nowMs } : p));
      writePauses(dataDir, pauses);
    },
    async status() {
      let awAvailable = false;
      let buckets: string[] = [];
      if (awSource) {
        try { buckets = await awSource.buckets(); awAvailable = true; } catch { awAvailable = false; buckets = []; }
      }
      const cursor = readCursor(dataDir);
      const ps = readPauses(dataDir);
      const pausedUntil = ps.filter((p) => p.end > now()).reduce((acc, p) => Math.max(acc, p.end), 0);
      return { awAvailable, buckets, cursor, pausedUntil: pausedUntil || null };
    },
    async githubBackfill() {
      if (!senseCfg.githubUser) throw new Error('githubUser not configured');
      const token = process.env[senseCfg.githubTokenEnv];
      const text = await fetchGithubReport(senseCfg.githubUser, token, now(), fetchImpl);
      const day = localDay(now());
      const rel = `sense/github-${day}.md`;
      const full = join(dataDir, 'raw', rel);
      mkdirSync(join(dataDir, 'raw', 'sense'), { recursive: true });
      writeFileSync(full, text, 'utf8');
      return rel;
    },
  };

  return sense;
}