#!/bin/bash
# Runs TRENDBOT in the BACKGROUND (keeps trading after you close this window / the browser). macOS.
cd "$(dirname "$0")"
# stop any OLD copy still running (it would keep serving the old page on port 8787)
pkill -f "node bot.js" 2>/dev/null; rm -f bot.pid; sleep 1
command -v node >/dev/null 2>&1 || { echo "Install Node.js LTS from https://nodejs.org first."; read -n1 -p "Press any key"; exit 1; }
[ -d node_modules ] || npm install --silent
if [ -f bot.pid ] && kill -0 "$(cat bot.pid)" 2>/dev/null; then echo "Already running (pid $(cat bot.pid)). Use STOP-TRENDBOT.command to stop."; open http://127.0.0.1:8787; read -n1 -p "Press any key"; exit 0; fi
echo "LIVE MAINNET: real funds. The seed is passed to the background process in memory only (never written to disk)."
read -s -p "Family seed (empty = paper mode): " SEED; echo
[ -n "$SEED" ] && export BOT_SEED="$SEED"
# caffeinate keeps the Mac awake while the bot runs; the supervisor loop restarts the bot if it crashes
nohup bash -c 'while true; do caffeinate -i node bot.js >> bot.log 2>&1; echo "bot exited, restarting in 5s" >> bot.log; sleep 5; done' >/dev/null 2>&1 &
echo $! > bot.pid
unset SEED BOT_SEED
sleep 3; open http://127.0.0.1:8787
echo "Running in background. Log: bot.log · stop with STOP-TRENDBOT.command"
read -n1 -p "Press any key to close this window (the bot keeps running)"
