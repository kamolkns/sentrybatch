@echo off
setlocal
title Sentry Batch Launcher

:: ===================================================================
::  Sentry Batch Launcher
::  Requires: Python 3.10+, Windows
:: ===================================================================

:: ------------- Project directory check -------------
if not exist "%~dp0launcher.html" (
    echo.
    echo -----------------------------------------------
    echo ERROR: Could not find the Sentry Batch files.
    echo -----------------------------------------------
    echo.
    echo Make sure you run this file from inside the
    echo Sentry Batch project folder.
    echo.
    pause
    exit /b 1
)
cd /d "%~dp0"

echo.
echo -----------------------------------------------
echo  Starting Sentry Batch...
echo -----------------------------------------------
echo.

:: ------------- Python check (python or py) -------------
echo Checking Python...

set "PYTHON_CMD="
python -c "import sys; exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if %errorlevel% equ 0 set "PYTHON_CMD=python"

if not defined PYTHON_CMD (
    py -c "import sys; exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
    if %errorlevel% equ 0 set "PYTHON_CMD=py"
)

if not defined PYTHON_CMD (
    echo.
    echo -----------------------------------------------
    echo  Python 3.10 or newer is required.
    echo -----------------------------------------------
    echo.
    echo Sentry Batch needs Python to run its local
    echo web server.
    echo.
    echo The official download page will open now.
    echo During installation, make sure to enable:
    echo.
    echo     Add Python to PATH
    echo.
    echo After installing, close this window and
    echo run Open Sentry Batch.bat again.
    echo.
    start "" "https://www.python.org/downloads/"
    pause
    exit /b 1
)

echo  Python found: %PYTHON_CMD%

:: ------------- Check if server is already running -------------
echo Checking server...

powershell -NoProfile -Command "try { $c = [System.Net.Sockets.TcpClient]::new(); $ar = $c.BeginConnect('127.0.0.1', 8080, $null, $null); if ($ar.AsyncWaitHandle.WaitOne(300)) { $c.EndConnect($ar); $c.Dispose(); exit 2 }; $c.Dispose(); exit 0 } catch { exit 0 }"

if %errorlevel% equ 2 (
    :: Port 8080 is open — check if it is our server
    powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:8080/launcher.html' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 }; exit 1 } catch { exit 1 }"
    if %errorlevel% equ 0 (
        echo  Server already running.
        goto :open_browser
    )
    echo.
    echo -----------------------------------------------
    echo  Port 8080 is in use by another program.
    echo -----------------------------------------------
    echo.
    echo Close the other program and try again.
    echo.
    echo If you need to use a different port, edit
    echo Open Sentry Batch.bat and change "8080" to
    echo your preferred port number.
    echo.
    pause
    exit /b 1
)

:: ------------- Start local web server -------------
echo Starting local server...

start "Sentry Batch local server" /min cmd /c "%PYTHON_CMD% -m http.server 8080"

:: ------------- Wait for server to accept connections -------------
echo Waiting for server...

powershell -NoProfile -Command "$url = 'http://localhost:8080/'; $deadline = [datetime]::Now.AddSeconds(15); while ([datetime]::Now -lt $deadline) { try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; Start-Sleep -Milliseconds 500 }; exit 1"

if %errorlevel% neq 0 (
    echo.
    echo -----------------------------------------------
    echo  Could not start the local web server.
    echo -----------------------------------------------
    echo.
    echo Possible causes:
    echo.
    echo   - Port 8080 may be in use
    echo   - Python was not found or is not working
    echo   - A firewall is blocking localhost
    echo.
    echo Make sure Python is installed and port 8080
    echo is free, then try again.
    echo.
    pause
    exit /b 1
)

:: ------------- Open browser -------------
:open_browser
echo Opening browser...
start "" "http://localhost:8080/launcher.html"
echo  Ready.
echo.
endlocal
