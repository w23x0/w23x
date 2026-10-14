// Shared helpers for the acceptance tests. Tests import the compiled app from ../dist.
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ALLOWED_TG = '424242';

export const txt = (m) => !m ? '' : typeof m.content === 'string' ? m.content
  : (m.content || []).map((c) => c.text ?? '').join('');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function tmpDataDir() {
  return join(mkdtempSync(join(tmpdir(), 'avatar-test-')), 'data');
}

/** Inspect a model request: mode, tool names, last user text, tool results since that user message. */
export function inspect(context) {
  const msgs = context.messages;
  const sys = msgs.find((m) => m.role === 'system');
  const sysText = msgs.filter((m) => m.role === 'system').map(txt).join('\n');
  const tools = msgs.filter((m) => m.role === 'system').flatMap((m) => (m.toolsAdded || []).map((t) => t.name));
  const lastUserIdx = msgs.map((m) => m.role).lastIndexOf('user');
  const lastUser = msgs[lastUserIdx];
  const results = msgs.slice(lastUserIdx + 1).filter((m) => m.role === 'toolResult');
  return { msgs, sys, sysText, tools, lastUser, userText: txt(lastUser), results, last: msgs[msgs.length - 1] };
}

export const say = (s) => fauxAssistantMessage([fauxText(s)]);
export const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });

/** A ResolvedModel backed by the faux provider; `brain(context, info)` returns an AssistantMessage (may be async / throw). */
export function fauxModel(brain, { id = 'brain', input = ['text'], contextWindow = 100000 } = {}) {
  const faux = fauxProvider({ provider: 'faux-' + id, models: [{ id, input, contextWindow, maxTokens: 4096 }] });
  const calls = [];
  const step = async (context) => {
    const info = inspect(context);
    calls.push(info);
    return brain(context, info);
  };
  faux.setResponses(Array.from({ length: 2000 }, () => step));
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: faux.getModel(), getApiKey: () => undefined, calls };
}

export function mockAdapter(name = 'telegram') {
  const sent = [];
  return {
    name, sent, handler: null,
    async start(h) { this.handler = h; },
    async send(chatId, text) { sent.push({ chatId, text }); },
    async stop() {},
  };
}

export function baseConfig(dataDir, over = {}) {
  return {
    dataDir,
    model: { id: 'brain', provider: 'faux' },
    idleMinutes: 15, proactiveFallbackMinutes: 180, proactiveMinMinutes: 10,
    telegramToken: 'x', allowedTelegramUserId: ALLOWED_TG,
    ...over,
  };
}

export function inbound(text, extra = {}) {
  return { channel: 'telegram', userId: ALLOWED_TG, chatId: ALLOWED_TG, text, ...extra };
}

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export async function waitFor(pred, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(50); }
  return false;
}
