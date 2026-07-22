@echo off
title Sentry Batch
cd /d "%~dp0"

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js is required. Download from https://nodejs.org
    start https://nodejs.org
    pause
    exit /b 1
)

echo Starting Sentry Batch...
start "" /min cmd /c "npx --yes http-server -p 8080"
timeout /t 5 /nobreak >nul
start "" "http://localhost:8080/"
exit
