#!/usr/bin/env node
// Laizy terminal interface; adaptation attribution in ui.mjs.
import readline from 'node:readline';
import { readFileSync, realpathSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { OpenAIClient } from './client.mjs';
import { bootstrap } from './bootstrap.mjs';
import { BUILTIN_TOOLS, AGENT_SYSTEM, executeTool } from './tools.mjs';
import { loadHistory, saveSession, deleteSession, newSessionId } from './history.mjs';
import { safe, chars, width, fit, wrap, markdown, errorSummary, theme, wordmark, reflection, background, block, errorBlock, spinnerFrame } from './ui.mjs';

const TOOL_COLORS = {
  run: theme.green,
  create: theme.blue,
  edit: theme.purple ?? theme.violet,
  delete: theme.red,
  read: theme.cyan,
  list: theme.cyan,
};

export class App {
  constructor(client, changed = () => {}) {
    this.client = client; this.changed = changed;
    this.screen = 'landing'; this.tab = 0; this.models = ['glm-4.7', 'x-preview-l']; this.model = client.model;
    this.modelSource = 'fallback'; this.picker = false; this.choice = 0;
    this.messages = []; this.agent = []; this.logs = []; this.filter = 'all'; this.scroll = [0, 0];
    this.toolHits = []; this.clickZones = []; this.suppressKeypress = false; this.mouseBuf = '';
    this.input = []; this.cursor = 0; this.busy = false; this.status = 'Pronto';
    this.lifetime = new AbortController();
    this.menu = null; this.sessionId = null; this.saved = []; this.histChoice = 0;
    this.stats = { requests: 0, prompt: 0, completion: 0, tools: 0, errors: 0, started: Date.now() };
    this.modelStats = new Map();
  }
  log(level, message) {
    this.logs.push({ level, text: `${new Date().toLocaleTimeString()} [${level.toUpperCase()}] ${safe(message).slice(0, 1000)}` });
    this.logs = this.logs.slice(-300); this.changed();
  }
  async refreshModels() {
    if (this.loading) return;
    this.loading = true;
    try {
      const models = await this.client.models(this.lifetime.signal);
      if (!models.length) throw new Error('Catálogo de modelos vazio');
      this.models = models; this.modelSource = 'live /v1/models';
      if (!models.includes(this.model)) this.model = models[0];
      this.log('info', `GET /models: ${models.length} models`);
    } catch (err) {
      if (!this.lifetime.signal.aborted) {
        this.models = ['glm-4.7', 'x-preview-l']; this.modelSource = 'fallback (catalog unavailable)';
        if (!this.models.includes(this.model)) this.model = this.models[0];
        this.log('warn', `GET /models: ${err.message}; usando lista padrão`);
      }
    } finally { this.loading = false; this.choice = Math.max(0, this.models.indexOf(this.model)); this.changed(); }
  }
  menuItems() {
    if (!this.menu) return [];
    if (this.menu.mode === 'models') {
      return this.models.map(m => ({ cmd: m, desc: 'modelo', run: () => { this.model = m; this.menu = null; this.input = []; this.cursor = 0; this.log('info', 'modelo: ' + m); } }));
    }
    const q = this.input.join('').slice(1).trim().toLowerCase();
    const all = [
      { cmd: 'models', desc: 'trocar de modelo', run: () => { this.menu = { mode: 'models', choice: 0 }; void this.refreshModels(); } },
      { cmd: 'new', desc: 'novo chat', run: () => { this.menu = null; this.reset(); } },
      { cmd: 'usage', desc: 'uso desta sessão', run: () => { this.menu = null; this.input = []; this.cursor = 0; this.screen = 'usage'; this.picker = false; } },
      { cmd: 'historico', desc: 'conversas salvas', run: () => { this.menu = null; this.input = []; this.cursor = 0; this.screen = 'history'; this.saved = loadHistory(); this.histChoice = 0; } },
      { cmd: 'quit', desc: 'sair', run: () => { this.quitRequested = true; } },
    ];
    return q ? all.filter(i => i.cmd.startsWith(q)) : all;
  }
  openMenu() { this.menu = this.menu || { mode: 'commands', choice: 0 }; this.menu.choice = 0; this.changed(); }
  async send() {
    const text = this.input.join('').trim();
    if (!text || this.busy) return;
    if (text === '/quit' || text === '/exit') return 'exit';
    if (text === '/model') { this.input = []; this.cursor = 0; this.picker = true; this.choice = this.models.indexOf(this.model); void this.refreshModels(); return; }
    if (text === '/new') { this.reset(); return; }
    if (text.startsWith('/')) { this.openMenu(); this.changed(); return; }
    this.screen = 'chat'; this.tab = 0;
    this.input = []; this.cursor = 0; this.scroll[0] = 0;
    // Histórico real do modelo (system + user + assistant com tool_calls + tool)
    // e histórico de visão (o que a TUI desenha).
    this.agent = this.agent || [];
    this.agent = this.agent.slice(-60);
    this.agent.push({ role: 'user', content: text });
    this.messages = this.messages.slice(-60);
    this.messages.push({ role: 'user', content: text });
    let reply = { role: 'assistant', model: this.model, content: '', reasoning: '' };
    this.messages.push(reply); this.busy = true; this.status = 'Respondendo';
    this.abort = new AbortController();
    const started = Date.now();
    this.log('info', `POST /chat/completions model=${this.model}`);
    const MAX_TURNS = 6;
    let turn = 0;
    try {
      while (turn++ < MAX_TURNS) {
        this.stats.requests++;
        const payload = [{ role: 'system', content: AGENT_SYSTEM }, ...this.agent];
        const pending = new Map(); let sawTools = false;
        for await (const event of this.client.stream({ messages: payload, model: reply.model, signal: this.abort.signal, tools: BUILTIN_TOOLS, toolChoice: 'auto' })) {
          for (const [field, value] of [['content', event.delta], ['reasoning', event.reasoning]]) {
            if (!value) continue;
            const room = 65536 - reply.content.length - reply.reasoning.length;
            reply[field] += value.slice(0, room);
            if (value.length > room) throw new Error('Limite de resposta atingido (64 mil caracteres)');
          }
          if (event.toolCalls) for (const tc of event.toolCalls) {
            const idx = tc.index ?? 0;
            const cur = pending.get(idx) || { id: `call_${Date.now().toString(36)}_${idx}`, name: '', arguments: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.arguments += tc.function.arguments;
            pending.set(idx, cur);
          }
          if (event.usage) {
            this.stats.prompt += event.usage.prompt_tokens || 0;
            this.stats.completion += event.usage.completion_tokens || 0;
            const ms = this.modelStats.get(this.model) || { requests: 0, prompt: 0, completion: 0 };
            ms.requests++; ms.prompt += event.usage.prompt_tokens || 0; ms.completion += event.usage.completion_tokens || 0;
            this.modelStats.set(this.model, ms);
          }
          if (event.finishReason === 'tool_calls') sawTools = true;
          this.changed();
        }
        const calls = [...pending.values()];
        if (!calls.length && !sawTools) break; // resposta final de texto
        // registra no histórico do modelo e executa cada ferramenta
        this.agent.push({
          role: 'assistant', content: reply.content || null,
          tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })),
        });
        for (const c of calls) {
          const result = await executeTool(c.name, c.arguments, { cwd: process.cwd(), signal: this.abort.signal });
          this.stats.tools++;
          this.log(result.ok ? 'info' : 'warn', `tool ${c.name}: ${result.summary}`);
          this.messages.push({ role: 'tool', tool: c.name, toolKind: result.kind, detail: result.detail || result.summary, output: result.summary, ok: result.ok, expanded: false });
          this.agent.push({ role: 'tool', tool_call_id: c.id, content: result.text.slice(0, 8000) });
          this.changed();
        }
        // próximo turno: nova mensagem de assistente na TUI
        reply = { role: 'assistant', model: this.model, content: '', reasoning: '' };
        this.messages.push(reply);
      }
      this.status = `Concluído em ${((Date.now() - started) / 1000).toFixed(1)}s`;
      this.log('info', this.status);
      // persiste a conversa no histórico local
      try {
        if (!this.sessionId) this.sessionId = newSessionId();
        const firstUser = this.messages.find(m => m.role === 'user');
        saveSession(this.sessionId, { title: (firstUser?.content || 'conversa').slice(0, 60), model: this.model, messages: this.messages, agent: this.agent });
      } catch (e) { this.log('warn', 'histórico: ' + e.message); }
    } catch (err) {
      reply.failed = true;
      this.stats.errors++;
      this.status = this.abort.signal.aborted ? 'Cancelado; resposta parcial mantida' : safe(err.message);
      reply.error = this.status; this.log(this.abort.signal.aborted ? 'warn' : 'error', this.status);
    } finally { this.busy = false; this.abort = null; this.changed(); }
  }
  restoreSession(s) {
    if (this.busy) return;
    this.sessionId = s.id;
    this.model = s.model || this.model;
    this.messages = (s.messages || []).map(m => ({ ...m }));
    this.agent = (s.agent || []).map(m => ({ ...m }));
    this.screen = 'chat'; this.tab = 0; this.picker = false;
    this.status = 'Histórico restaurado'; this.changed();
  }
  reset() {
    if (this.busy) return;
    try {
      if (this.messages.length) {
        if (!this.sessionId) this.sessionId = newSessionId();
        const firstUser = this.messages.find(m => m.role === 'user');
        saveSession(this.sessionId, { title: (firstUser?.content || 'conversa').slice(0, 60), model: this.model, messages: this.messages, agent: this.agent });
      }
    } catch {}
    this.sessionId = null;
    this.screen = 'landing'; this.tab = 0; this.picker = false;
    this.messages = []; this.agent = []; this.input = []; this.cursor = 0; this.scroll = [0, 0];
    this.status = 'Pronto'; this.changed();
  }
  key(ch, key = {}) {
    if (this.suppressKeypress) return;
    const n = key.name;

    // telas de uso/histórico: navegação por teclado
    if (this.screen === 'usage') {
      if (n === 'escape' || n === 'tab' || n === 'return') { this.screen = 'chat'; this.changed(); return; }
    }
    if (this.screen === 'history') {
      if (n === 'escape' || n === 'tab') { this.screen = 'chat'; this.changed(); return; }
      else if (n === 'up') this.histChoice = Math.max(0, this.histChoice - 1);
      else if (n === 'down') this.histChoice = Math.min(Math.max(0, this.saved.length - 1), this.histChoice + 1);
      else if (n === 'return') { const s2 = this.saved[this.histChoice]; if (s2) this.restoreSession(s2); }
      else if (ch === 'd') {
        const s2 = this.saved[this.histChoice];
        if (s2) { deleteSession(s2.id); this.saved = loadHistory(); this.histChoice = Math.min(this.histChoice, Math.max(0, this.saved.length - 1)); }
      }
      this.changed(); return;
    }

    // menu de comandos aberto: intercepta só a navegação — digitar continua
    // inserindo e filtrando os itens
    if (this.menu) {
      const items = this.menuItems();
      if (n === 'escape') { this.menu = null; this.input = []; this.cursor = 0; this.changed(); return; }
      if (n === 'up') { this.menu.choice = Math.max(0, this.menu.choice - 1); this.changed(); return; }
      if (n === 'down') { this.menu.choice = Math.min(items.length - 1, this.menu.choice + 1); this.changed(); return; }
      if (n === 'return') {
        const it = items[this.menu.choice];
        if (it) { this.input = []; this.cursor = 0; it.run(); }
        this.changed(); return;
      }
    }
    if (key.ctrl && n === 'c') return 'exit';
    // Ctrl+D só sai com a entrada vazia, para não perder texto por acidente.
    if (key.ctrl && n === 'd' && !this.input.length) return 'exit';
    if (key.ctrl && n === 'l') this.reset();
    else if (n === 'f2' || (key.ctrl && n === 'o')) {
      this.picker = !this.picker; this.choice = Math.max(0, this.models.indexOf(this.model));
      if (this.picker) void this.refreshModels();
    }
    else if (n === 'tab') { this.tab = 1 - this.tab; this.picker = false; }
    else if (this.picker) {
      if (n === 'escape') this.picker = false;
      if (n === 'up') this.choice = Math.max(0, this.choice - 1);
      if (n === 'down') this.choice = Math.min(this.models.length - 1, this.choice + 1);
      if (n === 'return') { this.model = this.models[this.choice]; this.picker = false; }
    } else if (n === 'pageup' || n === 'pagedown') this.scroll[this.tab] = Math.max(0, this.scroll[this.tab] + (n === 'pageup' ? 8 : -8));
    else if (n === 'escape') this.abort?.abort();
    else if (this.tab === 1) {
      if (!key.ctrl && ['t', 'w', 'e'].includes(n)) { this.filter = { t: 'all', w: 'warn', e: 'error' }[n]; this.scroll[1] = 0; }
      if (!key.ctrl && n === 'c') this.logs = [];
      if (n === 'up') this.scroll[1]++;
      if (n === 'down') this.scroll[1] = Math.max(0, this.scroll[1] - 1);
      if (n === 'end') this.scroll[1] = 0;
    } else if (key.ctrl && n === 'u') { this.input = []; this.cursor = 0; }
    else if (n === 'left') this.cursor = Math.max(0, this.cursor - 1);
    else if (n === 'right') this.cursor = Math.min(this.input.length, this.cursor + 1);
    else if (n === 'home' || (key.ctrl && n === 'a')) this.cursor = 0;
    else if (n === 'end' || (key.ctrl && n === 'e')) this.cursor = this.input.length;
    else if (n === 'backspace' && this.cursor > 0) { this.input.splice(--this.cursor, 1); if (this.menu && !this.input.join('').startsWith('/')) this.menu = null; }
    else if (n === 'delete') this.input.splice(this.cursor, 1);
    else if (n === 'return') {
      if (this.menu) { const it = this.menuItems()[this.menu.choice]; if (it) { this.input = []; this.cursor = 0; it.run(); } this.changed(); return; }
      if (['/quit', '/exit'].includes(this.input.join('').trim()) && !this.busy) return 'exit';
      void this.send();
    } else if (ch && !key.ctrl && !key.meta) {
      const insert = chars(safe(ch).replace(/\n/g, ' '));
      if (this.input.join('').length + insert.join('').length <= 8000) { this.input.splice(this.cursor, 0, ...insert); this.cursor += insert.length; }
      const t = this.input.join('');
      if (t === '/' || (t.startsWith('/') && !this.menu)) this.openMenu();
      if (this.menu && this.menu.mode === 'commands' && !t.startsWith('/')) this.menu = null;
    }
    this.changed();
  }
  composer(w, h = 5, chat = false) {
    const size = w - (chat ? 6 : 4), lines = [''];
    let used = 0, cursorLine = 0;
    for (let i = 0; i <= this.input.length; i++) {
      const ch = this.input[i] || ' ', cells = width(ch);
      if (used + cells > size) { lines.push(''); used = 0; }
      if (i === this.cursor) cursorLine = lines.length - 1;
      lines[lines.length - 1] += i === this.cursor ? theme.pink(theme.inverse(ch)) : ch;
      used += cells;
    }
    const capacity = chat ? Math.min(h - 2, lines.length) : h - 2;
    const start = Math.max(0, cursorLine - capacity + 1);
    if (chat) {
      if (!this.input.length) lines[0] += theme.muted(fit('Escreva sua mensagem…', size - 1).trimEnd());
      return [theme.border('╭─ ') + theme.lilac('Mensagem') + theme.border(' ' + '─'.repeat(w - 13) + '╮'),
        ...Array.from({ length: capacity }, (_, i) => theme.border('│ ') +
          (start + i === 0 ? theme.pink('› ') : '  ') + fit(lines[start + i] || '', size) + theme.border(' │')),
        theme.border('╰' + '─'.repeat(w - 2) + '╯')];
    }
    const surface = text => `\x1b[48;2;22;22;29m${text}${background}`;
    return [theme.border('┌' + '─'.repeat(w - 2) + '┐'),
      ...Array.from({ length: capacity }, (_, i) => theme.violet('│') +
        surface(' ' + fit(lines[start + i] || '', size) + ' ') + theme.border('│')),
      theme.border('└' + '─'.repeat(w - 2) + '┘')];
  }
  render(cols, rows) {
    const w = Math.max(0, cols - 1);
    this.clickZones = [];
    const frame = Array.from({ length: Math.max(0, rows) }, () => '');
    const finish = () => frame.map(line => theme.canvas(fit(line, w)));
    if (cols < 40 || rows < 12) {
      if (rows > 0) frame[0] = fit('Terminal pequeno: mínimo 40x12. Ctrl+C sai.', w);
      return finish();
    }


    const landing = this.screen === 'landing' && this.tab === 0;
    const cw = Math.min(landing ? 72 : 100, w - (cols < 60 ? 2 : 6)), left = Math.floor((w - cw) / 2);
    const put = (y, text = '') => { if (y >= 0 && y < rows) frame[y] = ' '.repeat(left) + fit(text, cw); };
    const pair = (a, b) => fit(a, Math.max(0, cw - width(b) - 2)) + '  ' + b;
    const nav = (this.tab === 0 ? theme.lilac : theme.muted)('Chat') + theme.border(' · ') +
      (this.tab === 1 ? theme.lilac : theme.muted)('Logs');
    this.clickZones = [];
    this.clickZones = [];
    if (this.screen === 'usage') {
      put(0, pair(theme.lilac('Laizy CLI'), nav));
      put(1, theme.border('─'.repeat(cw)));
      put(3, theme.pink('Uso da sessão'));
      const u = this.stats;
      const mins = Math.max(1, Math.round((Date.now() - u.started) / 60000));
      const cards = [
        ['Requisições', String(u.requests)],
        ['Tokens', `${u.prompt + u.completion}`],
        ['.. prompt', String(u.prompt)],
        ['.. completion', String(u.completion)],
        ['Ferramentas', String(u.tools)],
        ['Erros', String(u.errors)],
        ['Sessão', `${mins} min`],
        ['Modelo', safe(this.model)],
      ];
      const colW = Math.min(38, Math.floor((cw - 6) / 4));
      cards.forEach(([label, value], i) => {
        const col = i % 4, row = Math.floor(i / 4);
        const bx = left + col * (colW + 2);
        this.clickZones.push({ row: 6 + row * 4, x1: -99, x2: -98 }); // inertes, só alinhamento visual
        const top = theme.border('┌' + '─'.repeat(colW - 2) + '┐');
        const mid = theme.border('│') + ' ' + theme.muted(fit(label, colW - 4)) + ' ' + theme.border('│') + ' ' + theme.lilac(fit(value, colW - 4)) + ' ' + theme.border('│');
        const bot = theme.border('└' + '─'.repeat(colW - 2) + '┘');
        put(6 + row * 4, theme.border('') + '');
        put(6 + row * 4, '');
        const ox = bx;
        const lineAt = (dy, txt) => { const y = 6 + row * 4 + dy; if (y < rows - 6) frame[y] = ' '.repeat(ox) + fit(txt, w); };
        lineAt(0, top);
        lineAt(1, theme.border('│') + ' ' + theme.muted(fit(label, colW - 4)) + ' ' + theme.border('│'));
        lineAt(2, theme.border('│') + ' ' + theme.lilac(fit(value, colW - 4)) + ' ' + theme.border('│'));
        lineAt(3, bot);
      });
      let yy = 6 + Math.ceil(cards.length / 4) * 4 + 1;
      put(yy, theme.pink('Por modelo'));
      yy += 1;
      this.modelStats.forEach((m, name) => {
        put(yy, '  ' + theme.lilac(fit(name, 30)) + theme.muted(`  ${m.requests} reqs · ${m.prompt + m.completion} tokens`));
        yy += 1;
      });
      put(rows - 3, theme.muted('Esc/Tab voltar ao chat'));
      const vpos2 = 0;
      this.clickZones.push({ row: rows - 3, x1: -50, x2: w + 50, action: () => { this.screen = 'chat'; } });
      return finish();
    }
    if (this.screen === 'history') {
      put(0, pair(theme.lilac('Laizy CLI'), nav));
      put(1, theme.border('─'.repeat(cw)));
      put(3, theme.pink('Histórico'));
      put(4, theme.muted(`${this.saved.length} conversa(s) salvas em ~/.laizy/history.json`));
      put(6, theme.muted('↑/↓ escolher · Enter abrir · d deletar · Esc voltar'));
      const count = rows - 10, start = Math.max(0, Math.min(this.histChoice, Math.max(0, this.saved.length - count)));
      this.saved.slice(start, start + count).forEach((s2, i) => {
        const sel = start + i === this.histChoice;
        const title = `${s2.title}`;
        const meta = `${s2.model || ''} · ${new Date(s2.updated || s2.created || Date.now()).toLocaleString('pt-BR')} · ${(s2.messages || []).length} msg`;
        const y = 8 + i;
        put(y, (sel ? theme.selected : theme.muted)(fit(` ${sel ? '›' : ' '} ${safe(title)}`, cw)));
        put(y + 1, theme.muted(fit(`   ${safe(meta)}`, cw)));
      });
      this.clickZones.push({ row: rows - 3, x1: -50, x2: w + 50, action: () => { this.screen = 'chat'; } });
      put(rows - 3, theme.muted('Esc voltar ao chat'));
      if (this.saved.length) {
        const sel = this.saved[Math.min(this.histChoice, count - 1)];
        const ypos = 8 + Math.min(this.histChoice, count - 1) * 2;
        this.clickZones.push({ row: ypos, x1: -50, x2: w + 50, action: () => { if (sel) this.restoreSession(sel); } });
      }
      return finish();
    }

    if (!landing || this.picker) {
      put(0, pair(theme.lilac('Laizy CLI'), nav));
      const mid = left + Math.floor(cw / 2);
      this.clickZones.push({ row: 0, x1: -50, x2: mid, action: () => { this.tab = 0; this.picker = false; } });
      this.clickZones.push({ row: 0, x1: mid, x2: w + 50, action: () => { this.tab = 1; this.picker = false; } });
      put(1, theme.border('─'.repeat(cw)));
    }
    put(rows - 2, theme.muted(safe(this.status)));
    put(rows - 1, theme.muted(cols < 70 ? 'F2 modelo · Tab telas · Ctrl+C sair' :
      'F2 / Ctrl+O modelo    Tab telas    Ctrl+L nova    Ctrl+C sair'));
    if (this.picker) {
      put(3, theme.pink('Selecionar modelo'));
      put(4, theme.muted(this.loading ? 'Atualizando catálogo…' : safe(this.modelSource)));
      const count = rows - 9, start = Math.max(0, this.choice - count + 1);
      this.models.slice(start, start + count).forEach((m, i) => put(6 + i,
        (start + i === this.choice ? theme.selected : theme.muted)(fit(` ${start + i === this.choice ? '›' : ' '} ${safe(m)}`, cw))));
      put(rows - 2, theme.muted('↑/↓ escolher · Enter confirmar · Esc fechar'));
    } else if (landing) {
      const full = rows >= 22 && cw >= width(wordmark[0]);
      const logo = full ? [...wordmark.map((line, i) =>
        (i < 2 ? theme.pink : i < 4 ? theme.lilac : theme.violet)(line)), ...reflection] : [theme.lilac('LAIZY')];
      const composerH = rows < 16 ? 3 : 5;
      const blockH = logo.length + 4 + composerH + 2;
      const top = Math.max(0, Math.floor((rows - 2 - blockH) / 2));
      const center = (y, text) => put(y, ' '.repeat(Math.max(0, Math.floor((cw - width(text)) / 2))) + text);
      logo.forEach((line, i) => center(top + i, line));
      center(top + logo.length + 1, theme.lilac('Laizy CLI'));
      center(top + logo.length + 2, theme.muted('seu espaço para pensar'));
      const y = top + logo.length + 4;
      let menuH = 0;
      if (this.menu) {
        const items = this.menuItems();
        const title = this.menu.mode === 'models' ? 'Modelos' : 'Menu';
        const inner = Math.max(10, cw - 4);
        const menuLines = [theme.border('╭─ ') + theme.lilac(title) + theme.border('─'.repeat(Math.max(0, inner - width(title) - 3)) + '╮')];
        items.forEach((it, i) => {
          const sel = i === this.menu.choice;
          const row = (sel ? theme.selected : s2 => s2)(' ' + (sel ? '› ' : '  ') + fit(it.cmd, 12) + '  ' + theme.muted(fit(it.desc, Math.max(8, inner - 18))));
          menuLines.push(theme.border('│ ') + fit(row, inner) + theme.border(' │'));
        });
        menuLines.push(theme.border('╰' + '─'.repeat(inner) + '╯'));
        menuH = menuLines.length + 1;
        menuLines.forEach((line, i) => put(y - menuH + i, line));
        items.forEach((it, i) => {
          this.clickZones.push({ row: y - menuH + 1 + i, x1: -50, x2: w + 50, action: () => { it.run(); this.changed(); } });
        });
      }
      this.composer(cw, composerH).forEach((line, i) => put(y + i, line));
      const modelLine = 'Modelo ' + safe(this.model) + ' · F2 trocar';
      put(y + composerH, theme.muted('Modelo ') + theme.lilac(safe(this.model)) + theme.muted(' · F2 trocar'));
      const mx = left + Math.floor((cw - width(modelLine)) / 2);
      this.clickZones.push({ row: y + composerH, x1: mx, x2: mx + width(modelLine), action: () => { this.picker = true; this.choice = Math.max(0, this.models.indexOf(this.model)); void this.refreshModels(); } });
      put(y + composerH + 1, theme.muted('Enter enviar · Ctrl+U limpar'));
    } else if (this.tab === 1) {
      put(2, theme.pink('Registro / ') + theme.lilac(`${this.logs.length} eventos`));
      put(3, theme.muted('Requisições da CLI — não são logs do servidor'));
      put(4, ['all', 'warn', 'error'].map((f, i) => (this.filter === f ? theme.selected : theme.muted)([' T todos ', ' W avisos ', ' E erros '][i])).join(' '));
      const content = this.logs.filter(l => this.filter === 'all' || l.level === this.filter)
        .flatMap(l => wrap(l.text, cw - 3).map((line, i) =>
          (l.level === 'error' ? theme.red : l.level === 'warn' ? theme.pink : theme.muted)((i ? '   ' : '·  ') + line)));
      if (!content.length) content.push(theme.muted('— Nenhuma requisição neste filtro.'));
      this.window(content, rows - 10, 1).forEach((line, i) => put(6 + i, line));
      put(rows - 4, theme.border('─'.repeat(cw)));
      put(rows - 3, theme.muted('T/W/E filtrar · C limpar · ↑/↓ rolar · Tab voltar'));
      const vpos = 'T/W/E filtrar · C limpar · ↑/↓ rolar · '.length;
      this.clickZones.push({ row: rows - 3, x1: left + vpos, x2: w + 50, action: () => { this.tab = 0; } });
      this.clickZones.push({ row: rows - 3, x1: -50, x2: left + Math.max(0, vpos - 2), action: () => { this.tab = 1; } });
    } else {
      const error = !this.busy && this.messages.at(-1)?.error;
      const status = error ? wrap(errorSummary(error), cw - 2).slice(0, 2) : [];
      const composer = this.composer(cw, Math.min(8, Math.max(3, rows - 10)), true);
      let composerY = rows - composer.length - 3 - status.length, content = [];
      if (this.menu) {
        const items = this.menuItems();
        const title = this.menu.mode === 'models' ? 'Modelos' : 'Menu';
        const inner = Math.max(10, cw - 4);
        const top = theme.border('╭─ ') + theme.lilac(title) + theme.border('─'.repeat(Math.max(0, inner - width(title) - 3)) + '╮');
        const menuLines = [top];
        items.forEach((it, i) => {
          const sel = i === this.menu.choice;
          const row = (sel ? theme.selected : s2 => s2)(' ' + (sel ? '› ' : '  ') + fit(it.cmd, 12) + '  ' + theme.muted(fit(it.desc, Math.max(8, inner - 18))));
          menuLines.push(theme.border('│ ') + fit(row, inner) + theme.border(' │'));
        });
        menuLines.push(theme.border('╰' + '─'.repeat(inner) + '╯'));
        composerY -= menuLines.length + 1;
        menuLines.forEach((line, i) => {
          put(composerY + i, line);
          if (i >= 1 && i <= items.length) {
            const it = items[i - 1];
            this.clickZones.push({ row: composerY + i, x1: -50, x2: w + 50, action: () => { it.run(); this.changed(); } });
          }
        });
      }
      put(rows - 2, '');
      const foot = cw < 60
        ? (this.busy ? 'Esc cancelar · F2 modelo · Tab Logs' : 'Enter enviar · F2 modelo · Tab Logs')
        : `${this.busy ? 'Esc cancelar' : 'Enter enviar'} · clique nos blocos · F2 modelo · Tab Logs`;
      put(rows - 1, theme.muted(foot));
      const f2pos = foot.indexOf('F2 modelo');
      if (f2pos >= 0) this.clickZones.push({ row: rows - 1, x1: left + f2pos, x2: left + f2pos + 30, action: () => { this.picker = true; this.choice = Math.max(0, this.models.indexOf(this.model)); void this.refreshModels(); } });
      const tabpos = foot.indexOf('Tab Logs');
      if (tabpos >= 0) this.clickZones.push({ row: rows - 1, x1: left + tabpos, x2: w + 50, action: () => { this.tab = 1; this.picker = false; } });
      this.clickZones.push({ row: rows - 1, x1: -50, x2: left + Math.max(0, f2pos - 2), action: () => { this.tab = 0; this.picker = false; } });
      const hitMeta = [];
      const L = (line, hit = null) => { content.push(line); hitMeta.push(hit); };
      for (const m of this.messages) {
        if (content.length) L('');
        if (m.role === 'tool') {
          const arrow = m.expanded ? '[-]' : '[+]';
          const tc = TOOL_COLORS[m.toolKind] || theme.lilac;
          L('   ' + tc(arrow + ' ' + safe(m.tool)) + (m.ok ? theme.muted('  ok') : theme.red('  erro')), { msg: m, kind: 'tool' });
          if (m.expanded) {
            if (m.detail) wrap(m.detail, cw - 6).forEach(l => L('   ' + l));
            if (m.output && m.output !== m.detail) L('   ' + theme.border('└') + theme.muted(' ' + m.output));
          }
          continue;
        }
        const badge = m.role === 'user' ? theme.pink('VOCÊ') : theme.lilac(safe(m.model));
        L(badge);
        if (m.reasoning) {
          const live = this.busy && m === this.messages.at(-1);
          const open = m.thoughtOpen || live;
          const arrow = open ? '[-]' : '[+]';
          L('   ' + theme.yellow(arrow + ' Pensamento') + theme.border(`  · ${String(m.reasoning.length)} caracteres`), { msg: m, kind: 'thought' });
          if (open) wrap(m.reasoning, cw - 10).forEach(l => L('   ' + theme.yellow(l)));
        }
        markdown(m.content || (this.busy && m === this.messages.at(-1) ? `${spinnerFrame()} Aguardando resposta…` : ''), cw - 5).forEach(l => L('     ' + l));
        if (m.error && m !== this.messages.at(-1)) wrap(errorSummary(m.error), cw - 5).forEach(l => L(theme.red('     ' + l)));
      }
      const cap = Math.max(1, composerY - 4);
      const startIdx = Math.max(0, content.length - cap - this.scroll[0]);
      this.toolHits = [];
      content.slice(startIdx, startIdx + cap).forEach((line, i) => {
        put(3 + i, line);
        const hit = hitMeta[startIdx + i];
        if (hit) this.toolHits.push({ row: 3 + i, msg: hit.msg, kind: hit.kind });
      });
      composer.forEach((line, i) => put(composerY + i, line));
      const state = this.busy ? `${spinnerFrame()} Respondendo…` : error ? 'Interrompido' : safe(this.status);
      const meta = ` · ${state}`;
      put(composerY + composer.length, theme.muted(' Modelo ') +
        theme.lilac(fit(safe(this.model), Math.max(1, cw - 8 - width(meta))).trimEnd()) + theme.muted(meta));
      status.forEach((line, i) => put(composerY + composer.length + 1 + i, theme.red('  ' + line)));
    }
    return finish();
  }
  click(row, col) {
    for (const h of this.toolHits) {
      if (h.row === row) {
        if (h.kind === 'thought') h.msg.thoughtOpen = !h.msg.thoughtOpen;
        else h.msg.expanded = !h.msg.expanded;
        this.changed(); return;
      }
    }
    for (const z of this.clickZones) {
      if (z.row === row && col >= z.x1 && col <= z.x2) { z.action(); this.changed(); return; }
    }
  }
  // Parseia eventos de mouse SGR (\x1b[<b;x;yM) vindos do stdin raw e alterna
  // a expansão dos blocos de ferramenta clicados. A sequência pode chegar
  // partida em vários chunks: tudo vai para um buffer, e enquanto houver
  // sequência de mouse em curso os keypresses correspondentes são suprimidos
  // (com timeout de segurança, para nunca engolir digitação real).
  rawData(chunk) {
    this.mouseBuf += chunk.toString();
    let mouse = false;
    for (;;) {
      const sgr = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.mouseBuf);
      const x10 = /\x1b\[M([\s\S]{3})/.exec(this.mouseBuf);
      if (!sgr && !x10) break;
      let row = null, col = null, wheel = null;
      if (sgr && (!x10 || sgr.index <= x10.index)) {
        mouse = true;
        this.mouseBuf = this.mouseBuf.slice(sgr.index + sgr[0].length);
        if (sgr[1] === '64' || sgr[1] === '65') { wheel = sgr[1] === '64' ? 4 : -4; }
        else if (sgr[1] === '0' && sgr[4] === 'M') { row = parseInt(sgr[3], 10) - 1; col = parseInt(sgr[2], 10) - 1; }
      } else {
        // X10 legacy: 3 bytes binários (botão, x+32, y+32). b=0 é press do
        // esquerdo; b=3 é o RELEASE — que não pode alternar de volta!
        mouse = true;
        const b = x10[1].charCodeAt(0) - 32;
        this._lastX10Col = x10[1].charCodeAt(1) - 32 - 1;
        this.mouseBuf = this.mouseBuf.slice(x10.index + x10[0].length);
        if (b === 64 || b === 65) wheel = b === 64 ? 4 : -4;
        else if (b === 0) { row = x10[1].charCodeAt(2) - 32 - 1; col = x10[1].charCodeAt(1) - 32 - 1; }
      }
      if (wheel != null) { this.scroll[this.tab] += wheel; this.changed(); continue; }
      if (row != null) this.click(row, col ?? 0);
    }
    // começo de sequência ainda incompleto → mantém suprimindo
    const partial = /\x1b\[<$|\x1b\[<\d+$|\x1b\[<\d+;$|\x1b\[<\d+;\d+$/.test(this.mouseBuf) || /\x1b\[M?$/.test(this.mouseBuf);
    clearTimeout(this._mouseFlush);
    if (mouse || partial) {
      // suprime os keypresses deste chunk e libera o teclado logo em seguida
      this.suppressKeypress = true;
      this._mouseFlush = setTimeout(() => { this.mouseBuf = ''; this.suppressKeypress = false; }, mouse ? 30 : 150);
      if (!partial) this.mouseBuf = '';
    } else {
      // chunk de teclado normal: libera na hora
      this.mouseBuf = '';
      this.suppressKeypress = false;
    }
  }
  window(lines, capacity, tab) {
    this.scroll[tab] = Math.min(this.scroll[tab], Math.max(0, lines.length - capacity));
    const start = Math.max(0, lines.length - capacity - this.scroll[tab]);
    return lines.slice(start, start + capacity);
  }
  close() { this.lifetime.abort(); this.abort?.abort(); }
}

const DEFAULT_BASE_URL = 'http://localhost:3001/v1';
const DEFAULT_MODEL = 'glm-4.7';
const DEFAULT_API_KEY = '';
// Precedência única de env vars, compartilhada pelos modos TUI e não-interativo.
const envBaseUrl = () => process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
const envModel = () => process.env.OPENAI_MODEL || DEFAULT_MODEL;
const envApiKey = () => process.env.OPENAI_API_KEY || process.env.API_KEY || DEFAULT_API_KEY;

const usage = `Uso: lz [opções] [prompt]

TUI interativa: lz (requer terminal; aceita -m/-b/-k)
Não interativo: lz "explique este erro"
                echo "prompt" | lz
O prompt como argumento tem precedência sobre o stdin.
Use -- antes de um prompt que começa com "-": lz -- "-foo"

Opções:
  -m, --model <id>             ID do modelo (padrão: ${DEFAULT_MODEL})
  -b, --base-url <url>         URL base compatível com OpenAI
  -k, --api-key <chave>        API key
      --tools <json|@arquivo>  JSON de tools no formato OpenAI
      --tool-choice <valor>    auto | none | required | objeto JSON
      --no-bootstrap           Não checa o backend automaticamente
  -h, --help                   Mostra esta ajuda
      --version                Mostra a versão

Ambiente: OPENAI_BASE_URL · OPENAI_API_KEY · OPENAI_MODEL ·
          LZ_NO_BOOTSTRAP=1

TUI: F2 modelo · Tab Chat/Logs · Esc cancela resposta · Ctrl+L nova conversa
     Ctrl+U limpa a entrada · Ctrl+C sai · Comandos: /model · /new · /quit

Códigos de saída: 0 sucesso · 1 erro · 2 resposta vazia · 130 interrompido`;

// Erros locais de CLI (uso, validação, resposta vazia) — distintos de falhas
// de rede para a mensagem de saída não dizer "falha na requisição".
class CliError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message); this.name = 'CliError'; this.exitCode = exitCode;
  }
}

function parseArgs(args) {
  const values = {}, positional = [];
  const flags = new Map([['-m', 'model'], ['--model', 'model'], ['-b', 'baseUrl'], ['--base-url', 'baseUrl'], ['-k', 'apiKey'], ['--api-key', 'apiKey'], ['--tools', 'tools'], ['--tool-choice', 'toolChoice']]);
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!literal && arg === '--') { literal = true; continue; }
    if (!literal && arg === '--no-bootstrap') { values.noBootstrap = true; continue; }
    if (!literal && arg === '--version') { values.version = true; continue; }
    if (!literal && (arg === '-h' || arg === '--help')) { values.help = true; continue; }
    if (!literal && arg.startsWith('-') && arg.length > 1) {
      let name = arg, inline;
      if (arg.startsWith('--')) {
        const eq = arg.indexOf('=');
        if (eq > 0) { name = arg.slice(0, eq); inline = arg.slice(eq + 1); }
      }
      const key = flags.get(name);
      if (!key) throw new CliError(`Opção desconhecida: ${name}. Veja lz --help.`);
      const value = inline ?? args[++i];
      if (value === undefined || (inline === undefined && value !== '-' && value.startsWith('-'))) throw new CliError(`Falta valor para ${name}.`);
      values[key] = value;
      continue;
    }
    positional.push(arg);
  }
  return { ...values, positional };
}

