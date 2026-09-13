/*
 * File: compression.ts
 * Project: deepsproxy
 * Context truncation (QwenProxy-style): keep the system prompt and the most
 * recent messages intact, drop older messages with an explicit notice, and
 * NEVER split an assistant tool_calls message from its tool responses —
 * breaking that pair corrupts the OpenAI tool-calling protocol.
 */

import { Message } from './types.ts';

const TRUNCATION_KEEP_RECENT_UNITS = 20;

const TRUNCATION_NOTICE =
  '[Context truncated: older messages were removed to fit within model limits. Recent messages preserved.]';

/**
 * Group messages into atomic units. An assistant message with tool_calls is
 * glued to the tool responses that follow it (matched by tool_call_id), so a
 * unit is either a single message or a complete tool-call round trip.
 */
function buildUnits(messages: Message[]): Message[][] {
  const units: Message[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as any;
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const unit: Message[] = [msg];
      const ids = new Set(msg.tool_calls.map((tc: any) => tc.id).filter(Boolean));
      let j = i + 1;
      while (j < messages.length) {
        const next = messages[j] as any;
        if (next.role === 'tool' && ids.has(next.tool_call_id)) {
          unit.push(messages[j]);
          j++;
        } else if (next.role === 'assistant' && Array.isArray(next.tool_calls) && next.tool_calls.length === 0) {
          break;
        } else {
          break;
        }
      }
      units.push(unit);
      i = j - 1;
    } else {
      units.push([messages[i]]);
    }
  }
  return units;
}

/**
 * Compresses the messages list to ensure the resulting serialized prompt length
 * is strictly under targetLimit characters. Recent messages win; older ones are
 * dropped (with a notice), never silently — and tool-call pairs stay intact.
 */
export function compressMessages(
  messages: Message[],
  targetLimit: number,
  serializeFn: (msgs: Message[]) => { prompt: string; systemPrompt: string }
): Message[] {
  const measure = (msgs: Message[]) => {
    const s = serializeFn(msgs);
    return (s.systemPrompt ? s.systemPrompt.length + 1 : 0) + s.prompt.length;
  };

  const totalLength = measure(messages);
  const compressionThreshold = Math.floor(targetLimit * 0.85);
  if (totalLength <= compressionThreshold) {
    return messages;
  }

  console.log(`[Compression] Prompt length ${totalLength} exceeds target limit of ${targetLimit}. Starting truncation...`);

  const units = buildUnits(messages);
  const systemUnits = units.filter(u => u[0]?.role === 'system');
  const nonSystemUnits = units.filter(u => u[0]?.role !== 'system');

  const assemble = (keep: number, withNotice: boolean): { msgs: Message[]; dropped: number } => {
    const keptUnits = nonSystemUnits.slice(-keep);
    const dropped = nonSystemUnits.length - keptUnits.length;
    const msgs: Message[] = systemUnits.flat();
    if (withNotice && dropped > 0) {
      msgs.push({ role: 'system', content: TRUNCATION_NOTICE } as Message);
    }
    msgs.push(...keptUnits.flat());
    return { msgs, dropped };
  };

  // Start with the recent window and halve it until it fits (QwenProxy strategy).
  let keep = Math.min(TRUNCATION_KEEP_RECENT_UNITS, nonSystemUnits.length);
  let assembled = assemble(keep, false);
  while (measure(assembled.msgs) > targetLimit && keep > 1) {
    keep = Math.max(1, Math.floor(keep / 2));
    assembled = assemble(keep, false);
  }

  // Still over (giant system prompt or a single huge recent message):
  // truncate older kept message contents tail-preserving, then the last one as
  // a hard fallback. tool_calls structures are never touched.
  if (measure(assembled.msgs) > targetLimit) {
    const truncateContent = (content: any, keepChars: number) => {
      if (typeof content !== 'string' || content.length <= keepChars) return content;
      return `[...TRUNCATED ${content.length - keepChars} CHARACTERS TO FIT CONTEXT WINDOW...]\n` + content.substring(content.length - keepChars);
    };
    const body = assembled.msgs;
    for (let pass = 800; pass >= 200 && measure(body) > targetLimit; pass = Math.floor(pass / 2)) {
      for (let i = 0; i < body.length - 1 && measure(body) > targetLimit; i++) {
        const m: any = body[i];
        if (m.role !== 'system' && typeof m.content === 'string') {
          m.content = truncateContent(m.content, pass);
        }
      }
    }
    // Hard fallback: the very last message too.
    const last: any = body[body.length - 1];
    if (measure(body) > targetLimit && last && typeof last.content === 'string') {
      last.content = truncateContent(last.content, 500);
    }
  }

  const finalMsgs = assembled.dropped > 0 ? assemble(keep, true).msgs : assembled.msgs;
  console.log(`[Compression] Truncation finished. Kept ${keep}/${nonSystemUnits.length} recent units (${assembled.dropped} dropped). Final length: ${measure(finalMsgs)}`);
  return finalMsgs;
}
