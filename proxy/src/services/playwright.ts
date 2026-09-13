/*
 * File: playwright.ts
 * Project: deepsproxy
 * Account-stacked browser layer (QwenProxy-style): ONE shared Chromium, one
 * isolated BrowserContext per account (cookies via storageState), smart
 * acquisition for requests and manual headed login support.
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';

let browser: Browser | null = null;
const contexts = new Map<string, { context: BrowserContext; page: Page }>();

export interface AccountCreds {
  email: string;
  password: string;
  statePath: string;
  hasState: boolean;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--exclude-switches=enable-automation',
  '--disable-infobars',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

async function ensureBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: process.env.PLAYWRIGHT_HEADLESS !== 'false', args: ARGS });
  }
  return browser;
}

/** Get (or create) the isolated context+page for an account, restoring its saved session. */
export async function getAccountPage(acct: AccountCreds & { legacyImportPending?: boolean }): Promise<Page> {
  const existing = contexts.get(acct.email);
  if (existing) return existing.page;

  const b = await ensureBrowser();

  // One-time migration: pull the live session out of the old persistent profile.
  if ((acct as any).legacyImportPending) {
    try {
      const legacy = await chromium.launchPersistentContext(path.resolve('deepseek_profile'), {
        headless: true, args: ARGS,
      });
      fs.mkdirSync(path.dirname(acct.statePath), { recursive: true });
      await legacy.storageState({ path: acct.statePath });
      await legacy.close().catch(() => {});
      const { markLegacyImported } = await import('./accounts.ts');
      markLegacyImported(acct.email);
      console.log(`[Accounts] Imported legacy profile session for ${acct.email}.`);
      acct.hasState = true;
    } catch (e: any) {
      console.warn('[Accounts] Legacy session import failed (will auto-login instead):', e?.message);
    }
  }

  const useStore = fs.existsSync(acct.statePath);
  const context = await b.newContext({
    storageState: useStore ? acct.statePath : undefined,
    userAgent: UA,
    args: ARGS,
  });
  const page = await context.newPage();
  contexts.set(acct.email, { context, page });
  return page;
}

function fsExists(p: string): boolean {
  try { return fs.existsSync(p); } catch { return false; }
}

/** Persist an account's session so the next context restores it. */
export async function saveAccountState(email: string): Promise<void> {
  const entry = contexts.get(email);
  if (!entry) return;
  const acct = (globalThis as any)._accountsStore?.accounts?.find((a: any) => a.email === email);
  if (!acct) return;
  fs.mkdirSync(path.dirname(acct.statePath), { recursive: true });
  await entry.context.storageState({ path: acct.statePath });
}

/** Close and forget an account's context (e.g. after removal). */
export async function closeAccount(email: string): Promise<void> {
  const entry = contexts.get(email);
  if (entry) {
    try { await entry.context.close(); } catch {}
    contexts.delete(email);
  }
}

/**
 * Capture auth headers + PoW for an account page by triggering a real
 * completion request in the UI (and aborting it so history stays clean).
 */
