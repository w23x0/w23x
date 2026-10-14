import { contentHash } from './data/understanding.js';
import { ensureDataDirs } from './data/store.js';
import { appendRaw, allRaw } from './data/raw.js';
import type { RawMessage } from './data/raw.js';
import { createApp } from './app.js';
import type { AppConfig } from './config.js';
import type { ResolvedModel } from './model.js';

function chunkText(text: string, max = 4000): string[] {
  // Split only at blank-line (paragraph) boundaries; a paragraph larger than max stays intact (verbatim).
  const parts = text.split('\n\n');
  const chunks: string[] = [];
  let cur = '';
  for (const p of parts) {
    if (cur === '') {
      cur = p;
    } else if (cur.length + 2 + p.length <= max) {
      cur = cur + '\n\n' + p;
    } else {
      chunks.push(cur);
      cur = p;
    }
  }
  if (cur !== '') chunks.push(cur);
  return chunks.length ? chunks : [''];
}

export function importSeed(dataDir: string, input: { text: string; label: string; date: string }, now?: () => number): { imported: number; skipped: boolean } {
  ensureDataDirs(dataDir);
  const ts = (now || Date.now)();
  const hash = contentHash(input.text);
  const existing = allRaw(dataDir);
  if (existing.some((m) => m.role === 'import' && m.source?.hash === hash)) {
    return { imported: 0, skipped: true };
  }
  const chunks = chunkText(input.text, 4000);
  const total = chunks.length;
  for (let i = 0; i < total; i++) {
    const msg: RawMessage = {
      ts,
      channel: 'import',
      userId: '',
      role: 'import',
      text: chunks[i],
      source: { kind: 'import', label: input.label, date: input.date, hash, part: i + 1, parts: total },
    };
    appendRaw(dataDir, msg);
  }
  return { imported: total, skipped: false };
}

export async function runSeedImport(deps: { config: AppConfig; models: { primary: ResolvedModel; reflection: ResolvedModel } },
  input: { text: string; label: string; date: string }): Promise<{ imported: number; skipped: boolean; reflection: { ran: boolean; reason?: string } }> {
  const res = importSeed(deps.config.dataDir, input);
  const app = createApp({ config: deps.config, models: deps.models, adapters: [] });
  const reflection = await app.runReflection();
  return { imported: res.imported, skipped: res.skipped, reflection };
}