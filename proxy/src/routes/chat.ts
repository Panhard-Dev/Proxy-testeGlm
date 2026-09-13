/*
 * File: chat.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 *
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createDeepSeekStream, updateSessionParent } from '../services/deepseek.ts';
import { OpenAIRequest, ChoiceDelta, Message, ToolCall, Usage } from '../utils/types.ts';
import { getModelTelemetry, recordSuccess, recordFailure } from '../services/telemetry.ts';
import { compressMessages } from '../utils/compression.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { wrapToolCallPayload } from '../tools/toolcall-tags.ts';
import { createDSMLNormalizer } from '../utils/dsml.ts';
import { ensureDeepSeekLogin } from '../services/autologin.ts';
import { recordUsage, setSessionState } from '../services/usage.ts';
import { pickAccount, reportSuccess as reportAccountSuccess, reportFailure as reportAccountFailure } from '../services/accounts.ts';
import { getAccountPage, saveAccountState } from '../services/playwright.ts';
import { resolveModel } from '../services/models.ts';

type EmitChunk = (data: any) => Promise<void>;

interface ParsedCompletion {
  content: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: Usage;
}

function messageContentToString(content: any): string {
  if (Array.isArray(content)) {
    return content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
  }
  if (typeof content === 'object' && content !== null) {
    return JSON.stringify(content);
  }
  return content || '';
}

function serializeOpenAIMessages(messages: Message[]) {
  let prompt = '';
  let systemPrompt = '';

  for (const msg of messages) {
    const contentStr = messageContentToString(msg.content);

    if (msg.role === 'system') {
      systemPrompt += contentStr + '\n\n';
      continue;
    }

    if (msg.role === 'user') {
      prompt += `User: ${contentStr}\n\n`;
      continue;
    }

    if (msg.role === 'assistant') {
      let assistantContent = contentStr;
      if ((msg as any).reasoning_content) {
        assistantContent = `<think>\n${(msg as any).reasoning_content}\n</think>\n${assistantContent}`;
      }
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let args = tc.function?.arguments || '{}';
          if (typeof args !== 'string') args = JSON.stringify(args);
          assistantContent += '\n' + wrapToolCallPayload(`{"name": "${tc.function?.name}", "arguments": ${args}}`);
        }
      }
      prompt += `Assistant: ${assistantContent.trim()}\n\n`;
      continue;
    }

    if (msg.role === 'tool' || msg.role === 'function') {
      prompt += `Tool Response (${msg.name || msg.tool_call_id || 'tool'}): ${contentStr}\n\n`;
      continue;
    }

    prompt += `${msg.role}: ${contentStr}\n\n`;
  }

  return { prompt, systemPrompt };
}

function appendToolInstructions(systemPrompt: string, body: OpenAIRequest): string {
  const bodyAny = body as any;
  if (!bodyAny.tools || !Array.isArray(bodyAny.tools) || bodyAny.tools.length === 0) {
    return systemPrompt;
  }

  const formattedTools = bodyAny.tools.map((t: any) => {
    if (t.type === 'function') {
      return {
        name: t.function.name,
        description: t.function.description || '',
        parameters: t.function.parameters
      };
    }
    return t;
  });
  const toolsJson = JSON.stringify(formattedTools, null, 2);

  systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nRULES:\n1. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n2. Do NOT output any other text after your <tool_call> blocks. Wait for the user to provide the tool response.\n3. The JSON must be valid and accurately follow the tool's parameters.\n\n`;

  if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
    const forcedTool = bodyAny.tool_choice.function.name;
    systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
  }

  return systemPrompt;
}


function makeChoice(delta: any, finishReason: string | null = null) {
  return {
    index: 0,
    delta,
    logprobs: null,
    finish_reason: finishReason
  };
}

function makeChunk(completionId: string, model: string, delta: any, finishReason: string | null = null, usage?: Usage) {
  const chunk: any = {
    id: completionId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [makeChoice(delta, finishReason)]
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

async function parseDeepSeekStreamToOpenAI(
  deepSeekStream: ReadableStream,
  completionId: string,
  model: string,
  promptTokens: number,
  uiSessionId: string,
  tools: any[] = [],
  emit?: EmitChunk
): Promise<ParsedCompletion> {
  const reader = deepSeekStream.getReader();
  const decoder = new TextDecoder();
  const parser = new StreamingToolParser(tools as any, { incrementalToolCalls: false });
  const dsml = createDSMLNormalizer();

  let currentAppendPath = '';
  let currentFragmentType = '';
  let reasoningContent = '';
  let content = '';
  let emittedToolCallCount = 0;
  let completionTokens = 0;
  const toolCalls: ToolCall[] = [];
  let buffer = '';

  const processParserResult = async (result: { text: string; toolCalls: any[] }) => {
    if (result.text && emittedToolCallCount === 0) {
      content += result.text;
      if (emit) await emit(makeChunk(completionId, model, { content: result.text }));
    }
    for (const tc of result.toolCalls) {
      const toolCall: ToolCall = {
        index: emittedToolCallCount,
        id: tc.id || ('call_' + uuidv4()),
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) }
      };
      toolCalls.push(toolCall);
      if (emit) await emit(makeChunk(completionId, model, { tool_calls: [toolCall] }));
      emittedToolCallCount++;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const dataStr = trimmed.slice(6);
      if (dataStr === '[DONE]') continue;

      try {
        const chunk = JSON.parse(dataStr);
        let dsMessageId: any = null;
        if (chunk.response_message_id) {
          dsMessageId = chunk.response_message_id;
        } else if (chunk.v && typeof chunk.v === 'object') {
          if (chunk.v.response && chunk.v.response.message_id) {
            dsMessageId = chunk.v.response.message_id;
          } else if (chunk.v.message_id) {
            dsMessageId = chunk.v.message_id;
          }
        } else if (chunk.message_id) {
          dsMessageId = chunk.message_id;
        }

        if (dsMessageId) updateSessionParent(uiSessionId, dsMessageId);

        let vStr = '';
        let foundStr = false;
        let isThinkingChunk = false;

        if (typeof chunk.p === 'string') {
          currentAppendPath = chunk.p;
          if (chunk.p === 'response/accumulated_token_usage' && typeof chunk.v === 'number') {
            completionTokens = chunk.v;
          }
        }

        if (typeof chunk.v === 'string') {
          vStr = chunk.v;
          foundStr = true;
        } else if (chunk.v && typeof chunk.v === 'object') {
          if (chunk.v.response && chunk.v.response.fragments && chunk.v.response.fragments.length > 0) {
            const frag = chunk.v.response.fragments[0];
            if (typeof frag.content === 'string') {
              vStr = frag.content;
              foundStr = true;
              currentAppendPath = frag.type === 'THINK' ? 'response/thinking_content' : 'response/content';
              currentFragmentType = frag.type || '';
            }
          } else if (Array.isArray(chunk.v) && chunk.v.length > 0) {
            const firstObj = chunk.v[0];
            if (typeof firstObj.content === 'string') {
              vStr = firstObj.content;
              foundStr = true;
              currentAppendPath = firstObj.type === 'THINK' ? 'response/thinking_content' : 'response/content';
              currentFragmentType = firstObj.type || '';
            }
          }
        }

        if (chunk.p === 'response/fragments' && Array.isArray(chunk.v)) {
          const lastFrag = chunk.v[chunk.v.length - 1];
          if (lastFrag && lastFrag.type) currentFragmentType = lastFrag.type;
        }

        if (currentAppendPath.includes('thinking_content') ||
            currentAppendPath.includes('THINK') ||
            (currentAppendPath.includes('fragments/-1/content') && currentFragmentType === 'THINK')) {
          isThinkingChunk = true;
        }

        if (!foundStr || vStr === '' || vStr === 'FINISHED' || vStr === 'INCOMPLETE' || vStr === 'STATUS_INCOMPLETE') continue;

        if (isThinkingChunk) {
          reasoningContent += vStr;
          const delta: ChoiceDelta = { reasoning_content: vStr };
          if (emit) await emit(makeChunk(completionId, model, delta));
          continue;
        }

        await processParserResult(parser.feed(dsml.feed(vStr)));
      } catch (e) {
        // Ignore partial or malformed DeepSeek chunks.
      }
    }
  }

  await processParserResult(parser.feed(dsml.flush()));
  await processParserResult(parser.flush());

  const usage: Usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0 }
  };

  return {
    content,
    reasoningContent,
    toolCalls,
    finishReason: emittedToolCallCount > 0 ? 'tool_calls' : 'stop',
    usage
  };
}

async function peekStream(stream: ReadableStream): Promise<{ isEmpty: boolean; peekedStream: ReadableStream }> {
  const reader = stream.getReader();
  try {
    const { done, value } = await reader.read();
    if (done) {
      return { isEmpty: true, peekedStream: new ReadableStream({ start(c) { c.close(); } }) };
    }

    const peekedStream = new ReadableStream({
      async start(controller) {
        controller.enqueue(value);
        try {
          while (true) {
            const { done: nextDone, value: nextValue } = await reader.read();
            if (nextDone) {
              controller.close();
              break;
            }
            controller.enqueue(nextValue);
          }
        } catch (err) {
          controller.error(err);
        }
      },
      cancel() {
        reader.releaseLock();
      }
    });

    return { isEmpty: false, peekedStream };
  } catch (err) {
    reader.releaseLock();
    throw err;
  }
}

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    // Laizy aliases ("laizy-v2-flash" etc.) resolve to internal DeepSeek
    // models BEFORE routing — the thinking/pro substring rules need the real name.
    body.model = resolveModel(body.model);
    const isStream = body.stream ?? false;
    const messages = body.messages || [];

    const isThinkingModel = body.model.includes('thinking');
    const isProModel = body.model.includes('pro');
    const completionId = 'chatcmpl-' + uuidv4();

    if (!isStream) {
      let attempt = 0;
      const maxAttempts = 3;
      let lastError: any = null;
      let parsedResult: ParsedCompletion | null = null;
      let finalUiSessionId = '';

      while (attempt < maxAttempts) {
        attempt++;
        // Account stacking: pick the healthiest account for THIS attempt —
        // failures in previous attempts rotate to the next one automatically.
        let acct: ReturnType<typeof pickAccount>;
        let page: import('playwright').Page;
        try {
          acct = pickAccount();
          page = await getAccountPage(acct);
        } catch (e: any) {
          return c.json({ error: { message: e?.message || 'No account available', type: 'no_account_available', code: 'no_account_available' } }, 429);
        }
        const attemptStart = Date.now();
        const telemetry = getModelTelemetry(body.model);
        const currentTargetLimit = telemetry.detectedLimit;

        const compressed = compressMessages(messages, currentTargetLimit, serializeOpenAIMessages);
        const serialized = serializeOpenAIMessages(compressed);
        const systemPrompt = appendToolInstructions(serialized.systemPrompt, body);
        const finalPrompt = systemPrompt ? `${systemPrompt}\n${serialized.prompt}` : serialized.prompt;
        const promptSize = finalPrompt.length;
        const promptTokens = Math.ceil(promptSize / 3.5);

        // QwenProxy-style pre-check: reject oversized input with a clean
        // OpenAI-compatible 400 instead of burning browser attempts on a
        // prompt the model cannot accept.
        if (finalPrompt.length > currentTargetLimit) {
          return c.json({
            error: {
              message: `Input exceeds the usable context for this model (${finalPrompt.length} chars; limit ${currentTargetLimit}). Reduce or summarize the conversation before retrying.`,
              type: 'invalid_request_error',
              code: 'context_length_exceeded',
              param: 'messages'
            }
          }, 400);
        }

        try {
          console.log(`[Chat] Attempt ${attempt}/${maxAttempts} (non-stream) with prompt length ${promptSize} chars.`);
          const result = await createDeepSeekStream(finalPrompt, isThinkingModel, isProModel, null, page);

          const parsed = await parseDeepSeekStreamToOpenAI(
            result.stream,
            completionId,
            body.model,
            promptTokens,
            result.uiSessionId,
            (body as any).tools || []
          );

          if (parsed.content === '' && parsed.toolCalls.length === 0) {
            console.warn(`[Chat] Attempt ${attempt} (non-stream) response was empty.`);
            recordFailure(body.model, promptSize, 'empty response');
            recordUsage(body.model, false, promptTokens, 0, Date.now() - attemptStart, 'empty response');
            continue;
          }

          // Success!
          recordSuccess(body.model, promptSize);
          recordUsage(body.model, true, parsed.usage.prompt_tokens, parsed.usage.completion_tokens, Date.now() - attemptStart);
          setSessionState(true);
          reportAccountSuccess(acct.email);
          saveAccountState(acct.email).catch(() => {});
          parsedResult = parsed;
          finalUiSessionId = result.uiSessionId;
          break;
        } catch (err: any) {
          console.error(`[Chat] Attempt ${attempt} (non-stream) failed:`, err.message);
          lastError = err;
          recordFailure(body.model, promptSize, err?.message);
          recordUsage(body.model, false, promptTokens, 0, Date.now() - attemptStart, err?.message);
          if (/login is required/i.test(err?.message || '')) setSessionState(false);
          // Smart account rotation: classify the failure for the account manager.
          if (/429|high demand|quota|rate limit|too many/i.test(err?.message || '')) {
            reportAccountFailure(acct.email, 'quota', err?.message || 'quota');
          } else if (/login is required/i.test(err?.message || '')) {
            reportAccountFailure(acct.email, 'login_failed', err?.message || 'login');
            // Session expired: try automatic re-login before the next attempt.
            if (attempt < maxAttempts) {
              try {
                const ok = await ensureDeepSeekLogin(page, acct.email, acct.password);
                if (ok) { await saveAccountState(acct.email); reportAccountSuccess(acct.email); }
              } catch (e: any) {
                console.error('[AutoLogin] could not re-login:', e?.message);
              }
            }
          } else {
            reportAccountFailure(acct.email, 'network', err?.message || 'network');
          }
          if (attempt >= maxAttempts) {
            break;
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      if (!parsedResult) {
        throw lastError || new Error("Failed to get a non-empty response from DeepSeek after multiple attempts.");
      }

      const message: any = {
        role: 'assistant',
        content: parsedResult.toolCalls.length > 0 ? null : parsedResult.content
      };
      if (parsedResult.reasoningContent) message.reasoning_content = parsedResult.reasoningContent;
      if (parsedResult.toolCalls.length > 0) message.tool_calls = parsedResult.toolCalls;

      return c.json({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message,
          logprobs: null,
          finish_reason: parsedResult.finishReason
        }],
        usage: parsedResult.usage
      });
    }

    // Streaming mode
    let deepSeekStream: ReadableStream | null = null;
    let uiSessionId = '';
    let attempt = 0;
    const maxAttempts = 3;
    let lastError: any = null;
    let promptSizeUsed = 0;

    while (attempt < maxAttempts) {
      attempt++;
      // Account stacking: pick the healthiest account for THIS attempt.
      let acct: ReturnType<typeof pickAccount>;
      let page: import('playwright').Page;
      try {
        acct = pickAccount();
        page = await getAccountPage(acct);
      } catch (e: any) {
        return c.json({ error: { message: e?.message || 'No account available', type: 'no_account_available', code: 'no_account_available' } }, 429);
      }
      const attemptStart = Date.now();
      const telemetry = getModelTelemetry(body.model);
      const currentTargetLimit = telemetry.detectedLimit;

      const compressed = compressMessages(messages, currentTargetLimit, serializeOpenAIMessages);
      const serialized = serializeOpenAIMessages(compressed);
      const systemPrompt = appendToolInstructions(serialized.systemPrompt, body);
      const finalPrompt = systemPrompt ? `${systemPrompt}\n${serialized.prompt}` : serialized.prompt;
      promptSizeUsed = finalPrompt.length;

      if (finalPrompt.length > currentTargetLimit) {
        return c.json({
          error: {
            message: `Input exceeds the usable context for this model (${finalPrompt.length} chars; limit ${currentTargetLimit}). Reduce or summarize the conversation before retrying.`,
            type: 'invalid_request_error',
            code: 'context_length_exceeded',
            param: 'messages'
          }
        }, 400);
      }

      try {
        console.log(`[Chat] Attempt ${attempt}/${maxAttempts} (stream) with prompt length ${promptSizeUsed} chars.`);
        const result = await createDeepSeekStream(finalPrompt, isThinkingModel, isProModel, null, page);

        // Peek the stream to verify it has content
        const { isEmpty, peekedStream } = await peekStream(result.stream);
        if (isEmpty) {
          console.warn(`[Chat] Attempt ${attempt} (stream) peeked stream was empty.`);
          recordFailure(body.model, promptSizeUsed, 'empty stream');
          continue;
        }

        // Success!
        recordSuccess(body.model, promptSizeUsed);
        deepSeekStream = peekedStream;
        uiSessionId = result.uiSessionId;
        reportAccountSuccess(acct.email);
        saveAccountState(acct.email).catch(() => {});
        break;
      } catch (err: any) {
        console.error(`[Chat] Attempt ${attempt} (stream) failed:`, err.message);
        lastError = err;
        recordFailure(body.model, promptSizeUsed, err?.message);
        recordUsage(body.model, false, Math.ceil(promptSizeUsed / 3.5), 0, Date.now() - attemptStart, err?.message);
        if (/login is required/i.test(err?.message || '')) setSessionState(false);
        // Smart account rotation: classify the failure for the account manager.
        if (/429|high demand|quota|rate limit|too many/i.test(err?.message || '')) {
          reportAccountFailure(acct.email, 'quota', err?.message || 'quota');
        } else if (/login is required/i.test(err?.message || '')) {
          reportAccountFailure(acct.email, 'login_failed', err?.message || 'login');
          if (attempt < maxAttempts) {
            try {
              const ok = await ensureDeepSeekLogin(page, acct.email, acct.password);
              if (ok) { await saveAccountState(acct.email); reportAccountSuccess(acct.email); }
            } catch (e: any) {
              console.error('[AutoLogin] could not re-login:', e?.message);
            }
          }
        } else {
          reportAccountFailure(acct.email, 'network', err?.message || 'network');
        }
        if (attempt >= maxAttempts) {
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (!deepSeekStream) {
      throw lastError || new Error("Failed to get a valid stream from DeepSeek after multiple attempts.");
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    const promptTokens = Math.ceil(promptSizeUsed / 3.5);

    return honoStream(c, async (streamWriter: any) => {
      const writeEvent = async (data: any) => {
        await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const streamStart = Date.now();
      try {
        await writeEvent(makeChunk(completionId, body.model, { role: 'assistant', content: '' }));

        const parsed = await parseDeepSeekStreamToOpenAI(
          deepSeekStream!,
          completionId,
          body.model,
          promptTokens,
          uiSessionId,
          (body as any).tools || [],
          writeEvent
        );

        recordUsage(body.model, true, parsed.usage.prompt_tokens, parsed.usage.completion_tokens, Date.now() - streamStart);
        setSessionState(true);

        await writeEvent(makeChunk(completionId, body.model, {}, parsed.finishReason, parsed.usage));
      } catch (err: any) {
        recordUsage(body.model, false, promptTokens, 0, Date.now() - streamStart, err?.message);
        throw err;
      }
      await streamWriter.write('data: [DONE]\n\n');
    });
  } catch (err: any) {
    console.error('Error in chatCompletions:', err);
    const errMessage = err?.message || String(err);

    let status = 500;
    let code = 'upstream_error';
    if (/account is suspended/i.test(errMessage)) {
      status = 403;
      code = 'deepseek_account_suspended';
    } else if (/login is required/i.test(errMessage)) {
      status = 401;
      code = 'deepseek_login_required';
    } else if (/chat input unavailable|Timeout waiting for chat input/i.test(errMessage)) {
      status = 409;
      code = 'deepseek_chat_unavailable';
    }

    return c.json({ error: { message: errMessage, type: code, code } }, status as any);
  }
}
