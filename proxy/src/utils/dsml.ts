/*
 * File: dsml.ts
 * Project: deepsproxy
 * The DeepSeek model sometimes leaks its INTERNAL tool-call markup (DSML) as
 * plain text instead of emitting the instructed <tool_call>{json}</tool_call>
 * tags. This normalizer converts DSML blocks into canonical <tool_call> blocks
 * on the fly, stream-safely (holds back partial tags between chunks).
 *
 * Format observed in the wild:
 * <｜｜DSML｜｜ calls>
 * <｜｜DSML｜｜ invoke name="Bash">
 * <｜｜DSML｜｜ parameter name="command" string="true">ls -la</｜｜DSML｜｜ parameter>
 * <｜｜DSML｜｜ parameter name="description" string="true">List files</｜｜DSML｜｜ parameter>
 * </｜｜DSML｜｜ invoke>
 * </｜｜DSML｜｜ calls>
 *
 * DeepSeek uses U+FF5C (｜) fullwidth vertical bars; ASCII '|' is accepted too.
 */

const BAR = '[｜|]{1,2}';

function makeOpenRe(): RegExp {
  return new RegExp(`<${BAR}\\s*DSML${BAR}\\s*calls\\s*>`, 'gi');
}
function makeCloseRe(): RegExp {
  return new RegExp(`</${BAR}\\s*DSML${BAR}\\s*calls\\s*>`, 'i');
}
function makeInvokeRe(): RegExp {
  return new RegExp(`<${BAR}\\s*DSML${BAR}\\s*invoke\\s+name\\s*=\\s*"([^"]*)"[^>]*>([\\s\\S]*?)</${BAR}\\s*DSML${BAR}\\s*invoke\\s*>`, 'gi');
}
function makeParamRe(): RegExp {
  return new RegExp(`<${BAR}\\s*DSML${BAR}\\s*parameter\\s+name\\s*=\\s*"([^"]*)"[^>]*?(?:\\s+string\\s*=\\s*"(true|false)")?[^>]*>([\\s\\S]*?)</${BAR}\\s*DSML${BAR}\\s*parameter\\s*>`, 'gi');
}

const HOLD_TAGS = ['<｜｜DSML｜｜ calls>', '</｜｜DSML｜｜ calls>', '<||DSML|| calls>', '</||DSML|| calls>'];

/** How much of the buffer can be safely emitted: everything except a suffix that could be the start of a DSML tag. */
function safeEmitLength(buf: string): number {
  const lower = buf.toLowerCase();
  for (const tag of HOLD_TAGS) {
    const tagLower = tag.toLowerCase();
    for (let len = Math.min(tagLower.length - 1, lower.length); len >= 1; len--) {
      if (tagLower.startsWith(lower.slice(lower.length - len))) {
        return lower.length - len;
      }
    }
  }
  return lower.length;
}

/** Convert one complete DSML block into one or more <tool_call> blocks. */
function convertDSMLBlock(block: string): string {
  const out: string[] = [];
  const invokeRe = makeInvokeRe();
  let m: RegExpExecArray | null;
  while ((m = invokeRe.exec(block)) !== null) {
    const name = m[1].trim();
    const body = m[2];
    const args: Record<string, unknown> = {};
    const paramRe = makeParamRe();
    let p: RegExpExecArray | null;
    while ((p = paramRe.exec(body)) !== null) {
      const key = p[1].trim();
      const isString = (p[2] || 'true') === 'true';
      if (isString) {
        args[key] = p[3];
      } else {
        try { args[key] = JSON.parse(p[3]); } catch { args[key] = p[3]; }
      }
    }
    out.push(`<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`);
  }
  // No invoke found: hand the text through untouched.
  return out.length > 0 ? out.join('\n') : block;
}

export interface DSMLNormalizer {
  /** Feed a content chunk; returns normalized text safe to emit downstream. */
  feed(chunk: string): string;
  /** End of stream: converts any trailing block, emits the remainder. */
  flush(): string;
}

export function createDSMLNormalizer(): DSMLNormalizer {
  let buf = '';

  return {
    feed(chunk: string): string {
      buf += chunk;
      let out = '';
      for (;;) {
        const openRe = makeOpenRe();
        const m = openRe.exec(buf);
        if (m && m.index !== undefined) {
          out += buf.slice(0, m.index);
          const rest = buf.slice(m.index);
          const cm = makeCloseRe().exec(rest);
          if (!cm) {
            // Block opened but not closed yet — hold it until more arrives.
            buf = rest;
            return out;
          }
          const closeEnd = cm.index + cm[0].length;
          out += convertDSMLBlock(rest.slice(0, closeEnd));
          buf = rest.slice(closeEnd);
          continue;
        }
        const safe = safeEmitLength(buf);
        out += buf.slice(0, safe);
        buf = buf.slice(safe);
        return out;
      }
    },

    flush(): string {
      const openRe = makeOpenRe();
      const m = openRe.exec(buf);
      if (m && m.index !== undefined) {
        const head = buf.slice(0, m.index);
        const rest = buf.slice(m.index);
        buf = '';
        // Convert whatever invokes exist; a text-only tail passes through.
        return head + convertDSMLBlock(rest);
      }
      const out = buf;
      buf = '';
      return out;
    },
  };
}
