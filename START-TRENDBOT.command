#!/bin/bash
# Double-click to run TRENDBOT (macOS). Live XRPL mainnet trading when a seed is entered.
cd "$(dirname "$0")"
# stop any OLD copy still running (it would keep serving the old page on port 8787)
pkill -f "node bot.js" 2>/dev/null; rm -f bot.pid; sleep 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install it from https://nodejs.org (LTS), then double-click this again."; read -n1 -p "Press any key"; exit 1
fi
[ -d node_modules ] || { echo "Installing dependencies..."; npm install --silent || { echo "npm install failed"; read -n1; exit 1; }; }
echo "TRENDBOT: leave the seed empty for PAPER mode, or enter your family seed for LIVE MAINNET trading."
echo "Real funds are at risk. The seed is kept in memory only."
read -s -p "Family seed (hidden, optional): " SEED; echo
export BOT_SEED="$SEED"
[ -z "$SEED" ] && unset BOT_SEED
(sleep 3; open "http://127.0.0.1:8787") &
node bot.js
read -n1 -p "Stopped. Press any key to close."
