export async function fetchGithubReport(user: string, token: string | undefined, now: number, fetchImpl?: typeof fetch): Promise<string> {
  const f = fetchImpl || fetch;
  const api = 'https://api.github.com';
  const headers: Record<string, string> = { 'User-Agent': 'avatar-companion' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await f(token
    ? `${api}/user/repos?affiliation=owner&per_page=100`
    : `${api}/users/${encodeURIComponent(user)}/repos?per_page=100`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const repos: any = await res.json();
  const since = new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString();

  const lines: string[] = [];
  lines.push(`# GitHub report for ${user}`);
  lines.push('');
  for (const repo of repos || []) {
    const owner = repo?.owner?.login || user;
    const name = repo?.name;
    lines.push(`## ${name}${repo?.private ? ' (private)' : ''}`);
    lines.push(`- language: ${repo?.language ?? 'unknown'}`);
    lines.push(`- description: ${repo?.description ?? ''}`);
    lines.push(`- created: ${repo?.created_at ?? ''}`);
    lines.push(`- pushed: ${repo?.pushed_at ?? ''}`);

    // README
    try {
      const r = await f(`${api}/repos/${owner}/${name}/readme`, { headers: { ...headers, Accept: 'application/vnd.github.raw' } });
      if (r.ok) {
        const txt = await r.text();
        lines.push('- README:');
        lines.push(txt.slice(0, 1500));
      }
    } catch { /* ignore */ }

    // commits
    const commitLines: string[] = [];
    for (let page = 1; page <= 3; page++) {
      try {
        const c = await f(`${api}/repos/${owner}/${name}/commits?author=${encodeURIComponent(user)}&since=${encodeURIComponent(since)}&per_page=100&page=${page}`, { headers });
        if (!c.ok) break;
        const arr: any = await c.json();
        for (const commit of arr) {
          const msg = (commit?.commit?.message || '').split('\n')[0];
          const dateStr = commit?.commit?.author?.date || commit?.commit?.committer?.date;
          const d = dateStr ? new Date(dateStr) : null;
          const local = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
          commitLines.push(`${local} ${msg}`);
        }
        if (arr.length < 100) break;
      } catch {
        break;
      }
    }
    if (commitLines.length) {
      lines.push('- commits (last 365d):');
      lines.push(...commitLines.map((cl) => '  - ' + cl));
    }
    lines.push('');
  }
  return lines.join('\n');
}