export async function getDeepSeekHeaders(
  page: Page,
  forceNew = false
): Promise<{ headers: Record<string, string>; chatSessionId: string; parentMessageId: number | null }> {
  const currentUrl = page.url();
  const isOnDeepSeek = currentUrl.includes('chat.deepseek.com');
  const isOnSpecificChat = isOnDeepSeek && /\/chat\/\d+/.test(currentUrl);

  if (!isOnDeepSeek || forceNew || isOnSpecificChat) {
    await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
  }

  const chatInputSelector = 'textarea, [role="textbox"], [contenteditable="true"]';
  const chatInputTimeoutMs = Number(process.env.DEEPSPROXY_CHAT_INPUT_TIMEOUT_MS || '8000');
  await page.waitForSelector(chatInputSelector, { timeout: chatInputTimeoutMs }).catch(async () => {
    const state = await page.evaluate(() => {
      const fullBodyText = document.body?.innerText || '';
      const bodyText = fullBodyText.slice(0, 5000);
      const suspensionMatch = fullBodyText.match(/Due to violation of user policies, your account has been suspended until\s+([^\.\n]+)\.\s*If you have any questions, please Contact us\./i);
      const suspendedUntil = suspensionMatch?.[1]?.trim() || null;
      const suspensionOriginal = suspensionMatch?.[0]?.trim() || null;
      return {
        url: location.href,
        title: document.title,
        bodyText,
        suspended: /suspended until|violation of user policies|account has been suspended/i.test(fullBodyText),
        suspendedUntil,
        suspensionOriginal,
        loginRequired: /log in|login|sign in|entrar/i.test(fullBodyText),
      };
    }).catch((e: any) => ({ evaluateError: e?.message || String(e) }));

    if (state?.suspended) {
      const original = state.suspensionOriginal || (state.suspendedUntil ? `Due to violation of user policies, your account has been suspended until ${state.suspendedUntil}.` : 'DeepSeek reported an account suspension.');
      throw new Error(`DeepSeek account is suspended; chat input is unavailable. Original DeepSeek message: ${original}`);
    }
    if (state?.loginRequired) {
      throw new Error('DeepSeek login is required; chat input is unavailable.');
    }
    throw new Error('DeepSeek chat input unavailable; page did not expose an input box.');
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for PoW headers')), 30000);

    const routeHandler = async (route: any, request: any) => {
      clearTimeout(timeout);
      const reqHeaders = request.headers();
      let uiSessionId = '';
      let uiParentMessageId: number | null = null;

      const postData = request.postData();
      if (postData) {
        try {
          const payload = JSON.parse(postData);
          if (payload.chat_session_id) uiSessionId = payload.chat_session_id;
          if (payload.parent_message_id !== undefined) uiParentMessageId = payload.parent_message_id;
        } catch {}
      }

      const extractedHeaders = {
        'x-ds-pow-response': reqHeaders['x-ds-pow-response'] || '',
        'x-hif-dliq': reqHeaders['x-hif-dliq'] || '',
        'x-hif-leim': reqHeaders['x-hif-leim'] || '',
        'authorization': reqHeaders['authorization'] || '',
        'cookie': reqHeaders['cookie'] || '',
      };

      await route.abort('aborted');
      await page.unroute('**/api/v0/chat/completion', routeHandler);
      resolve({ headers: extractedHeaders, chatSessionId: uiSessionId, parentMessageId: uiParentMessageId });
    };

    page.route('**/api/v0/chat/completion', routeHandler).then(() => {
      page.fill('textarea', 'a').then(() => page.keyboard.press('Enter'));
    });
  });
}

/** Kept for compatibility with tests/tooling that referenced the single-page API. */
export async function initPlaywright(): Promise<void> {
  await ensureBrowser();
}

export async function closePlaywright(): Promise<void> {
  for (const [, entry] of contexts) {
    try { await entry.context.close(); } catch {}
  }
  contexts.clear();
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
  }
}

/**
 * Manual headed login for an account (fallback when auto-login fails):
 * opens a visible window on that account's context; resolves when the user
 * closes the window, after saving the session.
 */
export async function openHeadedLogin(acct: AccountCreds): Promise<void> {
  const b = await chromium.launch({ headless: false, args: ARGS });
  const useStore = acct.hasState && fsExists(acct.statePath);
  const context = await b.newContext({
    storageState: useStore ? acct.statePath : undefined,
    userAgent: UA,
    args: ARGS,
  });
  const page = await context.newPage();
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
  console.log(`[Login] Janela aberta para ${acct.email}. Faça login e feche a janela.`);
  await new Promise<void>((resolve) => {
    const check = setInterval(async () => {
      if (!b.isConnected()) { clearInterval(check); resolve(); }
    }, 1000);
    b.on('disconnected', () => { clearInterval(check); resolve(); });
  });
  const dir = path.dirname(acct.statePath);
  fs.mkdirSync(dir, { recursive: true });
  await context.storageState({ path: acct.statePath });
  await b.close().catch(() => {});
}
