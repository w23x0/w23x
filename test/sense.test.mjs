// Acceptance tests for v3: local activity sensing (sense).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../dist/config.js';
import { applyExclusions, clipPauses, summarizeBlock, formatDayDigest } from '../dist/sense/summarize.js';
import { createActivityWatchSource } from '../dist/sense/activitywatch.js';
import { findGitRepos, gitCommits } from '../dist/sense/localgit.js';
import { claudePrompts } from '../dist/sense/claudecode.js';
import { fetchGithubReport } from '../dist/sense/github.js';
import { createSense, readActivityCards, localDay, TIMELINE_PROMPT } from '../dist/sense/pipeline.js';
import { createMemoryTools } from '../dist/agent/tools.js';
import { createApp } from '../dist/app.js';
import { appendRaw } from '../dist/data/raw.js';
import { createInterview } from '../dist/interview.js';
import { tmpDataDir, fauxModel, mockAdapter, baseConfig, say, readJsonl, waitFor } from './helpers.mjs';

const MIN = 60_000;
const D0 = new Date(2026, 9, 14, 0, 0, 0, 0).getTime();   // local midnight 2026-10-14
const D1 = new Date(2026, 9, 15, 0, 0, 0, 0).getTime();
const DAY0 = '2026-10-14';

function senseCfg(over = {}) {
  return {
    activityWatchUrl: 'http://127.0.0.1:1', blockMinutes: 30, lagMinutes: 5, maxCatchupBlocks: 48,
    exclude: { apps: [], titlePatterns: [], domains: [] },
    githubTokenEnv: 'GITHUB_TOKEN', gitRoots: [],
    ...over,
  };
}
const emptySig = (start, end) => ({ start, end, awAvailable: true, window: [], afk: [], web: [], media: [], commits: [], prompts: [] });

/** Fake sources: returns fixture events overlapping [start,end), clipped. */
function fakeSources(fx, { failAt } = {}) {
  const calls = [];
  const clip = (arr, s, e) => arr.filter((x) => x.end > s && x.start < e).map((x) => ({ ...x, start: Math.max(x.start, s), end: Math.min(x.end, e) }));
  return {
    calls,
    async collect(start, end) {
      calls.push([start, end]);
      if (failAt !== undefined && start === failAt) throw new Error('source down');
      return {
        start, end, awAvailable: true,
        window: clip(fx.window || [], start, end), afk: clip(fx.afk || [], start, end),
        web: clip(fx.web || [], start, end), media: clip(fx.media || [], start, end),
        commits: (fx.commits || []).filter((c) => c.ts >= start && c.ts < end),
        prompts: (fx.prompts || []).filter((c) => c.ts >= start && c.ts < end),
      };
    },
  };
}
const isTimeline = (i) => !i.tools.includes('write_understanding');

function makeSense({ fx = {}, sense = {}, brain, failAt, dataDir = tmpDataDir() } = {}) {
  let nowVal = D0 + 2 * 60 * MIN + 6 * MIN;
  const reflection = fauxModel(brain || ((ctx, i) => say('卡片：他在写 Studium 的 eval')), { id: 'reflector' });
  const primary = fauxModel(() => say('persona'));
  const sources = fakeSources(fx, { failAt });
  const config = baseConfig(dataDir, { sense: senseCfg(sense) });
  const s = createSense({ config, models: { primary, reflection }, sources, now: () => nowVal });
  return { s, sources, reflection, dataDir, setNow: (v) => { nowVal = v; }, config };
}
const cardsFile = (d, day = DAY0) => join(d, 'raw', `activity-${day}.jsonl`);

// ---------------------------------------------------------------- config

