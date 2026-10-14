import { mkdirSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';

export function ensureDataDirs(dataDir: string): void {
  for (const sub of ['', 'raw', 'raw/media', 'understanding', 'state']) {
    mkdirSync(join(dataDir, sub), { recursive: true });
  }
}

export function safeResolveUnder(base: string, rel: string): string {
  const target = isAbsolute(rel) ? rel : resolve(base, rel);
  const relp = relative(base, target);
  if (relp === '' ) throw new Error('path escapes base');
  if (relp.startsWith('..') || isAbsolute(relp)) throw new Error('path escapes base');
  return target;
}