import type { BlockSignals, Interval, ActivityCard } from './types.js';
import type { SenseConfig } from '../config.js';

const MIN = 60000;

function localDay(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function titleMatches(patterns: string[], s: string): boolean {
  for (const p of patterns) {
    let re: RegExp | null = null;
    try { re = new RegExp(p, 'i'); } catch { re = null; }
    if (re) { if (re.test(s)) return true; }
    else { if (s.toLowerCase().includes(String(p).toLowerCase())) return true; }
  }
  return false;
}

export function applyExclusions(sig: BlockSignals, ex: SenseConfig['exclude']): BlockSignals {
  const apps = ex?.apps || [];
  const titlePatterns = ex?.titlePatterns || [];
  const domains = ex?.domains || [];

  function appExcluded(app: string): boolean {
    return apps.some((a) => a && app.toLowerCase().includes(String(a).toLowerCase()));
  }
  function domainExcluded(url: string): boolean {
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
    return domains.some((d) => {
      const dd = String(d).toLowerCase();
      return host === dd || host.endsWith('.' + dd);
    });
  }

  return {
    start: sig.start,
    end: sig.end,
    awAvailable: sig.awAvailable,
    window: sig.window.map((w) => {
      if (appExcluded(w.app) || titleMatches(titlePatterns, w.title)) {
        return { ...w, app: '[excluded]', title: '' };
      }
      return { ...w };
    }),
    afk: sig.afk.map((a) => ({ ...a })),
    web: sig.web.map((w) => {
      if (domainExcluded(w.url) || titleMatches(titlePatterns, w.title)) {
        return { ...w, url: '[excluded]', title: '' };
      }
      return { ...w };
    }),
    media: sig.media.map((m) => {
      if (titleMatches(titlePatterns, m.title) || (m.artist && titleMatches(titlePatterns, m.artist))) {
        const { artist: _a, album: _b, ...rest } = m;
        return { ...rest, title: '[excluded]', artist: undefined, album: undefined } as any;
      }
      return { ...m };
    }),
    commits: sig.commits.map((c) => ({ ...c })),
    prompts: sig.prompts.map((p) => {
      if (titleMatches(titlePatterns, p.text)) return { ...p, text: '[excluded]' };
      return { ...p };
    }),
  };
}

function clipRange(start: number, end: number, pauses: Interval[]): [number, number][] {
  let segments: [number, number][] = [[start, end]];
  for (const p of pauses) {
    const next: [number, number][] = [];
    for (const [a, b] of segments) {
      if (p.end <= a || p.start >= b) { next.push([a, b]); continue; }
      if (a < p.start) next.push([a, Math.min(b, p.start)]);
      if (p.end < b) next.push([Math.max(a, p.end), b]);
    }
    segments = next.filter(([a, b]) => b > a);
  }
  return segments;
}

export function clipPauses(sig: BlockSignals, pauses: Interval[]): BlockSignals {
  const ps = pauses || [];
  return {
    start: sig.start,
    end: sig.end,
    awAvailable: sig.awAvailable,
    window: sig.window.flatMap((w) => clipRange(w.start, w.end, ps).map(([a, b]) => ({ ...w, start: a, end: b }))),
    afk: sig.afk.flatMap((a) => clipRange(a.start, a.end, ps).map(([s, e]) => ({ ...a, start: s, end: e }))),
    web: sig.web.flatMap((w) => clipRange(w.start, w.end, ps).map(([s, e]) => ({ ...w, start: s, end: e }))),
    media: sig.media.flatMap((m) => clipRange(m.start, m.end, ps).map(([s, e]) => ({ ...m, start: s, end: e }))),
    commits: sig.commits.filter((c) => !ps.some((p) => c.ts >= p.start && c.ts < p.end)),
    prompts: sig.prompts.filter((p) => !ps.some((pp) => p.ts >= pp.start && p.ts < pp.end)),
  };
}

function unionMinutes(ivs: [number, number][]): number {
  if (!ivs.length) return 0;
  const sorted = [...ivs].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = sorted[0][0];
  let curEnd = sorted[0][1];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][0] <= curEnd) curEnd = Math.max(curEnd, sorted[i][1]);
    else { total += curEnd - curStart; curStart = sorted[i][0]; curEnd = sorted[i][1]; }
  }
  total += curEnd - curStart;
  return Math.round(total / MIN);
}

function intersectMinutes(a: number, b: number, ivs: [number, number][]): number {
  let total = 0;
  for (const [s, e] of ivs) {
    total += Math.max(0, Math.min(b, e) - Math.max(a, s));
  }
  return total;
}

