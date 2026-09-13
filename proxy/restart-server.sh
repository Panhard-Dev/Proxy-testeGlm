#!/usr/bin/env bash
# Reinicia o servidor deepsproxy limpando processos antigos (usa a PORT do .env).
cd "$(dirname "$0")"
PORT="3000"
if [ -f .env ]; then
  PORT=$(grep -E "^PORT=" .env | head -1 | cut -d= -f2)
fi
PORT="${PORT:-3000}"
fuser -k "${PORT}/tcp" 2>/dev/null || true
sleep 2
rm -f deepseek_profile/SingletonLock deepseek_profile/SingletonCookie deepseek_profile/SingletonSocket
setsid nohup node node_modules/.bin/tsx src/index.ts > "/tmp/dsserver-${PORT}.log" 2>&1 < /dev/null & disown
sleep 8
tail -2 "/tmp/dsserver-${PORT}.log"
