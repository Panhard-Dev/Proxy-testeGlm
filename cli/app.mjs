#!/usr/bin/env node
// Laizy terminal interface; adaptation attribution in ui.mjs.
import readline from 'node:readline';
import { readFileSync, realpathSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { OpenAIClient } from './client.mjs';
import { bootstrap } from './bootstrap.mjs';
import { BUILTIN_TOOLS, AGENT_SYSTEM, executeTool } from './tools.mjs';
import { safe, chars, width, fit, wrap, markdown, errorSummary, theme, wordmark, reflection, background, block, errorBlock, spinnerFrame } from './ui.mjs';

export class App {
  constructor(client, changed = () => {}) {
    this.client = client; this.changed = changed;
    this.screen = 'landing'; this.tab = 0; this.models = ['glm-4.7', 'x-preview-l']; this.model = client.model;
    this.modelSource = 'fallback'; this.picker = false; this.choice = 0;
    this.messages = []; this.logs = []; this.filter = 'all'; this.scroll = [0, 0];
    this.input = []; this.cursor = 0; this.busy = false; this.status = 'Pronto';
    this.lifetime = new AbortController();
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
  async send() {
    const text = this.input.join('').trim();
    if (!text || this.busy) return;
    if (text === '/quit' || text === '/exit') return 'exit';
    if (text === '/model') { this.input = []; this.cursor = 0; this.picker = true; this.choice = this.models.indexOf(this.model); void this.refreshModels(); return; }
    if (text === '/new') { this.reset(); return; }
    if (text.startsWith('/')) { this.status = 'Comandos: /model · /new · /quit'; this.changed(); return; }
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
          this.log(result.ok ? 'info' : 'warn', `tool ${c.name}: ${result.summary}`);
          this.messages.push({ role: 'tool', tool: c.name, detail: result.detail || result.summary, output: result.summary, ok: result.ok });
          this.agent.push({ role: 'tool', tool_call_id: c.id, content: result.text.slice(0, 8000) });
          this.changed();
        }
        // próximo turno: nova mensagem de assistente na TUI
        reply = { role: 'assistant', model: this.model, content: '', reasoning: '' };
        this.messages.push(reply);
      }
      this.status = `Concluído em ${((Date.now() - started) / 1000).toFixed(1)}s`;
      this.log('info', this.status);
    } catch (err) {
      reply.failed = true;
      this.status = this.abort.signal.aborted ? 'Cancelado; resposta parcial mantida' : safe(err.message);
      reply.error = this.status; this.log(this.abort.signal.aborted ? 'warn' : 'error', this.status);
    } finally { this.busy = false; this.abort = null; this.changed(); }
  }
  reset() {
    if (this.busy) return;
    this.screen = 'landing'; this.tab = 0; this.picker = false;
    this.messages = []; this.agent = []; this.input = []; this.cursor = 0; this.scroll = [0, 0];
    this.status = 'Pronto'; this.changed();
  }
  key(ch, key = {}) {
    const n = key.name;
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
    else if (n === 'backspace' && this.cursor > 0) this.input.splice(--this.cursor, 1);
    else if (n === 'delete') this.input.splice(this.cursor, 1);
    else if (n === 'return') {
      if (['/quit', '/exit'].includes(this.input.join('').trim()) && !this.busy) return 'exit';
      void this.send();
    } else if (ch && !key.ctrl && !key.meta) {
      const insert = chars(safe(ch).replace(/\n/g, ' '));
      if (this.input.join('').length + insert.join('').length <= 8000) { this.input.splice(this.cursor, 0, ...insert); this.cursor += insert.length; }
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
    if (!landing || this.picker) {
      put(0, pair(theme.lilac('Laizy CLI'), nav));
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
      this.composer(cw, composerH).forEach((line, i) => put(y + i, line));
      put(y + composerH, theme.muted('Modelo ') + theme.lilac(safe(this.model)) + theme.muted(' · F2 trocar'));
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
    } else {
      const error = !this.busy && this.messages.at(-1)?.error;
      const status = error ? wrap(errorSummary(error), cw - 2).slice(0, 2) : [];
      const composer = this.composer(cw, Math.min(8, Math.max(3, rows - 10)), true);
      const composerY = rows - composer.length - 3 - status.length, content = [];
      put(rows - 2, '');
      put(rows - 1, theme.muted(cw < 60
        ? (this.busy ? 'Esc cancelar · F2 modelo · Tab Logs' : 'Enter enviar · F2 modelo · Tab Logs')
        : `${this.busy ? 'Esc cancelar' : 'Enter enviar'} · F2 modelo · Tab Logs · Ctrl+C sair`));
      for (const m of this.messages) {
        if (content.length) content.push('');
        if (m.role === 'tool') {
          content.push('   ' + theme.lilac('▸ ' + safe(m.tool)) + (m.ok ? theme.muted('  ok') : theme.red('  erro')));
          if (m.detail) content.push(...wrap(m.detail, cw - 6).map(l => '   ' + l));
          if (m.output && m.output !== m.detail) content.push('   ' + theme.border('└') + theme.muted(' ' + m.output));
          continue;
        }
        const badge = m.role === 'user' ? theme.pink('VOCÊ') : theme.lilac(safe(m.model));
        content.push(badge);
        if (m.reasoning) content.push(...wrap('Raciocínio · ' + m.reasoning, cw - 5).map(l => theme.muted('   │ ' + l)));
        content.push(...markdown(m.content || (this.busy && m === this.messages.at(-1) ? `${spinnerFrame()} Aguardando resposta…` : ''), cw - 5).map(l => '     ' + l));
        if (m.error && m !== this.messages.at(-1)) content.push(...wrap(errorSummary(m.error), cw - 5).map(l => theme.red('     ' + l)));
      }
      this.window(content, Math.max(1, composerY - 4), 0).forEach((line, i) => put(3 + i, line));
      composer.forEach((line, i) => put(composerY + i, line));
      const state = this.busy ? `${spinnerFrame()} Respondendo…` : error ? 'Interrompido' : safe(this.status);
      const meta = ` · ${state}`;
      put(composerY + composer.length, theme.muted(' Modelo ') +
        theme.lilac(fit(safe(this.model), Math.max(1, cw - 8 - width(meta))).trimEnd()) + theme.muted(meta));
      status.forEach((line, i) => put(composerY + composer.length + 1 + i, theme.red('  ' + line)));
    }
    return finish();
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
  const anim = setInterval(() => { if (active && app.busy) render(); }, 100);
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
    try { writeSync(1, '\x1b[0m\x1b[?25h\x1b[?1049l'); } catch {}
  }
  function onKey(ch, key) { if (app.key(ch, key) === 'exit') stop(); }
  function resize() { previous = []; render(); }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit']) process.on(signal, stop);
  process.on('uncaughtExceptionMonitor', stop);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true); process.stdin.resume();
  process.stdin.on('keypress', onKey); process.stdout.on('resize', resize);
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[?25l');
  render(); void app.refreshModels();
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  run().catch(err => { console.error(safe(err.message)); process.exitCode = 1; });
}
