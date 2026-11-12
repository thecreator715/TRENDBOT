#!/bin/bash
cd "$(dirname "$0")"
touch STOP   # the bot sees this and closes its position + cancels its orders on its next tick
echo "Asked the bot to flatten and halt (STOP file). Waiting 15s for it to close out..."
sleep 15
if [ -f bot.pid ]; then kill "$(cat bot.pid)" 2>/dev/null; pkill -f "node bot.js" 2>/dev/null; rm -f bot.pid; fi
rm -f STOP
echo "Stopped."; read -n1 -p "Press any key"