test('config: sense absent → undefined; {} → defaults; ~ expanded; blockMinutes must divide 1440', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avatar-cfg-'));
  const write = (o) => { const p = join(dir, `c${Math.random()}.json`); writeFileSync(p, JSON.stringify({ dataDir: join(dir, 'data'), model: { id: 'm' }, ...o })); return p; };
  assert.equal(loadConfig({ configPath: write({}), env: {} }).sense, undefined);
  const s = loadConfig({ configPath: write({ sense: {} }), env: {} }).sense;
  assert.equal(s.activityWatchUrl, 'http://127.0.0.1:5600');
  assert.equal(s.blockMinutes, 30);
  assert.equal(s.lagMinutes, 5);
  assert.equal(s.maxCatchupBlocks, 48);
  assert.deepEqual(s.exclude, { apps: [], titlePatterns: [], domains: [] });
  assert.equal(s.githubTokenEnv, 'GITHUB_TOKEN');
  assert.deepEqual(s.gitRoots, []);
  const s2 = loadConfig({ configPath: write({ sense: { gitRoots: ['~/code'], claudeProjectsDir: '~/.claude/projects', exclude: { apps: ['x'] } } }), env: {} }).sense;
  assert.deepEqual(s2.gitRoots, [join(homedir(), 'code')]);
  assert.equal(s2.claudeProjectsDir, join(homedir(), '.claude/projects'));
  assert.deepEqual(s2.exclude, { apps: ['x'], titlePatterns: [], domains: [] });
  assert.throws(() => loadConfig({ configPath: write({ sense: { blockMinutes: 7 } }), env: {} }));
});

// ---------------------------------------------------------------- summarize

test('applyExclusions redacts apps, title patterns (regex or literal), domains, media and prompts without mutating input', () => {
  const sig = {
    ...emptySig(D0, D0 + 30 * MIN),
    window: [
      { start: D0, end: D0 + MIN, app: 'Telegram', title: 'chat with mom' },
      { start: D0, end: D0 + MIN, app: 'chrome', title: 'My Bank login' },
      { start: D0, end: D0 + MIN, app: 'chrome', title: 'a [invalid b' },
      { start: D0, end: D0 + MIN, app: 'chrome', title: 'docs' },
    ],
    web: [
      { start: D0, end: D0 + MIN, url: 'https://sub.example.com/x', title: 'hidden page' },
      { start: D0, end: D0 + MIN, url: 'https://notexample.com/y', title: 'visible page' },
    ],
    media: [{ start: D0, end: D0 + MIN, player: 'SodaM', title: '银行之歌', artist: 'someone', album: 'alb' }],
    prompts: [{ ts: D0, project: '/p', text: 'my bank password reset' }],
  };
  const before = JSON.stringify(sig);
  const out = applyExclusions(sig, { apps: ['telegram'], titlePatterns: ['bank|银行', '[invalid'], domains: ['example.com'] });
  assert.equal(JSON.stringify(sig), before, 'input not mutated');
  assert.deepEqual(out.window.map((w) => [w.app, w.title]), [['[excluded]', ''], ['[excluded]', ''], ['[excluded]', ''], ['chrome', 'docs']]);
  assert.deepEqual(out.web.map((w) => [w.url, w.title]), [['[excluded]', ''], ['https://notexample.com/y', 'visible page']]);
  assert.equal(out.media[0].title, '[excluded]');
  assert.equal(out.media[0].artist, undefined);
  assert.equal(out.media[0].album, undefined);
  assert.equal(out.prompts[0].text, '[excluded]');
  const text = JSON.stringify(out);
  for (const secret of ['chat with mom', 'My Bank', 'hidden page', 'sub.example.com', '银行之歌', 'password']) assert.ok(!text.includes(secret), secret);
});

test('clipPauses splits interval events and drops point events inside pauses', () => {
  const sig = {
    ...emptySig(D0, D0 + 30 * MIN),
    window: [{ start: D0, end: D0 + 30 * MIN, app: 'code', title: 't' }],
    commits: [{ ts: D0 + 15 * MIN, repo: 'r', message: 'in pause' }],
    prompts: [{ ts: D0 + 5 * MIN, project: 'p', text: 'kept' }],
  };
  const out = clipPauses(sig, [{ start: D0 + 10 * MIN, end: D0 + 20 * MIN }]);
  assert.deepEqual(out.window.map((w) => [w.start - D0, w.end - D0]), [[0, 10 * MIN], [20 * MIN, 30 * MIN]]);
  assert.equal(out.commits.length, 0);
  assert.equal(out.prompts.length, 1);
});

