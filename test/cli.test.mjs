// Offline: node test/cli.test.mjs (PTY checks use Python 3 on Linux).
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAIClient } from '../cli/client.mjs';
import { App } from '../cli/app.mjs';
import { safe, stripAnsi, width, theme, wordmark, reflection, background } from '../cli/ui.mjs';

// Nested spans preserve surfaces; each completed row restores terminal defaults.
assert.ok(!theme.muted('text').includes('\x1b[0m'));
assert.ok(theme.inverse(' ').endsWith('\x1b[27m'));
assert.ok(theme.selected(theme.lilac('model')).endsWith(background));
assert.ok(theme.canvas('row').endsWith('\x1b[0m'));

const binDir = mkdtempSync(join(tmpdir(), 'laizy-cli-'));
const noBootstrap = { ...process.env, LZ_NO_BOOTSTRAP: '1' };
try {
  for (const alias of ['lz', 'lzcli', 'laizy-cli']) {
    const bin = join(binDir, alias);
    symlinkSync(fileURLToPath(new URL('../cli/app.mjs', import.meta.url)), bin);
    const result = spawnSync(bin, [], { encoding: 'utf8', env: noBootstrap });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Informe um prompt/);
    const help = spawnSync(bin, ['--help'], { encoding: 'utf8', env: noBootstrap });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Uso: lz/);
    assert.match(help.stdout, /LZ_NO_BOOTSTRAP/);
    assert.match(help.stdout, /Códigos de saída/);
    const ver = spawnSync(bin, ['--version'], { encoding: 'utf8', env: noBootstrap });
    assert.equal(ver.status, 0);
    assert.match(ver.stdout, /^\d+\.\d+\.\d+/);
  }
} finally { rmSync(binDir, { recursive: true, force: true }); }

