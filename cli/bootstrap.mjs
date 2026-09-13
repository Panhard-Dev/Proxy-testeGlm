// Bootstrap da CLI: confere que o backend OpenAI-compatible configurado está
// no ar antes da interface abrir. Chamado por cli/app.mjs nos modos TUI e
// não-interativo.
//
// Toda saída vai para STDERR — em modo pipe (`lz "prompt"`) o stdout é a
// resposta do modelo e não pode ser poluído.
//
// Comportamento:
//   1. Base URL remota (não localhost) → não interfere, o host é do usuário.
//   2. Host local parado → avisa e segue; a CLI reporta o próprio erro de
//      conexão com as dicas de configuração.
// Desliga a checagem com LZ_NO_BOOTSTRAP=1.

const WAIT_MS = 5_000;

const say = (msg) => process.stderr.write(`[lz] ${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isLocal(hostname) {
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(hostname);
}

async function healthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    // 401 ainda significa "tem um servidor HTTP vivo ali" (só pede auth).
    return res.ok || res.status === 401;
  } catch { return false; }
}

export async function bootstrap(baseUrl) {
  if (process.env.LZ_NO_BOOTSTRAP === '1') return;

  let url;
  try { url = new URL(baseUrl); }
  catch { return; }
  if (!isLocal(url.hostname)) return; // host remoto: usuário gerencia
  const port = parseInt(url.port || '3001', 10) || 3001;

  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (await healthy(port)) return;
    await sleep(500);
  }
  say(`nenhum backend respondendo em http://127.0.0.1:${port} — use -b/--base-url ou OPENAI_BASE_URL`);
}