test('summarizeBlock: presence minutes, apps only while present, audible web, media regardless of afk, commits and prompts', () => {
  const sig = {
    ...emptySig(D0, D0 + 30 * MIN),
    afk: [{ start: D0, end: D0 + 20 * MIN, afk: false }, { start: D0 + 20 * MIN, end: D0 + 30 * MIN, afk: true }],
    window: [
      { start: D0, end: D0 + 15 * MIN, app: 'code', title: 'Studium eval' },
      { start: D0 + 15 * MIN, end: D0 + 30 * MIN, app: 'discord', title: '@pcbcat' },
    ],
    web: [
      { start: D0, end: D0 + 10 * MIN, url: 'https://github.com/w23x0/Studium', title: 'w23x0/Studium' },
      { start: D0 + 20 * MIN, end: D0 + 30 * MIN, url: 'https://www.bilibili.com/video/x', title: '某个视频', audible: true },
    ],
    media: [{ start: D0, end: D0 + 3 * MIN, player: 'SodaM', title: 'Old Town Road', artist: 'Lil Nas X' }],
    commits: [{ ts: D0 + 5 * MIN, repo: 'Studium', message: 'feat: eval loader' }],
    prompts: [{ ts: D0 + 6 * MIN, project: '/home/w23x/Studium', text: 'please fix the eval pipeline' }],
  };
  const s = summarizeBlock(sig);
  assert.equal(s.activeMinutes, 20);
  assert.equal(s.afkMinutes, 10);
  assert.equal(s.empty, false);
  for (const needle of ['00:00', '00:30', 'code', 'Studium eval', 'discord', 'github.com', 'bilibili.com', '某个视频', 'Old Town Road', 'Lil Nas X', 'feat: eval loader', 'please fix the eval pipeline']) {
    assert.ok(s.text.includes(needle), `summary should mention ${needle}:\n${s.text}`);
  }
  const e = summarizeBlock(emptySig(D0, D0 + 30 * MIN));
  assert.equal(e.empty, true);
  assert.equal(e.activeMinutes, 0);
  assert.ok(summarizeBlock({ ...emptySig(D0, D0 + 30 * MIN), awAvailable: false, commits: [{ ts: D0, repo: 'r', message: 'm' }] }).text.includes('ActivityWatch 不可用'));
});

test('formatDayDigest lists the day summary and cards in time order', () => {
  const md = formatDayDigest(DAY0, 'DAY-SUMMARY-TEXT', [
    { start: D0 + 60 * MIN, end: D0 + 90 * MIN, activeMinutes: 30, afkMinutes: 0, empty: false, paused: false, summary: 's2', card: 'SECOND-CARD' },
    { start: D0, end: D0 + 30 * MIN, activeMinutes: 30, afkMinutes: 0, empty: false, paused: false, summary: 's1', card: 'FIRST-CARD' },
  ]);
  assert.ok(md.includes(DAY0));
  assert.ok(md.includes('DAY-SUMMARY-TEXT'));
  assert.ok(md.indexOf('FIRST-CARD') >= 0 && md.indexOf('FIRST-CARD') < md.indexOf('SECOND-CARD'));
  assert.ok(md.includes('01:00'));
});

// ---------------------------------------------------------------- sources

test('ActivityWatch source: picks buckets by prefix, maps and clips events, throws on HTTP error', async () => {
  const urls = [];
  const ev = (offsetMs, durS, data) => ({ timestamp: new Date(D0 + offsetMs).toISOString(), duration: durS, data });
  const routes = {
    'aw-watcher-window_host': [ev(-MIN, 120, { app: 'code', title: 'clipped' }), ev(5 * MIN, 60, { app: 'chrome', title: 'page' })],
    'aw-watcher-afk_host': [ev(0, 600, { status: 'not-afk' }), ev(10 * MIN, 300, { status: 'afk' })],
    'aw-watcher-media-player_host': [ev(0, 180, { player: 'SodaM', title: 'Old Town Road', artist: 'Lil Nas X', album: 'A' }), ev(0, 10, { player: 'x' })],
    'aw-watcher-web-chrome': [ev(MIN, 30, { url: 'https://github.com', title: 'GitHub', audible: false })],
  };
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const u = new URL(String(url));
    if (u.pathname === '/api/0/buckets/') return new Response(JSON.stringify(Object.fromEntries([...Object.keys(routes), 'other_bucket'].map((k) => [k, { id: k }]))), { status: 200 });
    const m = u.pathname.match(/^\/api\/0\/buckets\/([^/]+)\/events$/);
    if (m) return new Response(JSON.stringify(routes[decodeURIComponent(m[1])] || []), { status: 200 });
    return new Response('nope', { status: 404 });
  };
  const aw = createActivityWatchSource('http://aw.test', fetchImpl);
  assert.ok((await aw.buckets()).includes('aw-watcher-web-chrome'));
  const r = await aw.collect(D0, D0 + 30 * MIN);
  assert.ok(urls.some((u) => u.includes('limit=-1')));
  assert.ok(!urls.some((u) => u.includes('other_bucket')));
  assert.deepEqual(r.window.map((w) => [w.app, w.start - D0, w.end - D0]), [['code', 0, MIN], ['chrome', 5 * MIN, 6 * MIN]]);
  assert.deepEqual(r.afk.map((a) => a.afk), [false, true]);
  assert.equal(r.media.length, 1);
  assert.equal(r.media[0].artist, 'Lil Nas X');
  assert.equal(r.web[0].url, 'https://github.com');
  const bad = createActivityWatchSource('http://aw.test', async () => new Response('err', { status: 500 }));
  await assert.rejects(() => bad.collect(D0, D0 + MIN));
});

