@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 20.12 or newer is required. Install Node.js, then double-click this file again.
  pause
  exit /b 1
)

node scripts\launch-editor.mjs
set "STATUS=%ERRORLEVEL%"
if not "%STATUS%"=="0" pause
exit /b %STATUS%
