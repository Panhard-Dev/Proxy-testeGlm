import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

import { app } from './index.ts';

// Helper to mock the fetch global for testing empty response retry and caching logic
function setupFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (urlStr.includes('chat.deepseek.com')) {
      return handler(urlStr, init);
    }
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

test('multiturn-thinking-tools: serializes complete OpenAI message history', async () => {
  let capturedPrompt = '';

  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse(init?.body as string || '{}');
    capturedPrompt = bodyObj.prompt;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"hello"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-thinking',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'doing something', reasoning_content: 'thinking about hello', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }] },
          { role: 'tool', name: 'test', content: 'success' }
        ]
      })
    });
    
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    // Validate that the complete OpenAI history is sent to DeepSeek. Agents
    // need the original user request, assistant tool call, and tool result to
    // produce the post-tool final answer.
    assert.ok(capturedPrompt.includes('User: hello'), 'Must include original user message');
    assert.ok(capturedPrompt.includes('Assistant:'), 'Must include assistant history');
    assert.ok(capturedPrompt.includes('<think>\nthinking about hello\n</think>'), 'Must include previous thinking');
    assert.ok(capturedPrompt.includes('<tool_call>{"name": "test", "arguments": {}}</tool_call>'), 'Must include previous tool call');
    assert.ok(capturedPrompt.includes('Tool Response (test): success'), 'Must include tool response signature');
  } finally {
    restore();
  }
});

test('streaming-whitespace: preserves exact whitespace', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"v":{"response":{"message_id":1}}}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"   "}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"o":"APPEND","v":"  hello  "}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"o":"APPEND","v":"\\n\\n  "}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash-thinking', messages: [{role: 'user', content: 'test'}], stream: true })
    });
    
    const res = await app.fetch(req);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let full = '';
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices?.[0]?.delta?.content) {
              full += data.choices[0].delta.content;
            }
          } catch(e) {}
        }
      }
    }
    
    // We expect exactly: "     hello  \n\n  "
    assert.strictEqual(full, "     hello  \n\n  ");
  } finally {
    restore();
  }
});

test('caching-streaming and cache-control: returns prompt_tokens_details', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"v":{"response":{"message_id":1}}}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"done"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/accumulated_token_usage","o":"SET","v":10}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash-thinking', messages: [{role: 'user', content: 'test'}], stream: true })
    });
    
    const res = await app.fetch(req);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let usageBlock = null;
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.usage) {
              usageBlock = data.usage;
            }
          } catch(e) {}
        }
      }
    }
    
    assert.ok(usageBlock);
    assert.strictEqual(usageBlock.completion_tokens, 10);
    assert.ok(usageBlock.prompt_tokens > 0);
    assert.strictEqual(usageBlock.prompt_tokens_details.cached_tokens, 0); // Tests caching-streaming shape!
  } finally {
    restore();
  }
});

