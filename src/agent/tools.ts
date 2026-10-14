import { readFileUnder, writeFileUnder, deleteFileUnder, listFiles, contentHash, resolveUnderstandingPath } from '../data/understanding.js';
import { Type } from '@earendil-works/pi-ai';
import { searchRaw, readRaw, allRaw } from '../data/raw.js';
import { join } from 'node:path';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { readActivityCards, localDay } from '../sense/pipeline.js';
export type MemoryToolMode = 'chat' | 'proactive' | 'reflection' | 'interview';

export interface MemoryToolContext {
  dataDir: string;
  mode: MemoryToolMode;
  readVersions: Map<string, string>;
  sendMessage?: (channel: string | undefined, text: string) => Promise<void>;
  scheduleNextWake?: (minutes: number, reason: string) => string | void;
}

function textResult(text: string, details?: any) {
  return { content: [{ type: 'text' as const, text }], details };
}

function errResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: {}, isError: true };
}

export function createMemoryTools(ctx: MemoryToolContext): any[] {
  const { dataDir, mode, readVersions } = ctx;
  const isObserver = mode === 'reflection' || mode === 'interview';
  const tools: any[] = [
    {
      name: 'list_understanding',
      label: 'List understanding files',
      description: 'List files in the understanding layer (agent-managed). Optional subpath.',
      parameters: Type.Object({ path: Type.Optional(Type.String({ description: 'subdirectory' })) }),
      execute: async (_id: string, params: any) => {
        try {
          const files = listFiles(dataDir, params?.path || '');
          return textResult(files.length ? files.join('\n') : '(empty)', { files });
        } catch (e: any) {
          return errResult(`error: ${e?.message || e}`);
        }
      },
    },
    {
      name: 'read_understanding',
      label: 'Read understanding file',
      description: 'Read a file from the understanding layer by relative path.',
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_id: string, params: any) => {
        try {
          const path = params.path;
          const c = readFileUnder(dataDir, path);
          readVersions.set(resolveUnderstandingPath(dataDir, path), contentHash(c));
          return textResult(c);
        } catch (e: any) {
          return errResult(`error: ${e?.message || e}`);
        }
      },
    },
  ];

  if (isObserver) {
    tools.push({
      name: 'write_understanding',
      label: 'Write understanding file',
      description: 'Create or overwrite a file in the understanding layer. Relative path. Auto-committed to git.',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (_id: string, params: any) => {
        try {
          const path = params.path;
          const full = resolveUnderstandingPath(dataDir, path);
          const exists = existsSync(full);
          if (exists) {
            const prevHash = readVersions.get(full);
            if (!prevHash) return errResult('stale: file not read this run; read it first');
            const current = readFileUnder(dataDir, path);
            if (contentHash(current) !== prevHash) return errResult('stale: file changed since read; re-read and merge');
          }
          writeFileUnder(dataDir, path, params.content);
          const newContent = readFileUnder(dataDir, path);
          readVersions.set(resolveUnderstandingPath(dataDir, path), contentHash(newContent));
          return textResult(`wrote ${path}`);
        } catch (e: any) {
          return errResult(`error: ${e?.message || e}`);
        }
      },
    });
    tools.push({
      name: 'delete_understanding',
      label: 'Delete understanding file',
      description: 'Delete a file from the understanding layer.',
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_id: string, params: any) => {
        try {
          const path = params.path;
          const full = resolveUnderstandingPath(dataDir, path);
          const exists = existsSync(full);
          if (exists) {
            const prevHash = readVersions.get(full);
            if (!prevHash) return errResult('stale: file not read this run; read it first');
            const current = readFileUnder(dataDir, path);
            if (contentHash(current) !== prevHash) return errResult('stale: file changed since read; re-read');
          }
          deleteFileUnder(dataDir, path);
          readVersions.delete(full);
          return textResult(`deleted ${path}`);
        } catch (e: any) {
          return errResult(`error: ${e?.message || e}`);
        }
      },
    });
  // activity tools (observer only)
  tools.push({ name: 'list_activity', label: 'List activity cards and reports', description: 'List dates with activity cards, plus digests/ and sense/ files.', parameters: Type.Object({}), execute: async () => { try { const lines: string[] = ['activity days:']; const rawDir = join(dataDir, 'raw'); const days: { date: string; count: number }[] = []; try { for (const f of readdirSync(rawDir).filter((x) => x.startsWith('activity-') && x.endsWith('.jsonl')).sort()) { const date = f.slice('activity-'.length, -'.jsonl'.length); const count = readFileSync(join(rawDir, f), 'utf8').split('\n').filter((l) => l.trim()).length; days.push({ date, count }); } } catch {} for (const d of days) lines.push(`${d.date}: ${d.count} segments`); lines.push('digests:'); try { for (const f of readdirSync(join(rawDir, 'digests')).filter((x) => x.endsWith('.md')).sort()) lines.push(`digests/${f}`); } catch {} lines.push('sense:'); try { for (const f of readdirSync(join(rawDir, 'sense')).filter((x) => x.endsWith('.md')).sort()) lines.push(`sense/${f}`); } catch {} return textResult(lines.join('\n')); } catch (e: any) { return errResult(`error: ${e?.message || e}`); } } });
  tools.push({ name: 'read_activity', label: 'Read activity cards for a day', description: 'Read activity cards. Defaults to today. from_end reads last N.', parameters: Type.Object({ date: Type.Optional(Type.String()), from_end: Type.Optional(Type.Number()) }), execute: async (_id: any, params: any) => { try { const date = params?.date || localDay(Date.now()); const cards = readActivityCards(dataDir, date); let sel = cards; if (params?.from_end) sel = cards.slice(Math.max(0, cards.length - (params.from_end as number))); const hhmm = (ts: number) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }; const out = sel.map((c: any) => { const note = c.paused ? '（暂停）' : c.card ? c.card : (c.empty ? '（无数据）' : c.summary); return `[${hhmm(c.start)}–${hhmm(c.end)}] 在场 ${c.activeMinutes}m / 离开 ${c.afkMinutes}m\n${note}`; }); return textResult(out.join('\n\n') || '(none)'); } catch (e: any) { return errResult(`error: ${e?.message || e}`); } } });
  tools.push({ name: 'read_activity_file', label: 'Read a digest or sense report', description: 'Read a file under raw/digests/ or raw/sense/. Char offset/limit.', parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }), execute: async (_id: any, params: any) => { try { const p = params.path; if (!p || p.startsWith('/') || p.includes('..')) return errResult('error: path escapes base'); if (!p.startsWith('digests/') && !p.startsWith('sense/')) return errResult('error: path escapes base'); const full = join(dataDir, 'raw', p); if (!existsSync(full)) return errResult('error: not found'); const content = readFileSync(full, 'utf8'); const offset = params?.offset && params.offset > 0 ? params.offset : 0; const limit = params?.limit && params.limit > 0 ? params.limit : 20000; const seg = content.slice(offset, offset + limit); return textResult(`${seg}\n\n[chars ${offset}-${offset + seg.length}/${content.length}]`); } catch (e: any) { return errResult(`error: ${e?.message || e}`); } } });
  tools.push({ name: 'search_activity', label: 'Search activity cards and reports', description: 'Search cards and digest/sense files.', parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }), execute: async (_id: any, params: any) => { try { const limit = params?.limit && params.limit > 0 ? params.limit : 40; let re: RegExp; try { re = new RegExp(params.query, 'i'); } catch { re = new RegExp(params.query.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&'), 'i'); } const hits: string[] = []; try { const rawDir = join(dataDir, 'raw'); for (const f of readdirSync(rawDir).filter((x) => x.startsWith('activity-') && x.endsWith('.jsonl')).sort()) { const date = f.slice('activity-'.length, -'.jsonl'.length); const cards = readActivityCards(dataDir, date); for (const c of cards) { const hhmm = (ts: number) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }; for (const text of [c.card, c.summary]) { if (text && re.test(text) && hits.length < limit) hits.push(`[${date} ${hhmm(c.start)}] ${text.slice(0, 200)}`); } } } } catch {} try { const rawDir = join(dataDir, 'raw'); for (const sub of ['digests', 'sense']) { let files: string[] = []; try { files = readdirSync(join(rawDir, sub)).filter((x) => x.endsWith('.md')).sort(); } catch {} for (const f of files) { const full = join(rawDir, sub, f); const content = readFileSync(full, 'utf8'); for (const line of content.split('\n')) { if (line.trim() && re.test(line) && hits.length < limit) hits.push(`[${sub}/${f}] ${line.trim().slice(0, 200)}`); } } } } catch {} return textResult(hits.join('\n') || '(no matches)'); } catch (e: any) { return errResult(`error: ${e?.message || e}`); } } });
  }

  tools.push({
    name: 'search_raw',
    label: 'Search raw conversations',
    description: 'Search the append-only raw conversation log by text/regex. Returns recent matches.',
    parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }),
    execute: async (_id: string, params: any) => {
      try {
        const hits = searchRaw(dataDir, params.query, params.limit || 40);
        const all = allRaw(dataDir);
        const lines = hits.map((h) => {
          const idx = all.indexOf(h);
          const text = `${h.text} ${h.attachments?.map((a: any) => a.transcript || '').join(' ')}`.trim();
          let re: RegExp;
          try { re = new RegExp(params.query, 'i'); } catch { re = new RegExp(params.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
          const m = re.exec(text);
          let snippet = text;
          if (text.length > 400) {
            if (m) {
              const start = Math.max(0, m.index - 200);
              const end = Math.min(text.length, m.index + m[0].length + 200);
              snippet = (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');
            } else {
              snippet = text.slice(0, 400) + '...';
            }
          }
          const src = h.source ? ` [import: ${h.source.label}, ${h.source.date}, part ${h.source.part}/${h.source.parts}]` : '';
          return `[offset ${idx}] [${new Date(h.ts).toISOString()}][${h.channel}][${h.role}]${src} ${snippet}`;
        });
        return textResult(lines.join('\n') || '(no matches)', { count: hits.length });
      } catch (e: any) {
        return errResult(`error: ${e?.message || e}`);
      }
    },
  });

  tools.push({
    name: 'read_raw',
    label: 'Read raw conversations',
    description: 'Read raw conversation messages with pagination.',
    parameters: Type.Object({ offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()), from_end: Type.Optional(Type.Boolean()) }),
    execute: async (_id: string, params: any) => {
      try {
        const res = readRaw(dataDir, { offset: params?.offset, limit: params?.limit, fromEnd: params?.from_end });
        const text = res.messages.map((h) => {
          const src = h.source ? ` [import: ${h.source.label}, ${h.source.date}, part ${h.source.part}/${h.source.parts}]` : '';
          return `[${new Date(h.ts).toISOString()}][${h.channel}][${h.role}]${src} ${h.text}`;
        }).join('\n');
        return textResult(text || '(none)', { total: res.total, offset: res.offset, count: res.messages.length });
      } catch (e: any) {
        return errResult(`error: ${e?.message || e}`);
      }
    },
  });

  if (mode === 'proactive') {
    tools.push({
      name: 'send_message',
      label: 'Send message to user',
      description: 'Proactively send a message to the user. Contacts are held by app. Optional channel.',
      parameters: Type.Object({ text: Type.String(), channel: Type.Optional(Type.String()) }),
      execute: async (_id: string, params: any) => {
        try {
          if (!ctx.sendMessage) return errResult('send unavailable');
          await ctx.sendMessage(params.channel, params.text);
          return textResult('sent');
        } catch (e: any) {
          return errResult(`error: ${e?.message || e}`);
        }
      },
    });
    tools.push({
      name: 'schedule_next_wake',
      label: 'Schedule next wake',
      description: 'Schedule the next proactive wake-up in minutes (minimum enforced by app).',
      parameters: Type.Object({ minutes: Type.Number(), reason: Type.String() }),
      execute: async (_id: string, params: any) => {
        try {
          if (!ctx.scheduleNextWake) return errResult('scheduling unavailable');
          const r = ctx.scheduleNextWake(params.minutes, params.reason);
          return textResult(r ? String(r) : 'scheduled');
        } catch (e: any) {
          return errResult(`error: ${e?.message || e}`);
        }
      },
    });
  }

  return tools;
}
