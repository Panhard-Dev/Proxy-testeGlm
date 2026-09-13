const isDebug = process.env.TOOLCALL_DEBUG === "1";

export function isToolcallDebugEnabled(): boolean {
  return isDebug;
}

function fmt(msg: string, data?: Record<string, unknown>): string {
  if (!data) return `[parser] ${msg}`;
  const preview = JSON.stringify(data).substring(0, 500);
  return `[parser] ${msg} ${preview}`;
}

export const logger = {
  debug(msg: string, data?: Record<string, unknown>) {
    if (isDebug) console.log(fmt(msg, data));
  },
  warn(msg: string, data?: Record<string, unknown>) {
    console.warn(fmt(msg, data));
  },
  error(msg: string, data?: Record<string, unknown>) {
    console.error(fmt(msg, data));
  },
};
