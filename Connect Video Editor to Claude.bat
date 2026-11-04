@echo off
rem Adds the Video Editor to the Claude desktop app, with a backup of its settings file first.
cd /d "%~dp0"
where node >/dev/null 2>nul
if errorlevel 1 (
  echo Node.js is not installed, so this cannot run. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
node mcp\install-claude.mjs
pause
