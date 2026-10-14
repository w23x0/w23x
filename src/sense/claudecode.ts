import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface PromptEventLike { ts: number; project: string; text: string }

export function claudePrompts(dir: string, start: number, end: number): PromptEventLike[] {
  const out: PromptEventLike[] = [];
  let subdirs: string[] = [];
  try { subdirs = readdirSync(dir); } catch { return out; }
  for (const sub of subdirs) {
    const subPath = join(dir, sub);
    let st: any;
    try { st = statSync(subPath); } catch { continue; }
    if (!st.isDirectory()) continue;
    let files: string[] = [];
    try { files = readdirSync(subPath).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const filePath = join(subPath, f);
      try { if (statSync(filePath).mtimeMs < start) continue; } catch { continue; }
      let raw = '';
      try { raw = readFileSync(filePath, 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let obj: any;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj?.type !== 'user') continue;
        if (obj?.isMeta === true) continue;
        if (obj?.isSidechain === true) continue;
        const content = obj?.message?.content;
        let text: string | null = null;
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
          if (content.some((c: any) => c?.type === 'tool_result')) continue;
          if (!content.every((c: any) => c?.type === 'text')) continue;
          text = content.map((c: any) => c?.text ?? '').join('');
        } else continue;
        if (text === null) continue;
        if (text.startsWith('<command-') || text.startsWith('<local-command') || text.startsWith('<system-reminder')) continue;
        const ts = Date.parse(obj?.timestamp);
        if (!Number.isFinite(ts) || ts < start || ts >= end) continue;
        const project = obj?.cwd || sub;
        out.push({ ts, project, text });
      }
    }
  }
  return out;
}