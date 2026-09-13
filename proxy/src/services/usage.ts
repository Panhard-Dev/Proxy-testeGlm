/*
 * File: usage.ts
 * Project: deepsproxy
 * In-memory usage accounting for the admin dashboard: request counters,
 * token totals (per model and hourly buckets), recent request log and the
 * last known session state.
 */

export interface UsageRecord {
  ts: number;
  model: string;
  ok: boolean;
  promptTokens: number;
  completionTokens: number;
  ms: number;
  error?: string;
}

interface ModelStats {
  requests: number;
  ok: number;
  promptTokens: number;
  completionTokens: number;
}

const store = (globalThis as any)._usageStore || {
  startedAt: Date.now(),
  records: [] as UsageRecord[],
  perModel: new Map<string, ModelStats>(),
  sessionOk: true,
  lastSessionChangeAt: Date.now(),
  activeAccount: process.env.DEEPSEEK_EMAIL || '',
};
(globalThis as any)._usageStore = store;

const MAX_RECORDS = 500;

export function recordUsage(
  model: string,
  ok: boolean,
  promptTokens: number,
  completionTokens: number,
  ms: number,
  error?: string
): void {
  const rec: UsageRecord = { ts: Date.now(), model, ok, promptTokens, completionTokens, ms, error };
  store.records.push(rec);
  if (store.records.length > MAX_RECORDS) store.records.shift();

  let m = store.perModel.get(model);
  if (!m) {
    m = { requests: 0, ok: 0, promptTokens: 0, completionTokens: 0 };
    store.perModel.set(model, m);
  }
  m.requests++;
  if (ok) m.ok++;
  m.promptTokens += promptTokens;
  m.completionTokens += completionTokens;
}

export function setSessionState(ok: boolean): void {
  if (store.sessionOk !== ok) {
    store.sessionOk = ok;
    store.lastSessionChangeAt = Date.now();
  }
}

export function setActiveAccount(email: string): void {
  store.activeAccount = email;
}

export function getUsage(): any {
  const now = Date.now();
  const hourMs = 3_600_000;

  const buckets: number[] = new Array(24).fill(0);
  const bucketsErr: number[] = new Array(24).fill(0);
  let totalRequests = 0;
  let totalOk = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;

  for (const r of store.records) {
    totalRequests++;
    totalPrompt += r.promptTokens;
    totalCompletion += r.completionTokens;
    if (r.ok) totalOk++;
    const hoursAgo = Math.floor((now - r.ts) / hourMs);
    if (hoursAgo >= 0 && hoursAgo < 24) {
      if (r.ok) buckets[23 - hoursAgo]++;
      else bucketsErr[23 - hoursAgo]++;
    }
  }

  const perModel: any = {};
  for (const [model, m] of store.perModel.entries()) {
    perModel[model] = m;
  }

  return {
    uptimeMs: now - store.startedAt,
    totalRequests,
    totalOk,
    totalFailed: totalRequests - totalOk,
    totalPromptTokens: totalPrompt,
    totalCompletionTokens: totalCompletion,
    totalTokens: totalPrompt + totalCompletion,
    hourly: buckets,
    hourlyFailed: bucketsErr,
    perModel,
    recent: store.records.slice(-30).reverse(),
    session: {
      ok: store.sessionOk,
      since: store.lastSessionChangeAt,
      account: store.activeAccount,
    },
  };
}