function version() {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || 'desconhecida'; }
  catch { return 'desconhecida'; }
}

function errorHints(msg) {
  if (/fetch failed|ECONNREFUSED/i.test(msg)) return [
    'Nenhum backend respondeu na URL configurada.',
    'Aponte para um endpoint OpenAI-compatível: -b/--base-url ou OPENAI_BASE_URL.'];
  if (/HTTP 401|HTTP 403/i.test(msg)) return [
    'O backend recusou a credencial.',
    'Confira a API key: -k/--api-key ou OPENAI_API_KEY.'];
  if (/Informe um prompt/.test(msg)) return [
    'Exemplo: lz "explique este erro"',
    'Ajuda completa: lz --help'];
  if (/resposta vazia/i.test(msg)) return [
    'Tente novamente; se persistir, verifique o backend configurado.'];
  return [];
}

// Non-interactive: stream to stdout. When stdout is a terminal, present it
// OpenCode-style (prompt echo, animated spinner, boxed reply with footer);
// when piped, keep raw output so `lz "..." | cmd` stays usable.
const TOOL_CHOICES = new Set(['auto', 'none', 'required']);

async function runOnce(parsed) {
  const model = parsed.model || envModel();
  const baseUrl = parsed.baseUrl || envBaseUrl();
  const apiKey = parsed.apiKey || envApiKey();
  const toolsArg = parsed.tools;
  let toolChoice = parsed.toolChoice;
  const prompt = parsed.positional.join(' ').trim() || (!process.stdin.isTTY ? readFileSync(0, 'utf8').trim() : '');
  if (!prompt) throw new CliError('Informe um prompt: passe texto ou pipe no stdin. Veja lz --help.');
  let tools = BUILTIN_TOOLS; // tools embutidas: run_command, write_file, read_file, list_dir
  if (toolsArg) {
    let raw = toolsArg, source = '--tools';
    if (toolsArg.startsWith('@')) {
      source = toolsArg.slice(1);
      try { raw = readFileSync(source, 'utf8'); }
      catch (err) { throw new CliError(`Não foi possível ler o arquivo de tools: ${source} (${err.code === 'ENOENT' ? 'não encontrado' : err.code === 'EACCES' ? 'permissão negada' : err.message})`); }
    }
    try { tools = JSON.parse(raw); } catch { throw new CliError(source === '--tools' ? '--tools deve ser um JSON válido' : `Arquivo de tools contém JSON inválido: ${source}`); }
    if (!Array.isArray(tools)) throw new CliError(source === '--tools' ? '--tools deve ser um array JSON' : `Arquivo de tools deve conter um array JSON: ${source}`);
  }
  if (toolChoice !== undefined && !TOOL_CHOICES.has(toolChoice)) {
    let parsedChoice;
    try {
      parsedChoice = JSON.parse(toolChoice);
      if (parsedChoice === null || typeof parsedChoice !== 'object' || Array.isArray(parsedChoice)) throw new Error();
    } catch { throw new CliError(`--tool-choice deve ser auto, none, required ou um objeto JSON (recebido: ${toolChoice})`); }
    toolChoice = parsedChoice;
  }
  let client;
  try { client = new OpenAIClient({ baseUrl, apiKey, model }); }
  catch (err) { throw new CliError(err.message); }
  const messages = [{ role: 'user', content: prompt }];

  if (!process.stdout.isTTY) {
    let wrote = false, turn = 0;
    for (;;) {
      if (turn++ >= 6) break;
      const pending = new Map();
      for await (const event of client.stream({ messages, model, tools, toolChoice })) {
        if (event.delta) { process.stdout.write(event.delta); wrote = true; }
        if (event.toolCalls) for (const tc of event.toolCalls) {
          const idx = tc.index ?? 0;
          const cur = pending.get(idx) || { id: `call_${turn}_${idx}`, name: '', arguments: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          pending.set(idx, cur);
        }
      }
      const calls = [...pending.values()];
      if (!calls.length) break;
      messages.push({ role: 'assistant', content: null, tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })) });
      for (const c of calls) {
        const result = await executeTool(c.name, c.arguments, { cwd: process.cwd() });
        process.stderr.write('  ' + theme.lilac('▸ ' + c.name) + theme.muted('  ' + result.summary) + '\n');
        messages.push({ role: 'tool', tool_call_id: c.id, content: result.text.slice(0, 8000) });
      }
      process.stdout.write('\n');
    }
    // stdout vazio com exit 0 seria indistinguível de sucesso para um script.
    if (!wrote) throw new CliError('O modelo retornou uma resposta vazia.', { exitCode: 2 });
    process.stdout.write('\n');
    return;
  }

  const cols = Math.max(46, Math.min((process.stdout.columns || 80) - 1, 120));
  const started = Date.now();
  const elapsed = () => ((Date.now() - started) / 1000).toFixed(1);

  for (const [i, line] of wrap(prompt, cols - 4).entries()) {
    process.stdout.write((i === 0 ? theme.violet('❯ ') : '  ') + line + '\n');
  }
  process.stdout.write('\n');

  let spinTimer = setInterval(() => {
    process.stdout.write(`\r\x1b[2K  ${theme.violet(spinnerFrame())} ${theme.muted('pensando…')} ${theme.border(elapsed() + 's')}`);
  }, 80);
  const stopSpinner = () => {
    if (!spinTimer) return;
    clearInterval(spinTimer); spinTimer = null;
    try { process.stdout.write('\r\x1b[2K'); } catch {}
  };
  const onSigint = () => { stopSpinner(); try { process.stdout.write('\n'); } catch {} process.exit(130); };
  process.on('SIGINT', onSigint);

  let content = '', gotContent = false;
  try {
    let turn = 0;
    for (;;) {
      if (turn++ >= 6) break;
      const pending = new Map();
      for await (const event of client.stream({ messages, model, tools, toolChoice })) {
        stopSpinner();
        if (event.delta) { process.stdout.write(event.delta); content += event.delta; gotContent = true; }
        if (event.toolCalls) for (const tc of event.toolCalls) {
          const idx = tc.index ?? 0;
          const cur = pending.get(idx) || { id: `call_${turn}_${idx}`, name: '', arguments: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          pending.set(idx, cur);
        }
      }
      const calls = [...pending.values()];
      if (!calls.length) break;
      messages.push({ role: 'assistant', content: null, tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })) });
      for (const c of calls) {
        const result = await executeTool(c.name, c.arguments, { cwd: process.cwd() });
        process.stdout.write('\n' + theme.lilac(`  ▸ ${c.name}`) + theme.muted(`  ${result.summary}`) + '\n');
        messages.push({ role: 'tool', tool_call_id: c.id, content: result.text.slice(0, 8000) });
      }
      process.stdout.write('\n');
    }
  } finally {
    stopSpinner();
    process.off('SIGINT', onSigint);
  }

  if (!gotContent) throw new CliError('O modelo retornou uma resposta vazia.', { exitCode: 2 });
  if (!content.endsWith('\n')) process.stdout.write('\n');

  // Re-render the streamed answer as a boxed block if it still fits on screen.
  const streamedRows = wrap(safe(content), process.stdout.columns || 80).length;
  if (streamedRows >= (process.stdout.rows || 24) - 2) return;
  process.stdout.write(`\x1b[${streamedRows}A\x1b[0J`);
  const body = markdown(content, cols - 4);
  process.stdout.write(block(body, { footer: `${model} · ${elapsed()}s`, w: cols }).join('\n') + '\n');
}

