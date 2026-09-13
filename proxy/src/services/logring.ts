/*
 * File: logring.ts
 * Project: deepsproxy
 * Ring buffer of server logs for the admin dashboard. Hooks console.log /
 * console.warn / console.error once and classifies entries into
 * info/warn/error so the Logs view can show (and filter) everything the
 * server prints, including [Chat], [Telemetry], [AutoLogin] and stack traces.
 */

export interface LogEntry {
  id: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

const store = (globalThis as any)._logRingStore || {
  entries: [] as LogEntry[],
  nextId: 1,
};
(globalThis as any)._logRingStore = store;

const MAX_ENTRIES = 800;
const ERROR_RE = /error|failed|uncaught|exception|EADDRINUSE|cannot|unable/i;
const WARN_RE = /\bfail|warn|retry|dropping|reduced|expired/i;

function classify(text: string): LogEntry['level'] {
  if (ERROR_RE.test(text)) return 'error';
  if (WARN_RE.test(text)) return 'warn';
  return 'info';
}

function push(level: LogEntry['level'], parts: any[]): void {
  const text = parts
    .map((p) => (typeof p === 'string' ? p : (() => { try { return JSON.stringify(p); } catch { return String(p); } })()))
    .join(' ');
  store.entries.push({ id: store.nextId++, ts: Date.now(), level, text });
  if (store.entries.length > MAX_ENTRIES) store.entries.shift();
}

let hooked = false;

export function hookConsoleLogs(): void {
  if (hooked) return;
  hooked = true;

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: any[]) => { push('info', args); origLog(...args); };
  console.warn = (...args: any[]) => { push('warn', args); origWarn(...args); };
  console.error = (...args: any[]) => { push('error', args); origError(...args); };

  process.on('uncaughtException', (err) => { push('error', ['[uncaughtException]', err?.stack || String(err)]); });
  process.on('unhandledRejection', (err) => { push('error', ['[unhandledRejection]', err instanceof Error ? err.stack : String(err)]); });
}

export function getLogs(sinceId = 0, limit = 300): { entries: LogEntry[]; lastId: number } {
  const entries = store.entries.filter((e: LogEntry) => e.id > sinceId).slice(-limit);
  return { entries, lastId: store.nextId - 1 };
}

export function addLog(level: LogEntry['level'], text: string): void {
  push(level, [text]);
}
