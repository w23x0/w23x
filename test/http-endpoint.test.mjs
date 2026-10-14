import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Agent } from '@earendil-works/pi-agent-core';
import { makeModelsForSpecs } from '../dist/model.js';

// A local OpenAI-compatible endpoint: proves the custom-baseUrl path really authenticates and streams.
function mockOpenAI() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: 'assistant', content: 'OK' }));
      res.write(chunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

async function ask(r) {
  const a = new Agent({ initialState: { systemPrompt: 's', model: r.model, tools: [], thinkingLevel: 'off' },
    streamFn: r.models.streamSimple.bind(r.models), getApiKey: (p) => r.getApiKey(p) });
  await a.prompt('hi');
  return a.state.messages.at(-1);
}

test('custom baseUrl endpoints authenticate with their own key and stream a reply', async () => {
  const { server, seen, url } = await mockOpenAI();
  try {
    const { primary, reflection } = await makeModelsForSpecs(
      { provider: 'p1', id: 'chat-model', baseUrl: url, apiKey: 'key-primary', api: 'openai-completions' },
      { provider: 'p2', id: 'reflect-model', baseUrl: url, apiKey: 'key-reflection', api: 'openai-completions' },
    );
    const m1 = await ask(primary);
    assert.equal(m1.stopReason, 'stop', m1.errorMessage);
    assert.equal(m1.content.find((c) => c.type === 'text')?.text, 'OK');
    const m2 = await ask(reflection);
    assert.equal(m2.stopReason, 'stop', m2.errorMessage);
    assert.deepEqual(seen.map((s) => s.auth), ['Bearer key-primary', 'Bearer key-reflection']);
    assert.deepEqual(seen.map((s) => s.body.model), ['chat-model', 'reflect-model']);
  } finally { server.close(); }
});
