@echo off
rem Double-click to open Quant Terminal. It starts in the background (or reuses the copy that's
rem already running), opens your browser at http://localhost:3777, and this window closes.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed or isn't on the PATH. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
node scripts\launch.js
if errorlevel 1 pause