test('claudePrompts keeps only real user messages in range', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  mkdirSync(join(dir, '-home-w23x-proj'));
  const at = (min) => new Date(D0 + min * MIN).toISOString();
  const lines = [
    { type: 'user', timestamp: at(1), cwd: '/home/w23x/proj', message: { role: 'user', content: 'PLAIN-PROMPT' } },
    { type: 'user', timestamp: at(2), cwd: '/home/w23x/proj', isMeta: true, message: { content: 'META' } },
    { type: 'user', timestamp: at(3), cwd: '/home/w23x/proj', isSidechain: true, message: { content: 'SIDECHAIN' } },
    { type: 'user', timestamp: at(4), cwd: '/home/w23x/proj', message: { content: [{ type: 'tool_result', content: 'TOOLRESULT' }] } },
    { type: 'user', timestamp: at(5), cwd: '/home/w23x/proj', message: { content: [{ type: 'text', text: 'ARRAY-PROMPT' }] } },
    { type: 'user', timestamp: at(6), cwd: '/home/w23x/proj', message: { content: '<command-name>/clear</command-name>' } },
    { type: 'assistant', timestamp: at(7), message: { content: 'ASSISTANT' } },
    { type: 'user', timestamp: at(90), cwd: '/home/w23x/proj', message: { content: 'OUT-OF-RANGE' } },
  ];
  writeFileSync(join(dir, '-home-w23x-proj', 's.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n{bad json\n');
  const ps = claudePrompts(dir, D0, D0 + 30 * MIN);
  assert.deepEqual(ps.map((p) => p.text), ['PLAIN-PROMPT', 'ARRAY-PROMPT']);
  assert.equal(ps[0].project, '/home/w23x/proj');
  assert.equal(ps[0].ts, D0 + MIN);
});

test('findGitRepos + gitCommits read local commits in range', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-'));
  const repo = join(root, 'a', 'myrepo');
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(root, 'node_modules', 'dep', '.git'), { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: 'w', GIT_AUTHOR_EMAIL: 'w@x', GIT_COMMITTER_NAME: 'w', GIT_COMMITTER_EMAIL: 'w@x' };
  execFileSync('git', ['init', '-q', repo], { env });
  writeFileSync(join(repo, 'f'), '1');
  const date = new Date(D0 + 60 * MIN).toISOString();
  execFileSync('git', ['-C', repo, 'add', '.'], { env });
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'feat: in range'], { env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  const repos = findGitRepos([root]);
  assert.deepEqual(repos, [repo]);
  const cs = gitCommits(repos, D0, D0 + 2 * 60 * MIN);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].repo, 'myrepo');
  assert.equal(cs[0].message, 'feat: in range');
  assert.equal(cs[0].ts, D0 + 60 * MIN);
  assert.equal(gitCommits(repos, D0 + 2 * 60 * MIN, D0 + 3 * 60 * MIN).length, 0);
});

