// Histórico persistido do Laizy: cada conversa fica salva em
// ~/.laizy/history.json (JSON é usado no lugar de SQLite porque o projeto não
// tem toolchain C para módulos nativos — e o resultado prático é o mesmo).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FILE = path.join(os.homedir(), '.laizy', 'history.json');
const MAX_SESSIONS = 100;

export function loadHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(j.sessions) ? j.sessions : [];
  } catch { return []; }
}

function persist(sessions) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ sessions: sessions.slice(0, MAX_SESSIONS) }, null, 2));
}

/** Cria ou atualiza uma sessão de conversa. Retorna o id. */
export function saveSession(id, { title, model, messages, agent }) {
  const sessions = loadHistory();
  let s = sessions.find(x => x.id === id);
  const now = Date.now();
  if (!s) {
    s = { id: id || now.toString(36), created: now };
    sessions.unshift(s);
  }
  s.title = (title || 'conversa').slice(0, 80);
  s.model = model;
  s.updated = now;
  s.messages = messages.slice(-200);
  s.agent = agent.slice(-200);
  persist(sessions);
  return s.id;
}

export function deleteSession(id) {
  let sessions = loadHistory();
  sessions = sessions.filter(s => s.id !== id);
  persist(sessions);
}

export function newSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