export async function run() {
  const argv = process.argv.slice(2);
  let parsed;
  try { parsed = parseArgs(argv); }
  catch (err) { process.stderr.write(`Erro: ${safe(err.message)}\n`); process.exitCode = 1; return; }
  if (parsed.help) { console.log(usage); return; }
  if (parsed.version) { console.log(version()); return; }
  if (parsed.noBootstrap) process.env.LZ_NO_BOOTSTRAP = '1';
  // TUI só quando não há prompt e stdin/stdout são terminais; flags sem prompt
  // (ex.: lz -m outro-modelo) configuram a TUI em vez de virarem erro.
  const interactive = !parsed.positional.length && process.stdin.isTTY && process.stdout.isTTY;
  try { await bootstrap(parsed.baseUrl || envBaseUrl(), { interactive }); }
  catch (err) { process.stderr.write(`[lz] bootstrap: ${safe(err.message)}\n`); }
  if (!interactive) {
    runOnce(parsed).catch(err => {
      if (err.name === 'AbortError') { process.exitCode = 130; return; }
      const local = err instanceof CliError;
      process.exitCode = local ? err.exitCode : 1;
      if (process.stdout.isTTY) {
        const cols = Math.max(46, Math.min((process.stdout.columns || 80) - 1, 120));
        process.stdout.write(errorBlock(safe(err.message), errorHints(err.message), cols).join('\n') + '\n');
      } else {
        console.error(`Erro: ${local ? '' : 'falha na requisição: '}${safe(err.message)}`);
      }
    });
    return;
  }
  let client;
  try { client = new OpenAIClient({ baseUrl: parsed.baseUrl || envBaseUrl(), apiKey: parsed.apiKey || envApiKey(), model: parsed.model || envModel() }); }
  catch (err) { process.stderr.write(`Erro: ${safe(err.message)}\n`); process.exitCode = 1; return; }
  let active = true, timer, previous = [];
  const app = new App(client, () => { if (active && !timer) timer = setTimeout(() => { timer = null; render(); }, 33); });
  // Keep the busy spinner animating even without stream deltas (e.g., while
  // the server still holds the request open).
  const anim = setInterval(() => { if (!active) return; if (app.busy) render(); if (app.quitRequested) stop(); }, 100);
  anim.unref?.();
  function render() {
    if (!active) return;
    const rows = process.stdout.rows || 24, cols = process.stdout.columns || 80;
    const lines = app.render(cols, rows);
    let out = '';
    for (let i = 0; i < rows; i++) {
      const line = lines[i] || theme.canvas(' '.repeat(Math.max(1, cols - 1)));
      if (line !== previous[i]) out += `\x1b[${i + 1};1H${background}\x1b[2K${line}\x1b[0m`;
    }
    previous = lines; process.stdout.write(out);
  }
  const wasRaw = process.stdin.isRaw;
  function stop() {
    if (!active) return;
    active = false; clearTimeout(timer); clearInterval(anim); app.close();
    process.stdin.off('keypress', onKey); process.stdout.off('resize', resize);
    process.stdin.setRawMode(Boolean(wasRaw)); process.stdin.pause();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit']) process.off(signal, stop);
    process.off('uncaughtExceptionMonitor', stop);
    try { writeSync(1, '\x1b[0m\x1b[?25h\x1b[?1049l\x1b[?1000l\x1b[?1006l'); } catch {}
  }
  function onKey(ch, key) { if (app.key(ch, key) === 'exit') stop(); }
  function resize() { previous = []; render(); }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit']) process.on(signal, stop);
  process.on('uncaughtExceptionMonitor', stop);
  process.stdin.on('data', chunk => app.rawData(chunk));
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true); process.stdin.resume();
  process.stdin.on('keypress', onKey); process.stdout.on('resize', resize);
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[?25l\x1b[?1000h\x1b[?1006h');
  render(); void app.refreshModels();
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  run().catch(err => { console.error(safe(err.message)); process.exitCode = 1; });
}
