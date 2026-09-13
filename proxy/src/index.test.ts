import test from 'node:test';
import assert from 'node:assert';
import { app } from './index.ts';
import { initPlaywright, closePlaywright } from './services/playwright.ts';

test('Health check endpoint returns status ok', async () => {
  const req = new Request('http://localhost/health');
  const res = await app.fetch(req);
  
  assert.strictEqual(res.status, 200);
  
  const body = await res.json();
  assert.deepStrictEqual(body, { status: 'ok' });
});

test('Models endpoint returns deepseek-v4-flash and deepseek-v4-flash-thinking', async () => {
  const req = new Request('http://localhost/v1/models');
  const res = await app.fetch(req);
  
  assert.strictEqual(res.status, 200);
  
  const body = await res.json();
  assert.strictEqual(body.object, 'list');
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.some((m: any) => m.id === 'deepseek-v4-flash'));
  assert.ok(body.data.some((m: any) => m.id === 'deepseek-v4-flash-thinking'));
  const flash = body.data.find((m: any) => m.id === 'deepseek-v4-flash');
  assert.strictEqual(typeof flash.context_length, 'number');
  assert.ok(flash.context_length > 0);
  assert.strictEqual(typeof flash.max_context_tokens, 'number');
});

test('Chat Completions endpoint with deepseek-v4-flash-thinking (thinking enabled)', async () => {
  // Initialize playwright for this test
  // NOTE: Headless mode can sometimes fail Cloudflare checks. We use headless=false for the test
  // to ensure it matches the logged-in browser state if needed, or you can switch it to true.
  await initPlaywright(false);

  try {
    const payload = {
      model: 'deepseek-v4-flash-thinking',
      messages: [{ role: 'user', content: 'What is 99 * 182? Please think step by step.' }],
      stream: true
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let hasReasoning = false;
    let hasContent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (line.trim() === 'data: [DONE]') {
          break;
        }
        if (line.startsWith('data: ')) {
          try {
            const dataStr = line.slice(6);
            if (dataStr !== '[DONE]') {
              const data = JSON.parse(dataStr);
              
              if (data.choices && data.choices[0] && data.choices[0].delta) {
              const delta = data.choices[0].delta;
              if (delta.content) {
                hasContent = true;
              }
                if (delta.reasoning_content) {
                  hasReasoning = true;
                }
              }
            }
          } catch (err) {
            // Partial JSON ignored
            // console.error("Parse error:", err);
          }
        }
      }
    }

    assert.ok(hasReasoning, 'Should have received streamed chunks with reasoning_content (Thinking enabled)');
    assert.ok(hasContent, 'Should have received streamed chunks with content');
  } finally {
    await closePlaywright();
  }
});
