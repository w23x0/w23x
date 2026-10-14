import { appendFileSync, readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type RawRole = 'user' | 'assistant' | 'proactive' | 'import';

export interface RawAttachment { kind: 'image' | 'voice'; mimeType: string; file: string; transcript?: string }

export interface RawSource { kind: 'import'; label: string; date: string; hash: string; part: number; parts: number }
export interface RawMessage {
  ts: number;
  channel: string;
  userId: string;
  role: RawRole;
  text: string;
  attachments?: RawAttachment[];
  source?: RawSource;
}

export function appendRaw(dataDir: string, m: RawMessage): void {
  const dir = join(dataDir, 'raw');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const date = new Date(m.ts).toISOString().slice(0, 10);
  const file = join(dir, `messages-${date}.jsonl`);
  appendFileSync(file, JSON.stringify(m) + '\n', 'utf8');
}

export function saveRawMedia(dataDir: string, data: Buffer, ext: string): string {
  const dir = join(dataDir, 'raw', 'media');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const suffix = ext.startsWith('.') ? ext : `.${ext}`;
  let name = `${randomUUID()}${suffix}`;
  let full = join(dir, name);
  // avoid overwrite (uuid practically unique; loop just in case)
  while (existsSync(full)) {
    name = `${randomUUID()}${suffix}`;
    full = join(dir, name);
  }
  writeFileSync(full, data);
  return `media/${name}`;
}

export function allRaw(dataDir: string): RawMessage[] {
  const dir = join(dataDir, 'raw');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => f.startsWith('messages-') && f.endsWith('.jsonl')).sort();
  const out: RawMessage[] = [];
  for (const f of files) {
    const lines = readFileSync(join(dir, f), 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
  }
  return out;
}

export function searchRaw(dataDir: string, query: string, limit = 40): RawMessage[] {
  let re: RegExp;
  try { re = new RegExp(query, 'i'); }
  catch { re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  const msgs = allRaw(dataDir);
  const res: RawMessage[] = [];
  for (let i = msgs.length - 1; i >= 0 && res.length < limit; i--) {
    if (re.test(`${msgs[i].text} ${msgs[i].attachments?.map(a=>a.transcript||'').join(' ')}`)) res.push(msgs[i]);
  }
  return res.reverse();
}

export function readRaw(dataDir: string, opts: { offset?: number; limit?: number; fromEnd?: boolean }): { total: number; offset: number; messages: RawMessage[] } {
  const msgs = allRaw(dataDir);
  const total = msgs.length;
  const limit = opts.limit && opts.limit > 0 ? opts.limit : total;
  if (opts.fromEnd) {
    const slice = msgs.slice(Math.max(0, total - limit));
    return { total, offset: Math.max(0, total - limit), messages: slice };
  }
  const offset = opts.offset && opts.offset > 0 ? opts.offset : 0;
  const slice = msgs.slice(offset, offset + limit);
  return { total, offset, messages: slice };
}