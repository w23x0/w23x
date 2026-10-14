export function createActivityWatchSource(baseUrl: string, fetchImpl?: typeof fetch): {
  buckets(): Promise<string[]>;
  collect(start: number, end: number): Promise<{ window: any[]; afk: any[]; web: any[]; media: any[] }>;
} {
  const base = baseUrl.replace(/\/$/, '');
  const f = fetchImpl || fetch;
  const ISO = (ts: number) => new Date(ts).toISOString();

  async function buckets(): Promise<string[]> {
    const res = await f(`${base}/api/0/buckets/`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return Object.keys(json || {});
  }

  type RawEvent = { timestamp: string; duration: number; data: any };
  async function eventsFor(id: string, start: number, end: number): Promise<RawEvent[]> {
    const url = `${base}/api/0/buckets/${encodeURIComponent(id)}/events?start=${encodeURIComponent(ISO(start))}&end=${encodeURIComponent(ISO(end))}&limit=-1`;
    const res = await f(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return Array.isArray(json) ? json : [];
  }

  function clip(s: number, e: number, bs: number, be: number): [number, number] | null {
    const cs = Math.max(s, bs);
    const ce = Math.min(e, be);
    if (ce <= cs) return null;
    return [cs, ce];
  }

  async function collect(start: number, end: number): Promise<{ window: any[]; afk: any[]; web: any[]; media: any[] }> {
    const ids = await buckets();
    const windowIds = ids.filter((id) => id.startsWith('aw-watcher-window_'));
    const afkIds = ids.filter((id) => id.startsWith('aw-watcher-afk_'));
    const mediaIds = ids.filter((id) => id.startsWith('aw-watcher-media-player_'));
    const webIds = ids.filter((id) => id.startsWith('aw-watcher-web'));

    const window: any[] = [];
    const afk: any[] = [];
    const web: any[] = [];
    const media: any[] = [];

    for (const id of windowIds) {
      const evs = await eventsFor(id, start, end);
      for (const ev of evs) {
        const s = Date.parse(ev.timestamp);
        const e = s + (ev.duration || 0) * 1000;
        const c = clip(s, e, start, end);
        if (!c) continue;
        const data = ev.data || {};
        window.push({ start: c[0], end: c[1], app: data.app, title: data.title });
      }
    }
    for (const id of afkIds) {
      const evs = await eventsFor(id, start, end);
      for (const ev of evs) {
        const s = Date.parse(ev.timestamp);
        const e = s + (ev.duration || 0) * 1000;
        const c = clip(s, e, start, end);
        if (!c) continue;
        const data = ev.data || {};
        afk.push({ start: c[0], end: c[1], afk: data.status === 'afk' });
      }
    }
    for (const id of webIds) {
      const evs = await eventsFor(id, start, end);
      for (const ev of evs) {
        const s = Date.parse(ev.timestamp);
        const e = s + (ev.duration || 0) * 1000;
        const c = clip(s, e, start, end);
        if (!c) continue;
        const data = ev.data || {};
        web.push({ start: c[0], end: c[1], url: data.url, title: data.title, audible: data.audible });
      }
    }
    for (const id of mediaIds) {
      const evs = await eventsFor(id, start, end);
      for (const ev of evs) {
        const s = Date.parse(ev.timestamp);
        const e = s + (ev.duration || 0) * 1000;
        const c = clip(s, e, start, end);
        if (!c) continue;
        const data = ev.data || {};
        if (!data.title) continue;
        media.push({ start: c[0], end: c[1], player: data.player, title: data.title, artist: data.artist, album: data.album });
      }
    }
    return { window, afk, web, media };
  }

  return { buckets, collect };
}