export function isCjk(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff);
}

export function estimateTextTokens(s: string): number {
  let cjk = 0; let other = 0;
  for (const ch of s) { if (isCjk(ch)) cjk++; else other++; }
  return cjk + Math.ceil(other / 4);
}

export function msgContentTokens(m: any): number {
  const c = m?.content;
  if (typeof c === 'string') return estimateTextTokens(c);
  if (Array.isArray(c)) {
    return c.reduce((n: number, x: any) => {
      if (typeof x?.text === 'string') return n + estimateTextTokens(x.text);
      if (typeof x?.data === 'string') return n + Math.ceil(x.data.length / 4);
      return n + 25;
    }, 0);
  }
  return 0;
}

export function trimMessages(messages: any[], tokenBudget: number): any[] {
  const system = messages.filter((m) => m?.role === 'system');
  const others = messages.filter((m) => m?.role !== 'system');
  const blocks: any[][] = [];
  let cur: any[] = [];
  for (const m of others) {
    if (m?.role === 'user' && cur.length > 0) {
      blocks.push(cur);
      cur = [];
    }
    cur.push(m);
  }
  if (cur.length) blocks.push(cur);
  let total = system.reduce((n, m) => n + msgContentTokens(m), 0) +
    others.reduce((n, m) => n + msgContentTokens(m), 0);
  while (blocks.length > 1 && total > tokenBudget) {
    const removed = blocks.shift()!;
    total -= removed.reduce((n, m) => n + msgContentTokens(m), 0);
  }
  return [...system, ...blocks.flat()];
}