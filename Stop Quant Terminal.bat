@echo off
rem Double-click to stop Quant Terminal.
cd /d "%~dp0"
node scripts\stop.js
timeout /t 3 >nul
