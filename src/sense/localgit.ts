import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

export function findGitRepos(roots: string[], maxDepth: number = 3): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let isGit = false;
    try { isGit = existsSync(join(dir, '.git')); } catch { isGit = false; }
    if (isGit) {
      if (!seen.has(dir)) { seen.add(dir); result.push(dir); }
      return;
    }
    if (depth === maxDepth) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    entries.sort();
    for (const name of entries) {
      if (name === 'node_modules') continue;
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      let st: any;
      try { st = statSync(full); } catch { continue; }
      if (!st.isDirectory()) continue;
      walk(full, depth + 1);
    }
  }
  for (const root of roots || []) {
    try { if (existsSync(root)) walk(root, 0); } catch { /* skip */ }
  }
  result.sort();
  return result;
}

export interface CommitEventLike { ts: number; repo: string; message: string; author?: string }

export function gitCommits(repos: string[], start: number, end: number): CommitEventLike[] {
  const out: CommitEventLike[] = [];
  const seen = new Set<string>();
  const sinceSec = Math.floor(start / 1000);
  const untilSec = Math.floor(end / 1000);
  for (const repo of repos || []) {
    try {
      const raw = execFileSync(
        'git',
        ['-C', repo, 'log', '--all', `--since=@${sinceSec}`, `--until=@${untilSec}`, '--format=%H%x09%ct%x09%an%x09%s'],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      ).toString('utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        if (parts.length < 4) continue;
        const hash = parts[0];
        const ts = parseInt(parts[1], 10) * 1000;
        if (!Number.isFinite(ts)) continue;
        if (ts < start || ts >= end) continue;
        if (seen.has(hash)) continue;
        seen.add(hash);
        out.push({ ts, repo: basename(repo), message: parts.slice(3).join('\t'), author: parts[2] });
      }
    } catch {
      // skip repo
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}