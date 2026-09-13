/*
 * File: autologin.ts
 * Project: deepsproxy
 * Automatic DeepSeek login for a specific account page: fills the /sign_in
 * form with the account credentials and waits for the chat to be ready.
 * If a human challenge appears (none observed so far), it waits
 * DEEPSEEK_AUTOLOGIN_WAIT_MS — run with PLAYWRIGHT_HEADLESS=false to solve it.
 */

const CHAT_URL = 'https://chat.deepseek.com/';

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const AUTOLOGIN_WAIT_MS = envInt('DEEPSEEK_AUTOLOGIN_WAIT_MS', 90_000);

/**
 * Attempt automatic login on the given page. Returns true when the chat input
 * is available at the end. Throws with a clear message on failure.
 */
export async function ensureDeepSeekLogin(
  page: import('playwright').Page,
  email: string,
  password: string
): Promise<boolean> {
  if (!email || !password) {
    throw new Error('Auto-login unavailable: account has no email/password configured.');
  }

  console.log(`[AutoLogin] Session invalid — attempting automatic login for ${email}...`);

  // Deslogado, o site redireciona para /sign_in; aguardamos o form aparecer.
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded' });
  const formReady = await page.waitForSelector('input[type="password"]', { timeout: 15_000 }).then(() => true).catch(() => false);
  if (!formReady) {
    throw new Error('Auto-login failed: login form did not appear (no password field on page).');
  }

  // Real DeepSeek sign_in layout: email is a plain input[type=text] with
  // placeholder "Phone number / email address"; no name/id attributes.
  const emailSelectors = [
    'input[placeholder*="email" i]',
    'input[placeholder*="Phone" i]',
    'input[type="email"]',
    'input[name="email"]',
    'input[type="text"]',
  ];
  const submitSelectors = [
    'div[role="button"]:has-text("Log in")',
    'button[type="submit"]',
    'button:has-text("Log in")',
    'div[role="button"]:has-text("Entrar")',
  ];

  const fillFirst = async (selectors: string[], value: string): Promise<boolean> => {
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el && await el.isVisible().catch(() => false)) {
        await el.fill(value);
        return true;
      }
    }
    return false;
  };

  const emailOk = await fillFirst(emailSelectors, email);
  const passOk = await fillFirst(['input[type="password"]'], password);
  if (!emailOk || !passOk) {
    throw new Error('Auto-login failed: could not fill the login form.');
  }

  let submitted = false;
  for (const sel of submitSelectors) {
    const btn = await page.$(sel);
    if (btn && await btn.isVisible().catch(() => false)) {
      await btn.click();
      submitted = true;
      break;
    }
  }
  if (!submitted) {
    await page.keyboard.press('Enter');
  }

  console.log('[AutoLogin] Credentials submitted — waiting for the chat to be ready...');
  const ok = await page.waitForSelector('textarea, [role="textbox"], [contenteditable="true"]', { timeout: AUTOLOGIN_WAIT_MS })
    .then(() => true)
    .catch(() => false);

  if (ok) {
    console.log(`[AutoLogin] ✅ Logged in automatically: ${email}`);
    return true;
  }

  const url = page.url();
  throw new Error(`Auto-login did not reach the chat within ${AUTOLOGIN_WAIT_MS / 1000}s (url: ${url}). If a human challenge appeared, re-run with PLAYWRIGHT_HEADLESS=false and complete it manually — or increase DEEPSEEK_AUTOLOGIN_WAIT_MS.`);
}
