// Ferramentas embutidas do Laizy: execução real na máquina do usuário.
// O modelo pede (tool_calls OpenAI), a CLI executa localmente e devolve o
// resultado na conversa. cwd = onde o lz foi chamado.
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const AGENT_SYSTEM = [
  'Você é o Laizy, um agente que age direto no terminal do usuário.',
  'Você TEM ferramentas: use-as para executar comandos, ler, criar e editar arquivos — nunca peça para o usuário rodar algo ou colar saídas.',
  'Prefira várias chamadas curtas; confira o resultado de cada ação antes de responder.',
  'Ao terminar, responda de forma curta dizendo o que foi feito.',
  'Destaque o que importa na resposta: use **negrito** em caminhos, nomes de arquivos, números e conclusões — nunca deixe informação importante em texto plano.',
].join(' ');

export const BUILTIN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Executa um comando bash no terminal do usuário (cwd atual). Use para ls, cat, grep, git, npm etc. Retorna stdout/stderr.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Comando bash a executar' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Cria ou sobrescreve um arquivo com o conteúdo dado (cria pastas se necessário).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Caminho do arquivo' },
          content: { type: 'string', description: 'Conteúdo completo do arquivo' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Lê um arquivo de texto (até 32 KB).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Caminho do arquivo' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Deleta um arquivo. Use com cautela e só quando o usuário pedir.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Caminho do arquivo a deletar' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'Lista o conteúdo de uma pasta (arquivos e subpastas).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Caminho da pasta (default: atual)' } },
        required: [],
      },
    },
  },
];

const MAX_OUTPUT = 8_000;

function clip(text) {
  if (text.length <= MAX_OUTPUT) return text;
  return text.slice(0, MAX_OUTPUT / 2) + `\n[... truncado, ${text.length - MAX_OUTPUT} caracteres ...]\n` + text.slice(-MAX_OUTPUT / 4);
}

function resolveSafe(p, cwd) {
  return path.resolve(cwd, p);
}

export async function executeTool(name, argsJson, { cwd, signal } = {}) {
  let args = {};
  try { args = JSON.parse(argsJson || '{}'); } catch { return { ok: false, text: 'Argumentos JSON inválidos.', summary: 'JSON inválido' }; }

  try {
    if (name === 'run_command') {
      const command = String(args.command || '');
      if (!command.trim()) return { ok: false, text: 'Comando vazio.', summary: 'comando vazio' };
      const text = await new Promise((resolve) => {
        exec(command, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, signal, shell: '/bin/bash' }, (err, stdout, stderr) => {
          const parts = [];
          if (stdout) parts.push(String(stdout));
          if (stderr) parts.push('[stderr] ' + String(stderr));
          if (err && err.killed) parts.push('[processo interrompido]');
          let out = clip(parts.join('\n').trimEnd()) || '(sem saída)';
          if (err && err.code !== undefined && err.code !== 0) out += `\n[exit code: ${err.code}]`;
          resolve(out);
        });
      });
      return { ok: true, kind: 'run', text, detail: `$ ${command}`, summary: `$ ${command}` };
    }

    if (name === 'write_file') {
      const file = resolveSafe(String(args.path || ''), cwd);
      const content = typeof args.content === 'string' ? args.content : '';
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const existed = fs.existsSync(file);
      fs.writeFileSync(file, content);
      const kb = (Buffer.byteLength(content) / 1024).toFixed(1);
      return { ok: true, kind: existed ? 'edit' : 'create', text: `${existed ? 'Arquivo atualizado' : 'Arquivo criado'}: ${file} (${kb} KB)`, detail: file, summary: `${existed ? 'editou' : 'criou'} ${path.basename(file)} (${kb} KB)` };
    }

    if (name === 'read_file') {
      const file = resolveSafe(String(args.path || ''), cwd);
      const text = clip(fs.readFileSync(file, 'utf8'));
      return { ok: true, kind: 'read', text, detail: file, summary: `leu ${path.basename(file)} (${text.length} chars)` };
    }

    if (name === 'list_dir') {
      const dir = resolveSafe(String(args.path || '.') || '.', cwd);
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .slice(0, 300)
        .map(e => e.isDirectory() ? e.name + '/' : e.name);
      return { ok: true, kind: 'list', text: `${dir}\n` + (entries.join('\n') || '(vazio)'), detail: dir, summary: `listou ${path.basename(dir)} (${entries.length} itens)` };
    }

    if (name === 'delete_file') {
      const file = resolveSafe(String(args.path || ''), cwd);
      const existed = fs.existsSync(file);
      fs.rmSync(file, { force: true });
      return { ok: true, kind: 'delete', text: existed ? `Arquivo deletado: ${file}` : `Arquivo não existia: ${file}`, detail: file, summary: `deletou ${path.basename(file)}` };
    }

    return { ok: false, text: `Ferramenta desconhecida: ${name}`, summary: `desconhecida: ${name}` };
  } catch (err) {
    const msg = err.code === 'ENOENT' ? 'não encontrado' : err.code === 'EACCES' ? 'permissão negada' : (err.message || String(err));
    return { ok: false, text: `Erro: ${msg}`, summary: `erro: ${msg}` };
  }
}