test('fetchGithubReport writes repos, README head and own commits with auth header', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const h = new Headers(init.headers || {});
    seen.push({ url: String(url), auth: h.get('authorization') });
    const u = new URL(String(url));
    if (u.pathname === '/user/repos') return new Response(JSON.stringify([{ name: 'Studium', full_name: 'w23x0/Studium', owner: { login: 'w23x0' }, private: true, language: 'TypeScript', description: 'study tool', created_at: '2026-09-01T00:00:00Z', pushed_at: '2026-10-13T00:00:00Z' }]), { status: 200 });
    if (u.pathname === '/repos/w23x0/Studium/readme') return new Response('README-BODY-TEXT', { status: 200 });
    if (u.pathname === '/repos/w23x0/Studium/commits') return new Response(JSON.stringify([{ sha: 'a', commit: { message: 'feat: add eval\n\nlong body', author: { date: '2026-10-13T02:00:00Z' }, committer: { date: '2026-10-13T02:00:00Z' } } }]), { status: 200 });
    return new Response('[]', { status: 404 });
  };
  const md = await fetchGithubReport('w23x0', 'tok', D1, fetchImpl);
  for (const needle of ['Studium', 'TypeScript', 'study tool', 'README-BODY-TEXT', 'feat: add eval']) assert.ok(md.includes(needle), needle);
  assert.ok(seen.every((s) => s.auth === 'Bearer tok'));
  assert.ok(seen.some((s) => s.url.includes('author=w23x0')));
  await assert.rejects(() => fetchGithubReport('w23x0', 'tok', D1, async () => new Response('x', { status: 401 })));
});

// ---------------------------------------------------------------- pipeline

const studyFx = {
  afk: [{ start: D0 + 60 * MIN, end: D0 + 90 * MIN, afk: false }],
  window: [
    { start: D0 + 60 * MIN, end: D0 + 80 * MIN, app: 'code', title: 'Studium eval' },
    { start: D0 + 80 * MIN, end: D0 + 90 * MIN, app: 'chrome', title: 'secret-bank-page' },
  ],
  media: [{ start: D0 + 61 * MIN, end: D0 + 64 * MIN, player: 'SodaM', title: 'Old Town Road', artist: 'Lil Nas X' }],
};

test('tick processes aligned blocks from local midnight; empty blocks skip the model; cards and cursor persisted', async () => {
  const { s, reflection, dataDir, sources } = makeSense({ fx: studyFx, sense: { exclude: { apps: [], titlePatterns: ['bank'], domains: [] } } });
  const r = await s.tick();
  assert.equal(r.error, undefined);
  assert.equal(r.processed, 4);
  assert.deepEqual(sources.calls.slice(0, 4).map(([a, b]) => [(a - D0) / MIN, (b - D0) / MIN]), [[0, 30], [30, 60], [60, 90], [90, 120]]);
  const cards = readActivityCards(dataDir, DAY0);
  assert.equal(cards.length, 4);
  assert.deepEqual(cards.map((c) => c.empty), [true, true, false, true]);
  assert.deepEqual(cards.map((c) => c.card === null), [true, true, false, true]);
  assert.match(cards[2].card, /Studium/);
  assert.equal(cards[2].activeMinutes, 30);
  assert.equal(reflection.calls.length, 1, 'model called only for the non-empty block');
  const req = reflection.calls[0];
  assert.ok(req.userText.includes('Studium eval') && req.userText.includes('Old Town Road'));
  assert.equal(req.tools.length, 0, 'timeline agent has no tools');
  assert.ok(req.sysText.includes(TIMELINE_PROMPT.slice(0, 20)));
  assert.ok(!JSON.stringify(req.msgs).includes('secret-bank-page'), 'excluded title never reaches the model');
  assert.ok(!readFileSync(cardsFile(dataDir), 'utf8').includes('secret-bank-page'));
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'state', 'sense-cursor.json'), 'utf8')).blockEnd, D0 + 120 * MIN);
  assert.equal(localDay(D0 + 23 * 60 * MIN), DAY0);
  const again = await s.tick();
  assert.equal(again.processed, 0);
  assert.equal(readActivityCards(dataDir, DAY0).length, 4);
  assert.deepEqual(readActivityCards(dataDir, '2020-01-01'), []);
});

