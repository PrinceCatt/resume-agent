@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules call pnpm install
echo Building the UI...
call pnpm build >nul
if errorlevel 1 (echo Build failed & pause & exit /b 1)
start "" http://127.0.0.1:8791
node --disable-warning=ExperimentalWarning server/index.ts
pause
