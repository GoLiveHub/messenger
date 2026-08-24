@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 22.13 or newer is required.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :failed
)

echo Building Messenger...
call npm run build
if errorlevel 1 goto :failed

node scripts\init-env.mjs
if errorlevel 1 goto :failed

echo Starting Messenger. Open http://messenger.local/ or http://127.0.0.1/
echo If port 80 is busy, stop the program using it or change PORT in .env.
node --env-file=.env dist-server\index.js
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo Messenger failed to start. Read the error above.
pause
exit /b 1
