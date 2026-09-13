/*
 * File: accounts.ts
 * Project: deepsproxy
 * Account stacking (QwenProxy-style): multiple DeepSeek accounts persisted
 * locally, each with its own browser storageState (cookies), served through a
 * single shared Chromium. Smart rotation: the manager sticks to a healthy
 * account and puts failing ones on cooldown — login failures get a short
 * cooldown, quota/limit failures a longer one, network errors none.
 */

import fs from 'fs';
import path from 'path';

export interface StoredAccount {
  email: string;
  password: string;
  statePath: string;      // storageState json for this account's context
  cooldownUntil: number;  // epoch ms; 0 = healthy
  cooldownReason: string;
  failures: number;
  lastUsedAt: number;
  lastError: string;
  hasState: boolean;      // whether a saved session exists
  legacyImportPending?: boolean; // import cookies from the old deepseek_profile once
}

interface AccountsFile {
  accounts: StoredAccount[];
  active: string; // sticky account (last healthy used)
}

const ROOT = process.cwd();
const FILE = path.join(ROOT, 'accounts.json');
const STATE_DIR = path.join(ROOT, 'accounts_storage');

const COOLDOWNS_MS: Record<string, number> = {
  login_failed: 5 * 60_000,   // wrong/expired credentials
  quota: 15 * 60_000,         // limit / high demand
  network: 0,                 // not the account's fault
};

function load(): AccountsFile {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(raw.accounts)) return raw;
  } catch {}
  return { accounts: [], active: '' };
}

function save(data: AccountsFile): void {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function store(): AccountsFile {
  return (globalThis as any)._accountsStore || load();
}

function commit(data: AccountsFile): void {
  (globalThis as any)._accountsStore = data;
  save(data);
}

// initialize the global store once (migrating the .env account on first boot)
if (!(globalThis as any)._accountsStore) {
  const data = load();
  const email = process.env.DEEPSEEK_EMAIL || '';
  const password = process.env.DEEPSEEK_PASSWORD || '';
  if (data.accounts.length === 0 && email && password) {
    data.accounts.push({
      email, password,
      statePath: path.join(STATE_DIR, email.replace(/[^a-z0-9._-]/gi, '_'), 'state.json'),
      cooldownUntil: 0, cooldownReason: '', failures: 0, lastUsedAt: 0, lastError: '', hasState: false,
      // the old single-account persistent profile holds a live session — import it once
      legacyImportPending: fs.existsSync(path.join(ROOT, 'deepseek_profile', 'Default', 'Cookies')),
    });
    data.active = email;
  }
  (globalThis as any)._accountsStore = data;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  save(data);
}

export function markLegacyImported(email: string): void {
  const acc = getAccount(email);
  if (acc && acc.legacyImportPending) { acc.legacyImportPending = false; acc.hasState = true; commit(store()); }
}

export function getAccount(email: string): StoredAccount | undefined {
  return store().accounts.find(a => a.email === email);
}

export function listAccounts(): StoredAccount[] {
  return store().accounts;
}

export function activeEmail(): string {
  return store().active;
}

export function addAccount(email: string, password: string): StoredAccount {
  const data = store();
  let acc = data.accounts.find(a => a.email === email);
  if (acc) {
    acc.password = password; // re-adding updates credentials
  } else {
    acc = {
      email, password,
      statePath: path.join(STATE_DIR, email.replace(/[^a-z0-9._-]/gi, '_'), 'state.json'),
      cooldownUntil: 0, cooldownReason: '', failures: 0, lastUsedAt: 0, lastError: '', hasState: false,
    };
    data.accounts.push(acc);
  }
  commit(data);
  return acc;
}

export function removeAccount(email: string): boolean {
  const data = store();
  const before = data.accounts.length;
  data.accounts = data.accounts.filter(a => a.email !== email);
  if (data.active === email) data.active = data.accounts[0]?.email || '';
  commit(data);
  try { fs.rmSync(path.dirname(getAccount(email)?.statePath || ''), { recursive: true, force: true }); } catch {}
  return data.accounts.length < before;
}

export function setHasState(email: string, hasState: boolean): void {
  const acc = getAccount(email);
  if (acc && acc.hasState !== hasState) { acc.hasState = hasState; commit(store()); }
}

/** Pick the account for the next request: sticky-active if healthy, else the healthiest off-cooldown. */
export function pickAccount(): { email: string; password: string; statePath: string; hasState: boolean } {
  const data = store();
  const now = Date.now();
  const healthy = data.accounts.filter(a => a.cooldownUntil <= now);
  if (healthy.length === 0) {
    const soonest = Math.min(...data.accounts.map(a => a.cooldownUntil));
    const waitMin = Math.max(1, Math.ceil((soonest - now) / 60_000));
    throw new Error(`No account available — all on cooldown. Next account free in ~${waitMin} min.`);
  }
  const sticky = healthy.find(a => a.email === data.active);
  const chosen = sticky || healthy.sort((a, b) => a.failures - b.failures || a.lastUsedAt - b.lastUsedAt)[0];
  data.active = chosen.email;
  chosen.lastUsedAt = now;
  commit(data);
  return chosen;
}

/** Report the outcome of a request so rotation/cooldown adapts. */
export function reportSuccess(email: string): void {
  const acc = getAccount(email);
  if (!acc) return;
  acc.failures = 0;
  acc.cooldownUntil = 0;
  acc.cooldownReason = '';
  acc.lastError = '';
  const data = store();
  data.active = email;
  commit(data);
}

export function reportFailure(email: string, kind: 'login_failed' | 'quota' | 'network', detail: string): void {
  const acc = getAccount(email);
  if (!acc) return;
  acc.failures++;
  acc.lastError = detail.slice(0, 200);
  const ms = COOLDOWNS_MS[kind] ?? 0;
  if (ms > 0) {
    acc.cooldownUntil = Date.now() + ms;
    acc.cooldownReason = kind;
  }
  // If the sticky account failed, rotate active to the healthiest other account.
  const data = store();
  if (data.active === email) {
    const others = data.accounts
      .filter(a => a.email !== email && a.cooldownUntil <= Date.now())
      .sort((a, b) => a.failures - b.failures || a.lastUsedAt - b.lastUsedAt);
    if (others[0]) data.active = others[0].email;
  }
  commit(data);
  console.log(`[Accounts] Failure on ${email} (${kind}) — cooldown ${Math.round(ms / 60000)}min. Active now: ${data.active || '(none)'}`);
}

/** Convert an account to a dashboard-friendly view. */
export function listView(): any[] {
  const now = Date.now();
  return store().accounts.map(a => ({
    email: a.email,
    hasState: a.hasState,
    failures: a.failures,
    lastUsedAt: a.lastUsedAt,
    lastError: a.lastError,
    status: a.cooldownUntil > now
      ? 'cooldown'
      : (a.hasState ? 'logged_in' : 'never_logged'),
    cooldownUntil: a.cooldownUntil,
    cooldownReason: a.cooldownReason,
    cooldownMin: a.cooldownUntil > now ? Math.ceil((a.cooldownUntil - now) / 60_000) : 0,
    active: a.email === store().active,
  }));
}

export function count(): number {
  return store().accounts.length;
}
