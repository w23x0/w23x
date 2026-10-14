import { Type } from '@earendil-works/pi-ai';
import { readFileUnder, writeFileUnder, deleteFileUnder, listFiles, contentHash, resolveUnderstandingPath } from '../data/understanding.js';
import { existsSync } from 'node:fs';
import { searchRaw, readRaw, allRaw } from '../data/raw.js';
export type MemoryToolMode = 'chat' | 'reflection' | 'proactive';

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
    {
      name: 'write_understanding',
      label: 'Write understanding file',
      description: 'Create or overwrite a file in the understanding layer. Relative path. Auto-committed to git.',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (_id: string, params: any) => {
        try {
          const path = params.path;
          const full = resolveUnderstandingPath(dataDir, path);
          // existence check
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
  ];

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