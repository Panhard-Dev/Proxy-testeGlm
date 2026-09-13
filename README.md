# Laizy CLI

Cliente de terminal para qualquer endpoint **OpenAI-compatible** — interface TUI
completa e modo não-interativo para scripts/pipes.

Não inclui servidor, proxy ou coletor: aponte a CLI para um backend que já fale
o protocolo OpenAI (`/v1/models`, `/v1/chat/completions` com SSE).

## Requisitos

- Node.js >= 22.5 (usa `AbortSignal.any` e `fetch` nativo)
- Sem dependências de runtime

## Instalação

```bash
npm install -g .        # expõe lz, lzcli e laizy-cli
# ou rode sem instalar:
node cli/app.mjs --help
```

## Uso

```bash
lz                              # TUI interativa (precisa de terminal)
lz "explique este erro"         # não-interativo
echo "resuma isso" | lz         # prompt via stdin
lz -m glm-4.7 -b http://localhost:8000/v1 -k minha-chave "oi"
```

### Opções

| Flag | Descrição |
|---|---|
| `-m, --model <id>` | ID do modelo (padrão: `glm-4.7`) |
| `-b, --base-url <url>` | URL base OpenAI-compatible |
| `-k, --api-key <chave>` | API key (Bearer) |
| `--tools <json\|@arquivo>` | Tools no formato OpenAI |
| `--tool-choice <valor>` | `auto` \| `none` \| `required` \| objeto JSON |
| `--no-bootstrap` | Não checa o backend antes de abrir |
| `-h, --help` / `--version` | Ajuda / versão |

### Variáveis de ambiente

`OPENAI_BASE_URL` · `OPENAI_API_KEY` (ou `API_KEY`) · `OPENAI_MODEL` ·
`LZ_NO_BOOTSTRAP=1`

Flags de linha de comando têm precedência sobre as variáveis.

### TUI

| Tecla | Ação |
|---|---|
| `F2` / `Ctrl+O` | Trocar modelo |
| `Tab` | Alternar Chat / Logs |
| `Esc` | Cancelar resposta em andamento |
| `Ctrl+L` | Nova conversa |
| `Ctrl+U` | Limpar entrada |
| `Ctrl+C` | Sair |

Comandos: `/model` · `/new` · `/quit`

### Códigos de saída

`0` sucesso · `1` erro · `2` resposta vazia · `130` interrompido

## Testes

```bash
npm test        # offline, com backend mockado (PTY usa Python 3 no Linux)
```

## Estrutura

```
cli/
├── app.mjs        # TUI + modo não-interativo, parsing de flags
├── client.mjs     # OpenAIClient: /models + /chat/completions (SSE)
├── bootstrap.mjs  # checagem de saúde do backend antes de abrir
└── ui.mjs         # tema, layout, markdown, spinner
test/
└── cli.test.mjs   # suíte offline (mock HTTP + PTY)
```