let request, mode = 'ok', toolsServed = 0;
const server = http.createServer(async (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer offline-test');
  if (req.url === '/v1/models') {
    res.writeHead(mode === 'offline' ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'glm-4.7' }, { id: 'x-preview-l' }, { id: '\x1b[2Jbad' }] })); return;
  }
  let body = ''; for await (const chunk of req) body += chunk;
  request = JSON.parse(body);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (mode === 'error') { res.end('data: {"error":{"message":"mock failure"}}\n\n'); return; }
  if (mode === 'truncated') { res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'); return; }
  if (mode === 'empty') { res.end('data: [DONE]\n\n'); return; }
  if (mode === 'hang') { res.write(': waiting\n\n'); return; }
  let data;
  if (mode === 'tools') {
    toolsServed++;
    data = toolsServed === 1
      ? 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"clock","arguments":"{}"}}]}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' + 'data: [DONE]'
      : 'data: {"choices":[{"delta":{"content":"done via tools"}}]}\n\n' + 'data: [DONE]';
  } else data = 'data:{"choices":[{"delta":{"reasoning_content":"checking"}}]}\r\n\r\n' +
      'data: {"choices":[{"delta":{"content":"Hello 世界\\u001b[2J"}}]}\r\n\r\n' +
      'data: [DONE]';
  const bytes = Buffer.from(data);
  for (let i = 0; i < bytes.length; i += 7) {
    res.write(bytes.subarray(i, i + 7));
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const client = new OpenAIClient({ baseUrl, apiKey: 'offline-test' });
const cli = (args, input) => new Promise((resolve, reject) => {
  const child = spawn('node', ['cli/app.mjs', ...args], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: 'offline-test', LZ_NO_BOOTSTRAP: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  child.stdin.end(input);
});
const app = new App(client);
const key = (name, ctrl = false) => app.key(undefined, { name, ctrl });
const screen = (w = 80, h = 24) => {
  const lines = app.render(w, h);
  assert.ok(lines.length <= h);
  for (const line of lines) assert.ok(width(line) <= w - 1, `Overflow: ${line}`);
  return stripAnsi(lines.join('\n'));
};
// Exact ANSI landing snapshots captured before the chat-only change.
for (const [w, h, hash] of [
  [40, 12, '329c3d1956852f0382c348b66795818262b454fadab162d2b54450567e60dfd8'],
  [60, 16, '9f02862eaa5ffe911af3f5060773a2c933d0d983778a387703cfb8aa18d147c2'],
  [80, 24, 'de6e05d829c6cbc2dadcfe02325daaed3511179ee530e5752aa050816c8dab0d'],
  [120, 35, 'd778d28a65600daa9d8aaa4afba794ee4ec37171b26fb1cfea2ee48cf379be12'],
  [180, 50, '5ecee4ee6aa141cf5da8eba1acf03e186f8837913065a5720e4dab0192823dcf'],
]) assert.equal(createHash('sha256').update(new App({ model: 'glm-4.7' }).render(w, h).join('\n')).digest('hex'), hash);

const composerApp = new App(client);
composerApp.screen = 'chat';
for (const [w, h] of [[40, 12], [60, 16], [80, 24], [120, 35], [180, 50]]) {
  const cw = Math.min(100, w - 1 - (w < 60 ? 2 : 6));
  composerApp.input = []; composerApp.cursor = 0;
  const empty = composerApp.composer(cw, 8, true);
  assert.equal(empty.length, 3);
  assert.match(stripAnsi(empty.join('\n')), /Mensagem[\s\S]*›  Escreva sua mensagem…/);
  assert.ok(empty[1].includes(theme.pink(theme.inverse(' ')) + theme.muted('Escreva sua mensagem…')));
  for (const text of ['olá', 'a'.repeat(cw - 6), '界'.repeat(150), 'e\u0301'.repeat(160)]) {
    composerApp.key(undefined, { name: 'u', ctrl: true }); composerApp.key(text);
    for (const cursor of [0, 1, composerApp.input.length - 1, composerApp.input.length]) {
      composerApp.cursor = cursor;
      const box = composerApp.composer(cw, 8, true);
      assert.ok(box.length >= 3 && box.length <= 8);
      if (text === 'olá') assert.equal(box.length, 3);
      if (text.length > cw) assert.ok(box.length > 3);
      assert.equal((box.join('').match(/\x1b\[7m/g) || []).length, 1);
      assert.ok(box.join('').includes(theme.inverse(composerApp.input[cursor] || ' ')));
      let row = 0, col = 0;
      for (let i = 0; i <= cursor; i++) {
        const cells = width(composerApp.input[i] || ' ');
        if (col + cells > cw - 6) { row++; col = 0; }
        if (i < cursor) col += cells;
      }
      const caretRow = box.findIndex(line => line.includes('\x1b[7m'));
      assert.equal(caretRow, Math.min(row, box.length - 3) + 1);
      assert.equal(width(box[caretRow].split('\x1b[7m')[0]), col + 4);
      box.forEach(line => assert.equal(width(line), cw));
      composerApp.render(w, h).forEach(line => assert.equal(width(line), w - 1));
    }
  }
  composerApp.input = []; composerApp.cursor = 0;
  composerApp.busy = true;
  assert.match(stripAnsi(composerApp.render(w, h).join('\n')), /Modelo glm-4.7 · . Respondendo…/);
  composerApp.busy = false;
  for (const error of ['captcha ' + 'RAW'.repeat(1000), 'mock failure ' + '\x1b[2J'.repeat(100), 'Cancelado; resposta parcial mantida']) {
    composerApp.status = error;
    composerApp.messages = [{ role: 'assistant', model: 'glm-4.7', content: '', error }];
    const frame = composerApp.render(w, h), plain = stripAnsi(frame.join('\n'));
    frame.forEach(line => assert.equal(width(line), w - 1));
    assert.doesNotMatch(plain, /RAW|mock failure|tokens|\[2J/);
    assert.match(plain, /Mensagem/);
    assert.ok(frame.filter(line => line.includes('\x1b[38;2;219;135;159m')).length <= 2);
  }
}
composerApp.close();
if (process.argv.includes('--frames')) {
  for (const [w, h] of [[80, 24], [120, 35], [180, 50]]) {
    const preview = new App(client);
    for (const view of ['landing', 'chat', 'chat-error', 'logs']) {
      preview.screen = view === 'landing' ? 'landing' : 'chat'; preview.tab = view === 'logs' ? 1 : 0;
      preview.messages = [{ role: 'user', content: 'Revise a interface do projeto.' },
        { role: 'assistant', model: 'glm-4.7', content: 'Composição centralizada e histórico legível.' }];
      preview.status = view === 'chat-error' ? 'captcha verification failed: ' + 'raw detail '.repeat(100) : 'Pronto';
      if (view === 'chat-error') preview.messages.at(-1).error = preview.status;
      preview.logs = [{ level: 'info', text: '12:00:00 [INFO] POST /chat/completions model=glm-4.7' }];
      console.log(`\n${view} ${w}x${h}\n` + preview.render(w, h).map(l => stripAnsi(l).trimEnd()).join('\n'));
    }
    preview.close();
  }
}
try {
  let result = await cli(['--model', 'x-preview-l', 'hello']);
  assert.equal(result.code, 0); assert.equal(result.stdout, 'Hello 世界\u001b[2J\n');
  assert.equal(request.model, 'x-preview-l'); assert.equal(request.messages[0].content, 'hello');
  result = await cli([], 'stdin prompt');
  assert.equal(result.code, 0); assert.equal(request.messages[0].content, 'stdin prompt');
  result = await cli(['--tools', '[{"type":"function","function":{"name":"clock"}}]', 'what time']);
  assert.equal(result.code, 0); assert.deepEqual(request.tools.map(t => t.function.name), ['clock']);
  result = await cli(['--tools', '{', 'x']);
  assert.equal(result.code, 1); assert.match(result.stderr, /--tools deve ser um JSON válido/);
  result = await cli(['--tools', '@/definitely/missing-tools.json', 'x']);
  assert.equal(result.code, 1); assert.match(result.stderr, /Não foi possível ler o arquivo de tools: .*não encontrado/);
  result = await cli([], '   \n');
  assert.equal(result.code, 1); assert.match(result.stderr, /Informe um prompt.*--help/);
  result = await cli(['--model']);
  assert.equal(result.code, 1); assert.match(result.stderr, /Falta valor para --model/);
  mode = 'tools'; toolsServed = 0; result = await cli(['tool test']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /done via tools/);
  assert.match(result.stderr, /clock/);
  assert.ok(request.messages.some(m => m.role === 'tool'), 'tool result voltou pro backend');
  mode = 'ok';

  // Parsing regressions: flag desconhecida não pode virar prompt; "-h" dentro
  // de um prompt não pode disparar o help; "--" protege prompts com "-".
  result = await cli(['--verbos', 'x']);
  assert.equal(result.code, 1); assert.match(result.stderr, /Opção desconhecida: --verbos/);
  result = await cli(['qual o significado de -h no tar?']);
  assert.equal(result.code, 0); assert.equal(request.messages[0].content, 'qual o significado de -h no tar?');
  result = await cli(['--', '-foo']);
  assert.equal(result.code, 0); assert.equal(request.messages[0].content, '-foo');
  result = await cli(['--model=x-preview-l', 'inline']);
  assert.equal(result.code, 0); assert.equal(request.model, 'x-preview-l');
  result = await cli(['--tool-choice', 'as-string', 'x']);
  assert.equal(result.code, 1); assert.match(result.stderr, /--tool-choice deve ser/);
  mode = 'empty'; result = await cli(['vazio']);
  assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /resposta vazia/); mode = 'ok';

  await app.refreshModels();
  assert.equal(app.modelSource, 'live /v1/models');
  assert.deepEqual(app.models, ['glm-4.7', 'x-preview-l']);
  assert.equal(app.screen, 'landing');
  assert.equal(wordmark.length, 6);
  assert.deepEqual(reflection.map(stripAnsi), wordmark.slice(-3).reverse());
  for (const [w, h] of [[80, 24], [120, 35], [180, 50]]) {
    const rendered = screen(w, h), lines = rendered.split('\n');
    assert.match(rendered, /Laizy CLI/);
    assert.match(rendered, /seu espaço para pensar/);
    assert.match(rendered, /Modelo/);
    assert.doesNotMatch(rendered, /PROJETO|SESSÃO|01 \/ Escrever|╱|terminal de trabalho/);
    const start = lines.findIndex(line => line.includes(wordmark[0]));
    assert.ok(start >= 0);
    for (const [i, row] of [...wordmark, ...reflection.map(stripAnsi)].entries()) {
      assert.equal(lines[start + i].trim(), row.trim());
      assert.ok(Math.abs(lines[start + i].indexOf(row) - Math.floor((w - 1 - width(row)) / 2)) <= 1);
    }
    assert.ok(lines.some(line => line.trim() === '┌' + '─'.repeat(70) + '┐'));
    assert.ok(app.render(w, h).join('').includes('\x1b[38;2;32;24;43m'));
  }
  for (const [w, h] of [[40, 12], [40, 24], [60, 16], [30, 8]]) {
    const rendered = screen(w, h);
    assert.ok(!rendered.includes('█'));
    if (w >= 40) assert.match(rendered, /LAIZY/);
  }
  app.key('/unknown'); await app.send(); assert.equal(app.screen, 'landing'); key('u', true);
  app.key('/model'); await app.send(); assert.equal(app.screen, 'landing'); assert.ok(app.picker); key('escape');
  key('tab'); assert.match(screen(), /não são logs do servidor/); key('tab');
  key('f2'); await new Promise(resolve => setTimeout(resolve, 30));
  key('down'); key('return'); assert.equal(app.model, 'x-preview-l');
  app.key('helo'); key('left'); app.key('l'); assert.equal(app.input.join(''), 'hello');
  key('home'); key('delete'); app.key('H'); key('end'); app.key(' 世界');
  const first = app.send();
  assert.equal(app.screen, 'chat'); assert.equal(app.busy, true);
  assert.match(screen(), /Aguardando resposta/);
  await first;
  assert.equal(request.model, 'x-preview-l');
  assert.equal(request.stream, true);
  assert.deepEqual(request.tools?.map(t => t.function.name), ['run_command', 'write_file', 'read_file', 'delete_file', 'list_dir']);
  assert.equal(request.messages.at(-1).content, 'Hello 世界');
  assert.equal(app.messages.at(-1).reasoning, 'checking');
  assert.match(screen(), /Hello 世界/);
  assert.match(screen(), /Chat · Logs/);
  assert.doesNotMatch(screen(), /\d{2} ─|█|╱|PROJETO/);
  assert.match(screen(), /VOCÊ/);
  assert.ok(!app.render(80, 24).join('').includes('\x1b[2J'));
  assert.equal(safe('\x1b]52;c;secret\x07text\x9b2J\x00'), 'text');
  for (const [w, h] of [[60, 16], [80, 24], [120, 35], [180, 50], [30, 8]]) screen(w, h);
  app.key('界'.repeat(100)); key('left'); screen(60, 16); key('u', true);
  key('o', true); assert.ok(app.picker); assert.match(screen(), /Selecionar modelo/); key('escape');
  key('l', true); assert.equal(app.screen, 'landing'); assert.equal(app.messages.length, 0); assert.match(screen(), /seu espaço para pensar/);
  mode = 'truncated'; app.key('next'); await app.send(); assert.match(app.status, /antes do fim da resposta/);
  app.key('/new'); await app.send(); assert.equal(app.screen, 'landing');
  mode = 'error'; app.key('next'); await app.send(); assert.match(app.status, /mock failure/); assert.equal(app.screen, 'chat');
  key('tab'); key('e'); assert.match(screen(), /mock failure/); key('c'); assert.equal(app.logs.length, 0); key('tab');
  key('l', true);
  mode = 'hang'; app.key('cancel'); const pending = app.send();
  assert.equal(app.screen, 'chat'); key('l', true); assert.equal(app.screen, 'chat');
  setTimeout(() => key('escape'), 30); await pending; assert.match(app.status, /Cancelado/);
  mode = 'offline'; await app.refreshModels(); assert.match(app.modelSource, /fallback/);
  for (let i = 0; i < 350; i++) app.log('info', 'entry'); assert.equal(app.logs.length, 300);
  assert.equal(key('c', true), 'exit');
  mode = 'ok';
  const script = String.raw`
import os, pty, subprocess, select, time, fcntl, termios, struct, sys
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
def resize(w,h):
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', h,w,0,0))
resize(80,24)
p = subprocess.Popen(['node',sys.argv[1]], stdin=slave, stdout=slave, stderr=slave, env=os.environ)
data = b''
def until(needle):
    global data
    deadline = time.time()+8
    while needle not in data and time.time()<deadline:
        if select.select([master],[],[],0.1)[0]:
            data += os.read(master,65536)
    assert needle in data, (needle,data[-3000:])
try:
    until('seu espaço para pensar'.encode())
    os.write(master,b'\t')
    until('não são logs do servidor'.encode())
    os.write(master,b'\t\x1bOQ')
    until(b'Selecionar modelo')
    time.sleep(0.2)
    os.write(master,b'\x1b[B\rhello\r')
    until('Concluído em'.encode())
    data = b''
    os.write(master,b'\x0f')
    until(b'Selecionar modelo')
    os.write(master,b'\x1b')
    time.sleep(0.7)
    data = b''
    os.write(master,b'\x0c')
    until('seu espaço para pensar'.encode())
    resize(120,35)
    p.send_signal(28)
    time.sleep(0.1)
    resize(30,8)
    p.send_signal(28)
    until(b'Terminal pequeno')
    resize(80,24)
    p.send_signal(28)
    os.write(master,b'\x03')
    p.wait(timeout=5)
    until(b'\x1b[?1049l')
    assert p.returncode == 0
    assert termios.tcgetattr(slave) == original
finally:
    if p.poll() is None: p.kill(); p.wait()
    os.close(master); os.close(slave)
`;
  const child = spawn('python3', ['-c', script, fileURLToPath(new URL('../cli/app.mjs', import.meta.url))], {
    env: { ...process.env, OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: 'offline-test', LZ_NO_BOOTSTRAP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.equal(code, 0, output);
  console.log('PASS: render, tabs, editing, models/fallback, SSE, errors/cancel, bounds, ANSI safety, PTY resize/cleanup');
} finally {
  app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