export function summarizeBlock(sig: BlockSignals): { activeMinutes: number; afkMinutes: number; empty: boolean; text: string } {
  const blockStart = sig.start;
  const blockEnd = sig.end;
  const presentIvs: [number, number][] = sig.afk.filter((a) => !a.afk).map((a) => [Math.max(a.start, blockStart), Math.min(a.end, blockEnd)] as [number, number]).filter(([s, e]) => e > s);
  const afkIvs: [number, number][] = sig.afk.filter((a) => a.afk).map((a) => [Math.max(a.start, blockStart), Math.min(a.end, blockEnd)] as [number, number]).filter(([s, e]) => e > s);

  const activeMinutes = unionMinutes(presentIvs);
  const afkMinutes = unionMinutes(afkIvs);

  const empty = sig.window.length === 0 && sig.afk.length === 0 && sig.web.length === 0 && sig.media.length === 0 && sig.commits.length === 0 && sig.prompts.length === 0;

  const lines: string[] = [];
  lines.push(`${hhmm(blockStart)}–${hhmm(blockEnd)}`);
  lines.push(`在场 ${activeMinutes} 分钟，离开 ${afkMinutes} 分钟`);
  if (!sig.awAvailable) lines.push('ActivityWatch 不可用');

  // apps
  const appMap = new Map<string, { minutes: number; titles: Map<string, number> }>();
  for (const w of sig.window) {
    const dur = intersectMinutes(Math.max(w.start, blockStart), Math.min(w.end, blockEnd), presentIvs);
    if (dur <= 0) continue;
    let entry = appMap.get(w.app);
    if (!entry) { entry = { minutes: 0, titles: new Map() }; appMap.set(w.app, entry); }
    entry.minutes += dur;
    const t = (w.title || '').slice(0, 120);
    if (t) entry.titles.set(t, (entry.titles.get(t) || 0) + dur);
  }
  if (appMap.size) {
    const appParts: string[] = [];
    for (const [app, info] of appMap) {
      const mins = Math.round(info.minutes / MIN);
      const titles = Array.from(info.titles.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);
      appParts.push(`${app} ${mins}m` + (titles.length ? ` (${titles.join(', ')})` : ''));
    }
    lines.push('应用: ' + appParts.join('; '));
  }

  // web
  const webMap = new Map<string, { minutes: number; titles: string[] }>();
  for (const w of sig.web) {
    const dur = w.audible
      ? Math.max(0, Math.min(w.end, blockEnd) - Math.max(w.start, blockStart))
      : intersectMinutes(Math.max(w.start, blockStart), Math.min(w.end, blockEnd), presentIvs);
    if (dur <= 0) continue;
    let host = '';
    try { host = new URL(w.url).hostname; } catch { host = w.url; }
    let entry = webMap.get(host);
    if (!entry) { entry = { minutes: 0, titles: [] }; webMap.set(host, entry); }
    entry.minutes += dur;
    if (w.title && !entry.titles.includes(w.title)) entry.titles.push(w.title);
  }
  if (webMap.size) {
    const webParts: string[] = [];
    for (const [host, info] of webMap) {
      const mins = Math.round(info.minutes / MIN);
      webParts.push(`${host} ${mins}m` + (info.titles.length ? ` (${info.titles.slice(0, 5).join(', ')})` : ''));
    }
    lines.push('网页: ' + webParts.join('; '));
  }

  // media
  const mediaMap = new Map<string, { minutes: number; firstStart: number; player: string; title: string; artist?: string }>();
  for (const m of sig.media) {
    const dur = Math.max(0, Math.min(m.end, blockEnd) - Math.max(m.start, blockStart));
    if (dur <= 0) continue;
    const key = `${m.title}\u0000${m.artist || ''}`;
    let entry = mediaMap.get(key);
    if (!entry) {
      entry = { minutes: 0, firstStart: m.start, player: m.player, title: m.title, artist: m.artist };
      mediaMap.set(key, entry);
    }
    entry.minutes += dur;
    if (m.start < entry.firstStart) entry.firstStart = m.start;
  }
  if (mediaMap.size) {
    const mediaParts: string[] = [];
    for (const [, info] of mediaMap) {
      const mins = Math.round(info.minutes / MIN);
      const title = (info.title || '').slice(0, 120);
      mediaParts.push(`${title}${info.artist ? ' - ' + info.artist : ''} ${mins}m ${info.player} ${hhmm(info.firstStart)}`);
    }
    lines.push('媒体: ' + mediaParts.join('; '));
  }

  // commits
  if (sig.commits.length) {
    lines.push('提交:');
    for (const c of [...sig.commits].sort((a, b) => a.ts - b.ts)) {
      lines.push(`  ${hhmm(c.ts)} ${c.repo}: ${c.message}`);
    }
  }

  // prompts
  if (sig.prompts.length) {
    lines.push('消息:');
    for (const p of [...sig.prompts].sort((a, b) => a.ts - b.ts)) {
      const text = (p.text || '').slice(0, 300);
      lines.push(`  ${hhmm(p.ts)} ${p.project}: ${text}`);
    }
  }

  return { activeMinutes, afkMinutes, empty, text: lines.join('\n') };
}

export function formatDayDigest(day: string, daySummary: string, cards: ActivityCard[]): string {
  const sorted = [...cards].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  parts.push(`# ${day}`);
  parts.push('');
  parts.push(daySummary || '');
  parts.push('');
  for (const c of sorted) {
    parts.push(`## ${hhmm(c.start)}–${hhmm(c.end)}`);
    if (c.paused) parts.push('（暂停）');
    else if (c.card) parts.push(c.card);
    else if (c.empty) parts.push('（无数据）');
    else parts.push(c.summary);
    parts.push('');
  }
  return parts.join('\n');
}
