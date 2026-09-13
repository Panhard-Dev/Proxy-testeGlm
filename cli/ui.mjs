/* Visual design adapted from qwenproxy-cli src/tui/{theme,screen,app}.ts
 * and views/{chat-view,logs-view}.ts (ISC).
 * Copyright (c) 2026 johngbl
 * Copyright (c) 2026 Pedro Farias
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
import { stripVTControlCharacters } from 'node:util';

// External text never supplies terminal controls, including incomplete escapes.
export const safe = value => stripVTControlCharacters(String(value ?? ''))
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
  .replace(/\t/g, '  ');
export const stripAnsi = stripVTControlCharacters;
// Foreground spans preserve their surrounding surface; surfaces restore the canvas.
const foreground = '\x1b[38;2;225;205;241m';
export const background = '\x1b[48;2;12;12;16m';
const color = rgb => text => `\x1b[38;2;${rgb}m${text}${foreground}`;
export const theme = {
  violet: color('165;124;204'), pink: color('239;153;205'), lilac: color('225;205;241'),
  red: color('219;135;159'),
  muted: color('161;135;175'), border: color('85;57;104'),
  canvas: text => `${background}${foreground}${text}\x1b[0m`,
  selected: text => `\x1b[48;2;67;37;73m${color('239;153;205')(text)}${background}`,
  inverse: text => `\x1b[7m${text}\x1b[27m`,
};
export const wordmark = [
  '██      ██████  ██████ ████████ ██    ██',
  '██      ██  ██    ██        ██  ██  ██ ',
  '██      ██████    ██      ██     ████  ',
  '██      ██  ██    ██    ██        ██   ',
  '██      ██  ██    ██   ██         ██   ',
  '██████  ██  ██  ██████ ████████   ██   ',
];
// Reflect the lower edge, not a second word; three rows fade into the canvas.
export const reflection = wordmark.slice(-3).reverse().map((line, i) =>
  color(['111;73;139', '66;43;86', '32;24;43'][i])(line));
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const chars = text => [...segmenter.segment(text)].map(s => s.segment);
// ponytail: common terminal Unicode widths; ambiguous-width glyphs assume one cell.
const cellWidth = ch => {
  if (/^[\p{Mark}\p{Cf}]+$/u.test(ch)) return 0;
  const n = ch.codePointAt(0);
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(ch) ||
    (n >= 0x1100 && n <= 0x115f) || (n >= 0x2e80 && n <= 0xa4cf) ||
    (n >= 0xac00 && n <= 0xd7a3) || (n >= 0xf900 && n <= 0xfaff) ||
    (n >= 0xfe10 && n <= 0xfe6f) || (n >= 0xff01 && n <= 0xff60) ||
    (n >= 0xffe0 && n <= 0xffe6) || (n >= 0x20000 && n <= 0x3fffd) ? 2 : 1;
};
export const width = text => chars(stripAnsi(text)).reduce((n, ch) => n + cellWidth(ch), 0);
export function fit(text, size) {
  if (width(text) <= size) return text + ' '.repeat(Math.max(0, size - width(text)));
  let out = '', used = 0;
  for (const ch of chars(stripAnsi(text))) {
    if (used + cellWidth(ch) > size) break;
    out += ch; used += cellWidth(ch);
  }
  return out + ' '.repeat(Math.max(0, size - used));
}
export function wrap(text, size) {
  const lines = [];
  for (const line of safe(text).split('\n')) {
    let out = '', used = 0;
    for (const ch of chars(line)) {
      const w = cellWidth(ch);
      if (used + w > size) { lines.push(out); out = ''; used = 0; }
      out += ch; used += w;
    }
    lines.push(out);
  }
  return lines;
}
export function box(title, content, w, h, active = false) {
  const border = active ? theme.violet : theme.border;
  const label = fit(` ${safe(title)} `, w - 4).trimEnd();
  return [border('╭─') + theme.lilac(label) + border('─'.repeat(Math.max(0, w - 3 - width(label))) + '╮'),
    ...Array.from({ length: h - 2 }, (_, i) => border('│') + fit(content[i] || '', w - 2) + border('│')),
    border('╰' + '─'.repeat(w - 2) + '╯')];
}
// Animated spinner frames (braille); time-based so any render loop picks the
// right frame without shared state.
export const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const spinnerFrame = (t = Date.now(), fps = 9) => spinnerFrames[Math.floor(t / (1000 / fps)) % spinnerFrames.length];
// OpenCode-style block: plain rounded top, footer (model · time) inline on the
// bottom border, optional title inline on the top border. Content lines arrive
// pre-painted; each is padded to exactly (w - 4) between "│ " and " │".
export function block(lines, { title = '', footer = '', w = 80, accent = theme.lilac } = {}) {
  const inner = Math.max(8, w - 2);
  let top;
  if (title) {
    const label = ` ${safe(title)} `;
    top = theme.border('╭─') + accent(label) +
      theme.border('─'.repeat(Math.max(0, w - 3 - width(label))) + '╮');
  } else {
    top = theme.border('╭' + '─'.repeat(inner) + '╮');
  }
  const body = lines.map(l => theme.border('│ ') + fit(l, inner - 2) + theme.border(' │'));
  let bottom;
  if (footer) {
    const foot = ` ${safe(footer)} `;
    bottom = theme.border('╰─') + theme.muted(foot) +
      theme.border('─'.repeat(Math.max(0, w - 3 - width(foot))) + '╯');
  } else {
    bottom = theme.border('╰' + '─'.repeat(inner) + '╯');
  }
  return [top, ...body, bottom];
}
// Red error block with optional hint lines (muted, "·" bullets).
export function errorBlock(message, hints = [], w = 80) {
  const inner = Math.max(8, w - 2);
  const lines = wrap(message, inner - 4).map(l => theme.red(l));
  if (hints.length) {
    lines.push('');
    for (const h of hints) {
      const wrapped = wrap(safe(h), inner - 6);
      wrapped.forEach((l, i) => lines.push(theme.muted(i === 0 ? '· ' : '  ') + l));
    }
  }
  return block(lines, { title: 'Erro', w, accent: theme.red });
}
export function errorSummary(error) {
  const text = safe(error);
  if (/^Cancelado/.test(text)) return 'Cancelado · resposta parcial mantida.';
  if (/captcha/i.test(text)) return 'Verificação de segurança pendente. Tente novamente; detalhes em Logs.';
  return 'Não foi possível concluir a resposta. Tente novamente; detalhes em Logs.';
}
const bold = s => `\x1b[1m${s}\x1b[22m`;

function renderTable(rows, w) {
  const parse = r => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const header = parse(rows[0]);
  const body = rows.slice(2).map(parse); // rows[1] é o separador |---|
  const cols = Math.max(1, header.length);
  const avail = Math.max(12, w - 4 - cols * 3);
  const natural = header.map((h, ci) => Math.max(h.length, ...body.map(r => (r[ci] || '').length)));
  const widths = natural.map(n => Math.min(n, Math.max(5, Math.floor(avail / cols))));
  const cell = (c, ci, head) => {
    const txt = fit(head ? bold(c) : c, widths[ci]);
    return theme.border('│') + ' ' + txt + ' '.repeat(Math.max(0, widths[ci] - width(c))) + ' ';
  };
  const line = (cells, head) => cells.map((c, ci) => cell(c, ci, head)).join('') + theme.border('│');
  const sep = theme.border('├' + widths.map(n => '─'.repeat(n + 2)).join('┼') + '┤');
  return [
    line(header, true),
    sep,
    ...body.map(r => line(header.map((_, ci) => r[ci] || ''), false)),
  ];
}

export function markdown(text, w) {
  let code = false;
  // destaque inline: `código` em lilás e **negrito** em bold, aplicado antes
  // do wrap (width() ignora ANSI, então a quebra de linha continua correta).
  const inline = s => s
    .replace(/`([^`]+)`/g, (_, c) => theme.lilac(c))
    .replace(/\*\*([^*]+)\*\*/g, (_, b) => bold(b));
  const lines = safe(text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { code = !code; out.push(theme.muted(fit(line, w))); continue; }
    if (code) { out.push(theme.lilac(fit(line, w))); continue; }
    // bloco de tabela markdown: linha com | seguida de separador |---|
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const rows = [];
      let j = i;
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) { rows.push(lines[j]); j++; }
      i = j - 1;
      out.push(...renderTable(rows, w));
      continue;
    }
    const paint = /^#{1,6} /.test(line) ? theme.violet : s => s;
    out.push(...wrap(inline(line), w).map(paint));
  }
  return out;
}