test('tick: collect failure stops without advancing; model failure stops without writing', async () => {
  const a = makeSense({ fx: studyFx, failAt: D0 + 30 * MIN });
  const r = await a.s.tick();
  assert.equal(r.processed, 1);
  assert.ok(r.error);
  assert.equal(JSON.parse(readFileSync(join(a.dataDir, 'state', 'sense-cursor.json'), 'utf8')).blockEnd, D0 + 30 * MIN);

  const b = makeSense({ fx: studyFx, brain: () => { throw new Error('model down'); } });
  const r2 = await b.s.tick();
  assert.ok(r2.error);
  assert.equal(r2.processed, 2, 'the two empty blocks before the failing one are fine');
  assert.equal(readActivityCards(b.dataDir, DAY0).length, 2);
  assert.equal(JSON.parse(readFileSync(join(b.dataDir, 'state', 'sense-cursor.json'), 'utf8')).blockEnd, D0 + 60 * MIN);
});

test('tick catches up at most maxCatchupBlocks blocks', async () => {
  const { s, sources, dataDir } = makeSense({ fx: studyFx, sense: { maxCatchupBlocks: 2 } });
  const r = await s.tick();
  assert.equal(r.processed, 2);
  assert.equal(sources.calls[0][0], D0 + 60 * MIN);
  assert.equal(readActivityCards(dataDir, DAY0)[0].start, D0 + 60 * MIN);
});

test('pause: fully paused block gets no model call; partly paused blocks are clipped; resume ends the pause', async () => {
  const fx = { afk: [{ start: D0, end: D0 + 120 * MIN, afk: false }], window: [{ start: D0, end: D0 + 120 * MIN, app: 'code', title: 'work' }] };
  const { s, reflection, dataDir, setNow } = makeSense({ fx });
  setNow(D0 + 10 * MIN);
  const p = s.pause(60);
  assert.deepEqual(p, { start: D0 + 10 * MIN, end: D0 + 70 * MIN });
  assert.equal((await s.status()).pausedUntil, D0 + 70 * MIN);
  setNow(D0 + 126 * MIN);
  await s.tick();
  const cards = readActivityCards(dataDir, DAY0);
  assert.deepEqual(cards.map((c) => c.paused), [false, true, false, false]);
  assert.equal(cards[1].card, null);
  assert.equal(cards[0].activeMinutes, 10);
  assert.equal(cards[2].activeMinutes, 20);
  assert.equal(reflection.calls.length, 3);
  setNow(D0 + 130 * MIN);
  s.pause(30);
  setNow(D0 + 135 * MIN);
  s.resume();
  assert.equal((await s.status()).pausedUntil, null);
  const pauses = JSON.parse(readFileSync(join(dataDir, 'state', 'sense-pauses.json'), 'utf8'));
  assert.equal(pauses.at(-1).end, D0 + 135 * MIN);
});

test('day digest is written once the cursor passes midnight', async () => {
  const fx = { ...studyFx, commits: [{ ts: D0 + 70 * MIN, repo: 'Studium', message: 'feat: digest commit' }] };
  const { s, dataDir, setNow, sources } = makeSense({ fx });
  await s.tick();
  setNow(D1 + 6 * MIN);
  const r = await s.tick();
  assert.equal(r.error, undefined);
  assert.deepEqual(r.digests, [`digests/day-${DAY0}.md`]);
  assert.ok(sources.calls.some(([a, b]) => a === D0 && b === D1), 'whole-day collect for the digest');
  const md = readFileSync(join(dataDir, 'raw', 'digests', `day-${DAY0}.md`), 'utf8');
  assert.ok(md.includes('feat: digest commit') && md.includes('Old Town Road') && md.includes('Studium'));
  const r2 = await s.tick();
  assert.deepEqual(r2.digests, []);
});

test('githubBackfill requires githubUser and writes raw/sense/github-<day>.md', async () => {
  const { dataDir } = makeSense();
  const reflection = fauxModel(() => say('x'));
  const cfgNo = baseConfig(dataDir, { sense: senseCfg() });
  await assert.rejects(() => createSense({ config: cfgNo, models: { primary: reflection, reflection }, sources: fakeSources({}), now: () => D1 }).githubBackfill());
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/repos')) return new Response(JSON.stringify([{ name: 'Vox', full_name: 'w23x0/Vox', owner: { login: 'w23x0' }, private: false, language: 'Rust', description: 'voice', created_at: '2026-09-01T00:00:00Z', pushed_at: '2026-10-13T00:00:00Z' }]), { status: 200 });
    if (u.pathname.endsWith('/readme')) return new Response('VOX README', { status: 200 });
    return new Response('[]', { status: 200 });
  };
  const cfg = baseConfig(dataDir, { sense: senseCfg({ githubUser: 'w23x0' }) });
  const rel = await createSense({ config: cfg, models: { primary: reflection, reflection }, sources: fakeSources({}), now: () => D1 + MIN, fetchImpl }).githubBackfill();
  assert.equal(rel, `sense/github-${localDay(D1 + MIN)}.md`);
  assert.ok(readFileSync(join(dataDir, 'raw', rel), 'utf8').includes('VOX README'));
});