test('openai-requests-are-stateless: each request starts a fresh DeepSeek turn', async () => {
  let capturedPayloads: any[] = [];

  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse(init?.body as string || '{}');
    capturedPayloads.push(bodyObj);
    
    // Simulate DeepSeek returning a message_id
    const mockMessageId = capturedPayloads.length === 1 ? 1001 : 1002;
    
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: {"v":{"response":{"message_id":${mockMessageId}}}}\n\n`));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"hello"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    process.env.TEST_SESSION_ID = 'test-session-parent-tracking';
    // Turn 1
    const req1 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-thinking',
        messages: [{ role: 'user', content: 'Turn 1' }]
      })
    });
    
    const res1 = await app.fetch(req1);
    assert.strictEqual(res1.status, 200);
    // Consume the stream to ensure the message_id is processed
    await res1.text();

    // Turn 2
    const req2 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-thinking',
        messages: [
          { role: 'user', content: 'Turn 1' },
          { role: 'assistant', content: 'Response 1' },
          { role: 'user', content: 'Turn 2' }
        ]
      })
    });
    
    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 200);
    await res2.text();

    assert.strictEqual(capturedPayloads.length, 2);
    // In Turn 1, parent_message_id should be null (mock-session is fresh)
    assert.strictEqual(capturedPayloads[0].parent_message_id, null);
    // OpenAI chat/completions requests are self-contained; the proxy must not
    // reuse DeepSeek's previous parent_message_id because compressed or edited
    // OpenAI histories no longer match the browser-side DeepSeek thread.
    assert.strictEqual(capturedPayloads[1].parent_message_id, null, 'Turn 2 should start a fresh DeepSeek turn');
    assert.strictEqual(
      capturedPayloads[1].prompt,
      'User: Turn 1\n\nAssistant: Response 1\n\nUser: Turn 2\n\n',
      'Should send complete message history'
    );
  } finally {
    restore();
  }
});

test('non-stream chat completion returns OpenAI JSON instead of SSE', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"hello"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":" world"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{role: 'user', content: 'test'}], stream: false })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('Content-Type') || '', /^application\/json/);

    const body = await res.json();
    assert.strictEqual(body.object, 'chat.completion');
    assert.strictEqual(body.choices[0].message.role, 'assistant');
    assert.strictEqual(body.choices[0].message.content, 'hello world');
    assert.strictEqual(body.choices[0].finish_reason, 'stop');
  } finally {
    restore();
  }
});


test('hermes-style XML tool calls are converted to structured OpenAI tool_calls', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"Vou executar diretamente.\\n<tool_call><parameter name=\\"command\\">powershell.exe -Command Start-Process MuMuPlayer.exe</parameter><parameter name=\\"timeout\\">30</parameter></tool_call>"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'Abra o emulador MuMu' }],
        stream: false,
        tools: [{
          type: 'function',
          function: {
            name: 'terminal',
            description: 'Execute shell commands',
            parameters: {
              type: 'object',
              properties: { command: { type: 'string' }, timeout: { type: 'number' } },
              required: ['command']
            }
          }
        }]
      })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.choices[0].message.content, null);
    assert.strictEqual(body.choices[0].finish_reason, 'tool_calls');
    assert.strictEqual(body.choices[0].message.tool_calls[0].function.name, 'terminal');
    const args = JSON.parse(body.choices[0].message.tool_calls[0].function.arguments);
    assert.match(args.command, /MuMuPlayer\.exe/);
    assert.strictEqual(args.timeout, 30);
  } finally {
    restore();
  }
});

test('streaming Hermes-style XML tool calls do not leak as content', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"<tool_call name=\\"terminal\\"><parameter name=\\"command\\">adb devices</parameter></tool_call>"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'liste adb' }],
        stream: true,
        tools: [{ type: 'function', function: { name: 'terminal', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }]
      })
    });

    const res = await app.fetch(req);
    const text = await res.text();
    assert.ok(!text.includes('<tool_call'), 'tool XML must not leak into SSE content');
    assert.ok(!text.includes('<parameter'), 'parameter XML must not leak into SSE content');
    assert.ok(text.includes('"tool_calls"'), 'SSE must expose structured tool_calls');
    assert.ok(text.includes('"finish_reason":"tool_calls"'));
  } finally {
    restore();
  }
});

test('unclosed Hermes XML tool call at end of stream is recovered instead of returning empty', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"<tool_call name=\\"terminal\\"><parameter name=\\"command\\">adb devices"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'liste adb' }],
        stream: true,
        tools: [{ type: 'function', function: { name: 'terminal', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }]
      })
    });

    const res = await app.fetch(req);
    const text = await res.text();
    assert.ok(!text.includes('<tool_call'), 'unclosed tool XML must not leak into SSE content');
    assert.ok(!text.includes('<parameter'), 'unclosed parameter XML must not leak into SSE content');
    assert.ok(text.includes('"tool_calls"'), 'Recoverable unclosed XML must emit structured tool_calls');
    assert.ok(text.includes('adb devices'), 'Recovered tool call must preserve argument text');
    assert.ok(text.includes('"finish_reason":"tool_calls"'));
  } finally {
    restore();
  }
});

test('malformed internal tool call with lead-in returns safe content instead of empty response', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"Não encontrei o dispositivo, vou verificar novamente.\\n<tool_call><parameter></parameter></tool_call>"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'continue depois de erro adb' }],
        stream: true,
        tools: [{ type: 'function', function: { name: 'terminal', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }]
      })
    });

    const res = await app.fetch(req);
    const text = await res.text();
    assert.ok(!text.includes('<tool_call'), 'malformed tool XML must not leak into SSE content');
    assert.ok(!text.includes('<parameter'), 'malformed parameter XML must not leak into SSE content');
    assert.ok(!text.includes('"tool_calls"'), 'unparseable tool call must not be exposed as a fake structured tool call');
    assert.ok(text.includes('Não encontrei o dispositivo'), 'lead-in content must be preserved as a non-empty fallback');
    assert.ok(text.includes('"finish_reason":"stop"'));
  } finally {
    restore();
  }
});

import { compressMessages } from './utils/compression.ts';

test('compression: compressMessages trims older conversational history', async () => {
  const serializeFn = (msgs: any[]) => {
    let prompt = '';
    let systemPrompt = '';
    for (const msg of msgs) {
      if (msg.role === 'system') {
        systemPrompt += msg.content + '\n';
      } else {
        prompt += `${msg.role}: ${msg.content}\n`;
      }
    }
    return { prompt, systemPrompt };
  };

  const messages = [
    { role: 'system', content: 'System instruction here' },
    { role: 'user', content: 'Message 1' },
    { role: 'assistant', content: 'Message 2' },
    { role: 'user', content: 'Message 3' },
    { role: 'assistant', content: 'Message 4' },
    { role: 'user', content: 'Message 5' },
  ];

  const targetLimit = 100;
  const compressed = compressMessages(messages, targetLimit, serializeFn);
  
  const systemMsg = compressed.find(m => m.role === 'system');
  assert.ok(systemMsg);
  assert.strictEqual(systemMsg.content, 'System instruction here');
  
  const lastMsg = compressed[compressed.length - 1];
  assert.strictEqual(lastMsg.role, 'user');
  assert.strictEqual(lastMsg.content, 'Message 5');

  assert.ok(compressed.length < messages.length);
});

test('telemetry and retry: reduces context limit on empty/error response and retries with compressed context', async () => {
  let attempts: number[] = [];
  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse(init?.body as string || '{}');
    attempts.push(bodyObj.prompt.length);
    
    if (bodyObj.prompt.length > 200) {
      const stream = new ReadableStream({
        start(c) {
          c.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"compressed success"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-thinking',
        messages: [
          { role: 'system', content: 'Keep this instruction.' },
          { role: 'user', content: 'A'.repeat(300) },
        ],
        stream: false
      })
    });
    
    const { getModelTelemetry } = await import('./services/telemetry.ts');
    const stats = getModelTelemetry('deepseek-v4-flash-thinking');
    stats.detectedLimit = 400;
    
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    
    const body = await res.json();
    assert.strictEqual(body.choices[0].message.content, 'compressed success');
    
    assert.ok(attempts.length >= 2, 'Should have retried');
    assert.ok(attempts[1] < attempts[0], 'Second attempt prompt should be shorter due to compression');
    
    assert.ok(stats.minFailureSize < Infinity, 'Should have recorded a failure');
    assert.ok(stats.detectedLimit < 400, 'Detected limit should be reduced');
  } finally {
    restore();
  }
});
