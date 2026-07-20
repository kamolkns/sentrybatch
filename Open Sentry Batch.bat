@echo off
setlocal

title Sentry Batch Launcher

:: Check that Python 3.10+ is installed and available
python -c "import sys; exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo --------------------------------------------------
  echo.
  echo Python 3.10 or newer is required.
  echo.
  echo The official download page has been opened.
  echo.
  echo During installation, enable:
  echo.
  echo     Add Python to PATH
  echo.
  echo After installation completes, close this window and run:
  echo.
  echo     Open Sentry Batch.bat
  echo.
  echo again.
  echo.
  echo --------------------------------------------------
  echo.
  start "" "https://www.python.org/downloads/"
  pause
  exit /b 1
)

echo Starting local server...

:: Check if port 8080 is already in use by another application
powershell -NoProfile -Command ^
  try { ^
    $c = [System.Net.Sockets.TcpClient]::new(); ^
    $ar = $c.BeginConnect('127.0.0.1', 8080, $null, $null); ^
    if ($ar.AsyncWaitHandle.WaitOne(300)) { ^
      $c.EndConnect($ar); $c.Dispose(); exit 2 ^
    } ^
    $c.Dispose(); exit 0 ^
  } catch { exit 0 }

if %errorlevel% equ 2 (
  echo.
  echo ERROR: Port 8080 is already in use.
  echo Close the other application and try again.
  echo.
  pause
  exit /b 1
)

:: Start Python HTTP server in a minimized window
start "Sentry Batch local server" /min cmd /c "python -m http.server 8080"

:: Poll for server readiness (up to 15 seconds)
echo Please wait...

powershell -NoProfile -Command ^
  $url = 'http://localhost:8080/'; ^
  $deadline = [datetime]::Now.AddSeconds(15); ^
  while ([datetime]::Now -lt $deadline) { ^
    try { ^
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2; ^
      if ($r.StatusCode -eq 200) { exit 0 } ^
    } catch {}; ^
    Start-Sleep -Milliseconds 500; ^
  }; ^
  exit 1

set "exit_code=%errorlevel%"
if %exit_code% equ 0 (
  echo Server is ready. Opening application...
  start "" "http://localhost:8080/launcher.html"
) else (
  echo.
  echo ERROR: Could not connect to the local HTTP server within 15 seconds.
  echo.
  echo Possible causes:
  echo   - Python is not installed or not in PATH
  echo   - Port 8080 is already in use by another program
  echo   - A firewall is blocking localhost connections
  echo.
  echo Verify Python is installed and port 8080 is free, then try again.
  echo.
  pause
)

endlocal