// ---------------------------------------------------------------- tools

test('activity tools exist only for the observer; read/search/file access is confined', async () => {
  const { s, dataDir } = makeSense({ fx: studyFx });
  await s.tick();
  mkdirSync(join(dataDir, 'raw', 'digests'), { recursive: true });
  writeFileSync(join(dataDir, 'raw', 'digests', 'day-2026-10-13.md'), '# 2026-10-13\nDIGEST-LINE about Vox\n');
  const names = (mode) => createMemoryTools({ dataDir, mode, readVersions: new Map() }).map((t) => t.name);
  const four = ['list_activity', 'read_activity', 'read_activity_file', 'search_activity'];
  for (const m of ['reflection', 'interview']) for (const n of four) assert.ok(names(m).includes(n), `${m} has ${n}`);
  for (const m of ['chat', 'proactive']) for (const n of four) assert.ok(!names(m).includes(n), `${m} must not have ${n}`);
  const tools = Object.fromEntries(createMemoryTools({ dataDir, mode: 'reflection', readVersions: new Map() }).map((t) => [t.name, t]));
  const run = async (n, p) => { const r = await tools[n].execute('id', p); return { text: r.content.map((c) => c.text).join(''), isError: !!r.isError }; };
  const list = await run('list_activity', {});
  assert.ok(list.text.includes(DAY0) && list.text.includes('digests/day-2026-10-13.md'));
  const day = await run('read_activity', { date: DAY0 });
  assert.ok(day.text.includes('卡片：他在写 Studium 的 eval') && day.text.includes('01:00'));
  const last = await run('read_activity', { date: DAY0, from_end: 1 });
  assert.ok(!last.text.includes('卡片：他在写'), 'from_end=1 only returns the last (empty) card');
  const f = await run('read_activity_file', { path: 'digests/day-2026-10-13.md' });
  assert.ok(f.text.includes('DIGEST-LINE') && !f.isError);
  for (const bad of ['../state/sense-cursor.json', 'messages-2026-10-14.jsonl', '/etc/passwd', 'digests/../../state/sense-cursor.json']) {
    assert.equal((await run('read_activity_file', { path: bad })).isError, true, bad);
  }
  const hit = await run('search_activity', { query: 'Vox|Studium' });
  assert.ok(hit.text.includes('DIGEST-LINE') && hit.text.includes('Studium'));
});

// ---------------------------------------------------------------- app & interview

function makeApp({ fx = {}, nowVal, sense = {}, dataDir = tmpDataDir() } = {}) {
  const reflCalls = [];
  const brain = (ctx, i) => {
    if (isTimeline(i)) return say('卡片：深夜在调 Vox');
    reflCalls.push(i);
    return say('反思完成');
  };
  const reflection = fauxModel(brain, { id: 'reflector' });
  const primary = fauxModel(() => say('嗯'));
  const app = createApp({ config: baseConfig(dataDir, { sense: senseCfg(sense) }), models: { primary, reflection }, adapters: [mockAdapter()], senseSources: fakeSources(fx), now: () => nowVal });
  return { app, dataDir, reflCalls, primary };
}

