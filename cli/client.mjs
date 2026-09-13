// Cliente HTTP para qualquer endpoint OpenAI-compatible (chat + models, SSE).
export class OpenAIClient {
  constructor({ baseUrl = 'http://localhost:3001/v1', apiKey = '', model = 'glm-4.7', timeoutMs = 300_000 } = {}) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('URL base inválida: use http/https, sem usuário/senha, query ou fragmento');
    this.baseUrl = url.href.replace(/\/+$/, '').replace(/(?:\/v1)?$/, '/v1');
    this.apiKey = apiKey;
    if (typeof model !== 'string' || model.length > 200 || !/^[\w./:-]+$/.test(model)) throw new Error('ID de modelo inválido: até 200 caracteres entre letras, números, ponto, barra, dois-pontos, hífen e sublinhado');
    this.model = model;
    this.timeoutMs = timeoutMs;
  }
  async models(signal) {
    const res = await this._fetch('/models', { signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]) });
    if (!res.ok) throw new Error(`GET /models: HTTP ${res.status}`);
    const j = await res.json();
    if (!Array.isArray(j.data)) throw new Error('Resposta inválida de /models');
    return [...new Set(j.data.map(m => m?.id).filter(id => typeof id === 'string' && id.length <= 200 && /^[\w./:-]+$/.test(id)))].slice(0, 200);
  }
  async *stream({ messages, model = this.model, signal, tools, toolChoice } = {}) {
    const body = { model, messages, stream: true };
    if (tools) body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
    const res = await this._fetch('/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]),
    });
    if (!res.ok) { await res.body?.cancel(); throw new Error(`POST /chat/completions: HTTP ${res.status}`); }
    if (!res.headers.get('content-type')?.includes('text/event-stream')) { await res.body?.cancel(); throw new Error('O servidor não respondeu um stream SSE (text/event-stream)'); }
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let buffer = '', data = [], finished = false;
    function parse() {
      const text = data.join('\n'); data = [];
      if (!text) return [];
      if (text === '[DONE]') { finished = true; return []; }
      let j;
      try { j = JSON.parse(text); } catch { throw new Error('JSON malformado no stream SSE'); }
      if (j.error) throw new Error(String(j.error.message || 'Erro de stream retornado pelo servidor').slice(0, 500));
      const ch = j.choices?.[0], events = [];
      if (typeof ch?.delta?.reasoning_content === 'string') events.push({ reasoning: ch.delta.reasoning_content });
      if (typeof ch?.delta?.content === 'string') events.push({ delta: ch.delta.content });
      if (Array.isArray(ch?.delta?.tool_calls)) events.push({ toolCalls: ch.delta.tool_calls });
      if (j.usage) events.push({ usage: j.usage });
      if (ch?.finish_reason) { events.push({ finishReason: ch.finish_reason }); finished = true; }
      return events;
    }
    try {
      for (;;) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        if (buffer.length + data.join('').length > 1_048_576) throw new Error('Evento SSE excede 1 MiB');
        if (done) buffer += '\n\n';
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, ''); buffer = buffer.slice(nl + 1);
          if (!line) {
            yield* parse();
            if (finished) { yield { done: true }; return; }
          } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (done) throw new Error('A conexão terminou antes do fim da resposta');
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  _fetch(path, opts = {}) {
    const headers = new Headers(opts.headers);
    if (this.apiKey) headers.set('Authorization', `Bearer ${this.apiKey}`);
    return fetch(this.baseUrl + path, { ...opts, headers, redirect: 'error' });
  }
}
