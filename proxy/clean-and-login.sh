#!/usr/bin/env bash
# Mata processos que seguram o deepseek_profile e relanca o login visivel.
cd "$(dirname "$0")"
pkill -f "tsx src/index.ts" 2>/dev/null || true
pkill -f "chrome-headless-shell.*deepseek_profile" 2>/dev/null || true
pkill -f "ms-playwright.*deepseek_profile" 2>/dev/null || true
sleep 2
rm -f deepseek_profile/SingletonLock deepseek_profile/SingletonCookie deepseek_profile/SingletonSocket
echo "== processos restantes com profile =="
pgrep -af "deepseek_profile" | head -3 || echo "(nenhum)"
setsid nohup node node_modules/.bin/tsx src/login.ts > /tmp/dslogin.log 2>&1 < /dev/null & disown
sleep 12
echo "== log do login =="
cat /tmp/dslogin.log
echo "== browser visivel =="
pgrep -af "chrome-linux64/chrome" | head -1 | cut -c1-110
