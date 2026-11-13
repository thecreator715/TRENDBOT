@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Install Node.js LTS from https://nodejs.org first & pause & exit /b 1)
if not exist node_modules call npm install --silent
set /p BOT_SEED=Family seed (optional, visible; empty = paper mode): 
start "" http://127.0.0.1:8787
node bot.js
pause