test('reflection runs for a new digest/report even without new messages; new cards alone do not trigger it', async () => {
  const { app, dataDir, reflCalls } = makeApp({ nowVal: D1 });
  assert.deepEqual(await app.runReflection(), { ran: false, reason: 'no new messages' });
  mkdirSync(join(dataDir, 'raw', 'digests'), { recursive: true });
  writeFileSync(join(dataDir, 'raw', 'digests', 'day-2026-10-13.md'), '# d\n');
  const r = await app.runReflection();
  assert.equal(r.ran, true);
  assert.ok(reflCalls.at(-1).userText.includes('digests/day-2026-10-13.md'));
  assert.ok(reflCalls.at(-1).tools.includes('read_activity'));
  const st = JSON.parse(readFileSync(join(dataDir, 'state', 'sense-reflection.json'), 'utf8'));
  assert.ok(st.files.includes('digests/day-2026-10-13.md'));
  assert.equal((await app.runReflection()).ran, false);
  appendFileSync(join(dataDir, 'raw', `activity-${DAY0}.jsonl`), JSON.stringify({ start: D0, end: D0 + 30 * MIN, activeMinutes: 30, afkMinutes: 0, empty: false, paused: false, summary: 's', card: 'CARD-X' }) + '\n');
  assert.equal((await app.runReflection()).ran, false, 'cards alone do not trigger');
  appendRaw(dataDir, { ts: D1, channel: 'telegram', userId: '1', role: 'user', text: 'hi' });
  const r2 = await app.runReflection();
  assert.equal(r2.ran, true);
  assert.ok(reflCalls.at(-1).userText.includes('read_activity'), 'prompt points at the new cards');
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'state', 'sense-reflection.json'), 'utf8')).activityTs, D0);
});

test('runSenseTick writes cards and a digest, then triggers reflection; unconfigured sense reports an error', async () => {
  const dataDir = tmpDataDir();
  mkdirSync(join(dataDir, 'state'), { recursive: true });
  writeFileSync(join(dataDir, 'state', 'sense-cursor.json'), JSON.stringify({ blockEnd: D0 + 23 * 60 * MIN }));
  const fx = { afk: [{ start: D0 + 23 * 60 * MIN, end: D1, afk: false }], window: [{ start: D0 + 23 * 60 * MIN, end: D1, app: 'code', title: 'Vox' }] };
  const { app, reflCalls } = makeApp({ fx, nowVal: D1 + 6 * MIN, dataDir });
  const r = await app.runSenseTick();
  assert.equal(r.processed, 2);
  assert.deepEqual(r.digests, [`digests/day-${DAY0}.md`]);
  assert.ok(existsSync(join(dataDir, 'raw', 'digests', `day-${DAY0}.md`)));
  assert.ok(await waitFor(() => reflCalls.length > 0));
  assert.ok(reflCalls[0].userText.includes(`digests/day-${DAY0}.md`));

  const primary = fauxModel(() => say('x'));
  const plain = createApp({ config: baseConfig(tmpDataDir()), models: { primary, reflection: primary }, adapters: [mockAdapter()] });
  const r2 = await plain.runSenseTick();
  assert.equal(r2.processed, 0);
  assert.equal(r2.error, 'sense not configured');
});

test('persona never sees activity material', async () => {
  const { app, dataDir, primary } = makeApp({ fx: studyFx, nowVal: D0 + 126 * MIN });
  await app.runSenseTick();
  assert.ok(readActivityCards(dataDir, DAY0).length > 0);
  await app.handleInbound({ channel: 'telegram', userId: '424242', chatId: '424242', text: '在干嘛' });
  const call = primary.calls.at(-1);
  assert.ok(!JSON.stringify(call.msgs).includes('Studium eval'));
  assert.ok(!call.tools.some((t) => /activity/.test(t)));
});

test('interview open mentions today\'s activity card count', async () => {
  const dataDir = tmpDataDir();
  const now = Date.now();
  const day = localDay(now);
  mkdirSync(join(dataDir, 'raw'), { recursive: true });
  const startOfDay = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
  const lines = [0, 1].map((k) => JSON.stringify({ start: startOfDay + k * 30 * MIN, end: startOfDay + (k + 1) * 30 * MIN, activeMinutes: 1, afkMinutes: 0, empty: false, paused: false, summary: 's', card: 'c' }));
  writeFileSync(join(dataDir, 'raw', `activity-${day}.jsonl`), lines.join('\n') + '\n');
  const seen = [];
  const reflection = fauxModel((ctx, i) => { seen.push(i); return say('你今天在忙什么？'); }, { id: 'reflector' });
  const iv = createInterview({ config: baseConfig(dataDir, { sense: senseCfg() }), models: { primary: reflection, reflection } });
  await iv.open();
  assert.ok(seen[0].userText.includes('今日活动时间线：2 段'), seen[0].userText);
});
