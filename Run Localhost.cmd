@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the current LTS version from https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\.bin\tsx.cmd" (
  echo First launch: installing the lightweight localhost runtime...
  set PUPPETEER_SKIP_DOWNLOAD=true
  call npm install --omit=dev
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

set PUPPETEER_SKIP_DOWNLOAD=true
node scripts\start-localhost.mjs
if errorlevel 1 pause
