import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, realpathSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, normalize, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ensureDataDirs } from './store.js';


export function understandingRoot(dataDir: string): string {
  return join(dataDir, 'understanding');
}

export function ensureUnderstandingRepo(dataDir: string): void {
  ensureDataDirs(dataDir);
  const base = understandingRoot(dataDir);
  if (!existsSync(base)) mkdirSync(base, { recursive: true });
  if (!existsSync(join(base, '.git'))) {
    try { execFileSync('git', ['init', '-q'], { cwd: base, stdio: 'ignore' }); } catch {}
  }
  try { execFileSync('git', ['config', 'user.email', 'avatar@local'], { cwd: base, stdio: 'ignore' }); } catch {}
  try { execFileSync('git', ['config', 'user.name', 'avatar'], { cwd: base, stdio: 'ignore' }); } catch {}
}


function checkGitSegment(rel: string): void {
  const norm = normalize(rel);
  const segs = norm.split(sep).filter(Boolean);
  if (segs.includes('.git')) throw new Error('path escapes base');
  if (norm === '' || norm === '.' || norm === '/') throw new Error('path escapes base');
}

export function resolveUnderstandingPath(dataDir: string, rel: string): string {
  if (typeof rel !== 'string' || rel.trim() === '') throw new Error('path escapes base');
  const base = understandingRoot(dataDir);
  const baseResolved = existsSync(base) ? realpathSync(base) : resolve(base);
  if (!existsSync(base)) mkdirSync(base, { recursive: true });

  checkGitSegment(rel);

  const target = isAbsolute(rel) ? rel : resolve(base, rel);
  const relp = relative(base, target);
  if (relp === '' ) throw new Error('path escapes base');
  if (relp.startsWith('..') || isAbsolute(relp)) throw new Error('path escapes base');

  // deepest existing ancestor realpath check
  let cur = target;
  while (cur !== base && cur !== resolve(base, '..') && !existsSync(cur)) {
    cur = resolve(cur, '..');
  }
  if (existsSync(cur)) {
    const real = realpathSync(cur);
    const realBase = existsSync(base) ? realpathSync(base) : base;
    const rr = relative(realBase, real);
    if (rr.startsWith('..') || isAbsolute(rr)) throw new Error('path escapes base');
  }

  // ensure any segment not .git after normalize
  const segs = normalize(relative(base, target)).split(sep).filter(Boolean);
  if (segs.includes('.git')) throw new Error('path escapes base');
  // also reject if rel itself points to base
  if (target === base || target === baseResolved) throw new Error('path escapes base');

  return target;
}

function commitAll(dataDir: string, message: string): void {
  const root = understandingRoot(dataDir);
  try {
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString();
    if (status.trim()) {
      execFileSync('git', ['commit', '-q', '-m', message], { cwd: root, stdio: 'ignore' });
    }
  } catch {}
}

export function listFiles(dataDir: string, sub = ''): string[] {
  ensureUnderstandingRepo(dataDir);
  const base = understandingRoot(dataDir);
  const start = (sub && sub !== '.' && sub !== '') ? resolveUnderstandingPath(dataDir, sub) : base;
  if (!existsSync(start)) return [];
  const out: string[] = [];
  function walk(dir: string, prefix: string) {
    for (const name of readdirSync(dir)) {
      if (name === '.git') continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full, prefix ? `${prefix}/${name}` : name);
      else out.push(prefix ? `${prefix}/${name}` : name);
    }
  }
  const pref = (sub && sub !== '.' && sub !== '') ? sub : '';
  walk(start, pref);
  return out;
}

export function readFileUnder(dataDir: string, rel: string): string {
  ensureUnderstandingRepo(dataDir);
  const base = understandingRoot(dataDir);
  if (rel === '' || rel === '.' || rel === '/') throw new Error('path escapes base');
  const full = resolveUnderstandingPath(dataDir, rel);
  if (!existsSync(full)) throw new Error('not found');
  const st = statSync(full);
  if (st.isDirectory()) throw new Error('not found');
  return readFileSync(full, 'utf8');
}

export function writeFileUnder(dataDir: string, rel: string, content: string, commitMessage?: string): void {
  if (rel === '' || rel === '.' || rel === '/') throw new Error('path escapes base');
  ensureUnderstandingRepo(dataDir);
  const full = resolveUnderstandingPath(dataDir, rel);
  const parent = resolve(full, '..');
  mkdirSync(parent, { recursive: true });
  writeFileSync(full, content, 'utf8');
  const msg = commitMessage || `update understanding: ${rel}`;
  commitAll(dataDir, msg);
}

export function deleteFileUnder(dataDir: string, rel: string, commitMessage?: string): void {
  if (rel === '' || rel === '.' || rel === '/') throw new Error('path escapes base');
  ensureUnderstandingRepo(dataDir);
  const full = resolveUnderstandingPath(dataDir, rel);
  if (!existsSync(full)) throw new Error('not found');
  rmSync(full, { force: true, recursive: true });
  const msg = commitMessage || `delete understanding: ${rel}`;
  commitAll(dataDir, msg);
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function understandingHistory(dataDir: string, limit?: number): string {
  ensureUnderstandingRepo(dataDir);
  const root = understandingRoot(dataDir);
  try {
    const args = ['log', '--oneline'];
    if (limit && limit > 0) args.push(`-${limit}`);
    const out = execFileSync('git', args, { cwd: root }).toString();
    return out.trim();
  } catch {
    return '';
  }
}

export function rollbackUnderstanding(dataDir: string, ref: string): void {
  ensureUnderstandingRepo(dataDir);
  const root = understandingRoot(dataDir);
  // verify ref
  execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['rm', '-rf', '--ignore-unmatch', '.'], { cwd: root, stdio: 'ignore' });
  try { execFileSync('git', ['clean', '-fdx'], { cwd: root, stdio: 'ignore' }); } catch {}
  execFileSync('git', ['checkout', ref, '--', '.'], { cwd: root, stdio: 'ignore' });
  // stage & commit
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  try {
    execFileSync('git', ['commit', '-q', '-m', `rollback to ${ref}`], { cwd: root, stdio: 'ignore' });
  } catch {}
}
