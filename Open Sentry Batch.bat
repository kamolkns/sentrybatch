@echo off
setlocal

start "Sentry Batch local server" /min cmd /c "python -m http.server 8080"
timeout /t 1 /nobreak >nul
start "" "http://localhost:8080/v1.html"

endlocal
