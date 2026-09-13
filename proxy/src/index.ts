/*
 * File: index.ts
 * Project: deepsproxy
 */

import 'dotenv/config'; // must be first: ESM evaluates imports before module code runs
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { chatCompletions } from './routes/chat.ts';
import { initPlaywright, getAccountPage, saveAccountState, closeAccount } from './services/playwright.ts';
import { getContextLength } from './services/telemetry.ts';
import { hookConsoleLogs, getLogs } from './services/logring.ts';
import { getUsage, setSessionState } from './services/usage.ts';
import { ensureDeepSeekLogin } from './services/autologin.ts';
import * as accounts from './services/accounts.ts';
import { MODEL_IDS, listAliasIds, resolveModel, DISPLAY_NAMES } from './services/models.ts';

hookConsoleLogs();

export const app = new Hono();

function modelEntry(id: string) {
  const dynamicLimit = getContextLength(id);
  return {
    id,
    display_name: DISPLAY_NAMES[id] || id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'deepseek',
    permission: [],
    root: id,
    parent: null,
    context_length: dynamicLimit,
    max_context_tokens: dynamicLimit,
    max_input_tokens: dynamicLimit,
    max_output_tokens: 8_000,
  };
}

app.use('*', cors());

app.use('*', async (c, next) => {
  // The admin HTML page itself is public; its data endpoints below stay protected.
  if (c.req.path === '/admin') return next();
  const authHeader = c.req.header('Authorization');
  const xApiKey = c.req.header('X-API-Key');
  const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : xApiKey;

  // Dashboard endpoints accept the simple panel password (ADMIN_PASSWORD, default 123456)...
  if (c.req.path.startsWith('/admin/api/')) {
    const adminPass = process.env.ADMIN_PASSWORD || '123456';
    if (providedKey === adminPass) return next();
  }

  // ...while the OpenAI-compatible proxy keeps requiring the strong API_KEY.
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    if (!providedKey || providedKey !== apiKey) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }
  await next();
});

// Basic health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// OpenAI compatible routes
app.post('/v1/chat/completions', chatCompletions);

app.get('/v1/models', (c) => {
  return c.json({
    object: 'list',
    data: listAliasIds().map(alias => modelEntry(alias))
  });
});

// ── Models (dashboard view) ─────────────────────────────────────────────────

const MODEL_IDS = [
  'deepseek-v4-flash',
  'deepseek-v4-flash-thinking',
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-thinking',
  'deepseek-v4-pro',
  'deepseek-v4-pro-thinking',
];

app.get('/admin/api/models', (c) => {
  return c.json({
    data: listAliasIds().map(alias => ({
      ...modelEntry(alias),
      internal: resolveModel(alias),
    }))
  });
});

app.post('/admin/api/models/test', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const requested = String(body.model || '');
  const model = resolveModel(requested);
  if (!MODEL_IDS.includes(model)) {
    return c.json({ ok: false, error: 'Modelo desconhecido.' }, 400);
  }
  const port = process.env.PORT || '3000';
  const start = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.API_KEY || ''}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Responda apenas: ok' }],
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const j: any = await res.json();
    const ms = Date.now() - start;
    if (j?.error) return c.json({ ok: false, error: j.error.message || String(j.error), ms });
    return c.json({ ok: true, reply: String(j?.choices?.[0]?.message?.content || '').trim().slice(0, 60), ms });
  } catch (err: any) {
    return c.json({ ok: false, error: err?.message || String(err), ms: Date.now() - start });
  }
});

// ── Admin dashboard ──────────────────────────────────────────────────────────

app.get('/admin', serveStatic({ path: './public/admin.html' }));

app.get('/admin/api/usage', (c) => c.json(getUsage()));

app.get('/admin/api/logs', (c) => {
  const sinceId = Number(c.req.query('since') || 0);
  const limit = Math.min(500, Number(c.req.query('limit') || 300));
  return c.json(getLogs(sinceId, limit));
});

// ── Account stacking ────────────────────────────────────────────────────────

app.get('/admin/api/accounts', (c) => {
  return c.json({ accounts: accounts.listView(), count: accounts.count() });
});

async function loginAndStack(email: string, password: string): Promise<{ ok: boolean; message?: string; error?: string }> {
  if (!email || !password) return { ok: false, error: 'Informe email e senha.' };
  const acct = accounts.addAccount(email, password);
  try {
    const page = await getAccountPage(acct);
    const ok = await ensureDeepSeekLogin(page, acct.email, acct.password);
    if (ok) {
      await saveAccountState(acct.email);
      accounts.setHasState(acct.email, true);
      accounts.reportSuccess(acct.email);
      setSessionState(true);
      return { ok: true, message: `Conta ${email} logada e empilhada.` };
    }
    return { ok: false, error: 'Login não confirmado.' };
  } catch (err: any) {
    accounts.reportFailure(acct.email, 'login_failed', err?.message || String(err));
    setSessionState(false);
    return { ok: false, error: err?.message || String(err) };
  }
}

app.post('/admin/api/accounts/add', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = await loginAndStack(String(body.email || '').trim(), String(body.password || ''));
  return c.json(r, r.ok ? 200 : 500);
});

app.post('/admin/api/accounts/remove', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email || '');
  if (!email) return c.json({ ok: false, error: 'Informe o email.' }, 400);
  await closeAccount(email);
  const removed = accounts.removeAccount(email);
  return c.json({ ok: removed });
});

// Compat: re-login / update credentials of an existing (or new) account.
app.post('/admin/api/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = await loginAndStack(String(body.email || '').trim(), String(body.password || ''));
  return c.json(r, r.ok ? 200 : 500);
});

// Initialize playwright when server starts
import { fileURLToPath } from 'url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  initPlaywright().then(() => {
    console.log('Playwright initialized.');
    console.log(`Account stack: ${accounts.count()} account(s).`);
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    console.log(`Server is running on port ${port}`);

    serve({
      fetch: app.fetch,
      port
    });
  }).catch((err: any) => {
    console.error('Failed to initialize playwright:', err);
    process.exit(1);
  });
}
