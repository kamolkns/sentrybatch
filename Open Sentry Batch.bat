@echo off
setlocal EnableDelayedExpansion

title Sentry Batch Launcher

rem =============================================================================
rem  Sentry Batch Launcher (Windows)
rem  https://github.com/kamolkns/sentrybatch
rem
rem  Serves the SPA over HTTP (required for ES modules + Service Worker) and
rem  opens it in the default browser. Every failure path prints a reason and
rem  pauses instead of silently closing the window.
rem =============================================================================

cd /d "%~dp0"

set "PORT=8080"
set "MAX_PORT_TRIES=10"
set "NO_BROWSER=0"
set "LOG_FILE="
set "TEMP_LOG=%TEMP%\sentrybatch_%RANDOM%.log"

rem -----------------------------------------------------------------------------
rem Parse arguments
rem -----------------------------------------------------------------------------
:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--port" (
    set "PORT=%~2"
    shift & shift
    goto parse_args
)
if /i "%~1"=="--log" (
    set "LOG_FILE=%~2"
    shift & shift
    goto parse_args
)
if /i "%~1"=="--no-browser" (
    set "NO_BROWSER=1"
    shift
    goto parse_args
)
if /i "%~1"=="--help" (
    echo Usage: start.bat [--port PORT] [--log FILE] [--no-browser]
    echo   --port PORT     HTTP server port ^(default 8080^)
    echo   --log FILE      Save server output to FILE for troubleshooting
    echo   --no-browser    Don't auto-open the browser
    exit /b 0
)
echo [x] Unknown argument: %~1
echo     Run "start.bat --help" for usage.
pause
exit /b 1
:args_done

rem Validate port is numeric and in range
echo %PORT%| findstr /r "^[0-9][0-9]*$" >nul
if errorlevel 1 (
    echo [x] Invalid port "%PORT%" - must be a number.
    pause
    exit /b 1
)
if %PORT% lss 1 (
    echo [x] Invalid port "%PORT%" - must be between 1 and 65535.
    pause
    exit /b 1
)
if %PORT% gtr 65535 (
    echo [x] Invalid port "%PORT%" - must be between 1 and 65535.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   Sentry Batch Launcher
echo ============================================================
echo.

rem -----------------------------------------------------------------------------
rem Step 0: confirm we're actually in the project folder
rem -----------------------------------------------------------------------------
if not exist "index.html" (
    echo [x] index.html not found in this folder:
    echo       %cd%
    echo [x] Move start.bat into the Sentry Batch project root and try again.
    echo.
    pause
    exit /b 1
)
echo [+] Project folder OK ^(%cd%^)
echo.

rem -----------------------------------------------------------------------------
rem Step 1: Node.js present and new enough?
rem -----------------------------------------------------------------------------
echo [1/5] Checking Node.js...

where node >nul 2>&1
if errorlevel 1 goto need_node

for /f "usebackq delims=" %%v in (`node --version 2^>nul`) do set "NODE_RAW=%%v"
if not defined NODE_RAW goto need_node

set "NODE_VER=%NODE_RAW:v=%"
for /f "tokens=1 delims=." %%m in ("%NODE_VER%") do set "NODE_MAJOR=%%m"

set "NODE_MAJOR_OK=1"
echo %NODE_MAJOR%| findstr /r "^[0-9][0-9]*$" >nul
if errorlevel 1 set "NODE_MAJOR_OK=0"

if "%NODE_MAJOR_OK%"=="0" (
    echo [!] Could not determine Node.js version from "%NODE_RAW%" - continuing anyway.
    goto node_ok
)
if %NODE_MAJOR% lss 18 (
    echo [!] Node.js %NODE_RAW% is older than the recommended v18+.
    echo [!] http-server should still work, but consider upgrading if you hit issues.
)

:node_ok
echo [+] Node.js %NODE_RAW% found
goto check_npm

:need_node
echo [!] Node.js not found. Attempting automatic installation...
echo.
call :install_node
if errorlevel 1 (
    echo.
    echo [x] Automatic installation failed.
    echo [x] Install Node.js manually from https://nodejs.org/ ^(LTS version^)
    echo [x] then run this script again.
    echo.
    pause
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo [x] Node.js was installed but is not yet visible on PATH in this window.
    echo [x] Close this window, open a NEW terminal, and run start.bat again.
    echo.
    pause
    exit /b 1
)
for /f "usebackq delims=" %%v in (`node --version 2^>nul`) do set "NODE_RAW=%%v"
echo [+] Node.js %NODE_RAW% installed successfully.

:check_npm
echo.
echo [2/5] Checking npm...
where npm >nul 2>&1
if errorlevel 1 (
    echo [x] npm not found even though Node.js is installed.
    echo [x] This usually means a broken Node.js install. Reinstall from https://nodejs.org/
    echo.
    pause
    exit /b 1
)
for /f "usebackq delims=" %%v in (`npm --version 2^>nul`) do set "NPM_VER=%%v"
echo [+] npm v%NPM_VER% found

rem -----------------------------------------------------------------------------
rem Step 3: port availability (best-effort; non-fatal if the check itself fails)
rem -----------------------------------------------------------------------------
echo.
echo [3/5] Checking port %PORT%...

set "CHOSEN_PORT="
for /l %%o in (0,1,%MAX_PORT_TRIES%) do (
    if not defined CHOSEN_PORT (
        set /a "TRY_PORT=%PORT%+%%o"
        call :port_is_free !TRY_PORT!
        if not errorlevel 1 (
            set "CHOSEN_PORT=!TRY_PORT!"
        )
    )
)

if not defined CHOSEN_PORT (
    echo [!] Could not confirm a free port after trying %PORT%-!TRY_PORT!.
    echo [!] Continuing with %PORT% anyway - http-server will report if it's busy.
    set "CHOSEN_PORT=%PORT%"
) else if not "!CHOSEN_PORT!"=="%PORT%" (
    echo [!] Port %PORT% is already in use.
    echo [+] Using port !CHOSEN_PORT! instead.
) else (
    echo [+] Port !CHOSEN_PORT! is available.
)
set "PORT=!CHOSEN_PORT!"
set "URL=http://localhost:%PORT%/"

rem -----------------------------------------------------------------------------
rem Step 4: open the browser after a short delay (detached, never blocks us)
rem -----------------------------------------------------------------------------
echo.
echo [4/5] Preparing browser launch...
if "%NO_BROWSER%"=="1" (
    echo [i] --no-browser set - skipping.
) else (
    start "" cmd /c "timeout /t 3 /nobreak >nul & start "" "%URL%""
    echo [+] Will open %URL% in ~3 seconds.
)

rem -----------------------------------------------------------------------------
rem Step 5: start the server IN THE FOREGROUND
rem   - Foreground means real errors print and STAY on screen.
rem   - Ctrl+C stops it cleanly (Windows will ask "Terminate batch job (Y/N)?"
rem     for the wrapping script - that's normal, answer Y).
rem   - Output is always mirrored to a temp log so we can diagnose failures,
rem     and copied to --log FILE afterward if you asked for one.
rem -----------------------------------------------------------------------------
echo.
echo [5/5] Starting HTTP server on port %PORT%...
echo       URL: %URL%
echo.
echo ------------------------------------------------------------
echo   Server output below. Press Ctrl+C to stop the server.
echo ------------------------------------------------------------
echo.

call npx --yes http-server -p %PORT% 2>&1 | powershell -NoProfile -Command "$input | Tee-Object -FilePath '%TEMP_LOG%'"
set "SERVER_EXIT=%errorlevel%"

echo.
echo ------------------------------------------------------------

if not "%LOG_FILE%"=="" (
    copy /y "%TEMP_LOG%" "%LOG_FILE%" >nul 2>&1
    echo [i] Server log saved to %LOG_FILE%
)

if "%SERVER_EXIT%"=="0" (
    echo [+] Server stopped normally.
    del "%TEMP_LOG%" 2>nul
    echo.
    pause
    exit /b 0
)

rem -----------------------------------------------------------------------------
rem Failure diagnostics: sniff the captured log for known error signatures
rem -----------------------------------------------------------------------------
echo [x] Server exited with an error ^(code %SERVER_EXIT%^).
echo.

findstr /c:"EADDRINUSE" "%TEMP_LOG%" >nul 2>&1
if not errorlevel 1 (
    echo [x] Port %PORT% was grabbed by something else at the last second.
    echo [x] Fix:  start.bat --port 8081
    goto diag_done
)

findstr /c:"ENOENT" "%TEMP_LOG%" >nul 2>&1
if not errorlevel 1 (
    echo [x] npm/npx could not find a required file or package.
    echo [x] Fix:  delete any local node_modules folder here and try again,
    echo [x]       or run:  npm cache clean --force
    goto diag_done
)

findstr /c:"ENOTFOUND" "%TEMP_LOG%" >nul 2>&1
if not errorlevel 1 (
    echo [x] Network lookup failed - npx couldn't reach the npm registry.
    echo [x] Fix: check your internet connection ^(needed the first time to
    echo [x]      download http-server^), or check a proxy/firewall isn't
    echo [x]      blocking registry.npmjs.org.
    goto diag_done
)

findstr /c:"EACCES" "%TEMP_LOG%" "%TEMP_LOG%" >nul 2>&1
if not errorlevel 1 (
    echo [x] Permission denied. Try running this terminal as Administrator,
    echo [x] or check antivirus isn't blocking node.exe / npx.
    goto diag_done
)

echo [x] Unrecognized error. Full server output was captured above
echo [x] and saved to: %TEMP_LOG%
echo [x] You can also try running this manually to see more detail:
echo [x]     npx --yes http-server -p %PORT%

:diag_done
echo.
pause
exit /b %SERVER_EXIT%

rem =============================================================================
rem  Subroutines
rem =============================================================================

rem --- :port_is_free <port>  -> errorlevel 0 if free, 1 if busy/unknown ---------
:port_is_free
setlocal
set "CHK_PORT=%~1"
powershell -NoProfile -Command ^
    "try { $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, %CHK_PORT%); $l.Start(); $l.Stop(); exit 0 } catch { exit 1 }" >nul 2>&1
set "RESULT=%errorlevel%"
endlocal & exit /b %RESULT%

rem --- :install_node -> tries winget, then Chocolatey, then direct MSI ----------
:install_node
where winget >nul 2>&1
if not errorlevel 1 (
    echo [*] Installing Node.js LTS via winget...
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
    if not errorlevel 1 (
        for /f "skip=2 tokens=2,*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYS_PATH=%%b"
        set "PATH=%ProgramFiles%\nodejs;!SYS_PATH!;%PATH%"
        exit /b 0
    )
    echo [!] winget install failed or was cancelled. Trying Chocolatey...
)

where choco >nul 2>&1
if not errorlevel 1 (
    echo [*] Installing Node.js LTS via Chocolatey...
    choco install nodejs-lts -y --no-progress
    if not errorlevel 1 (
        set "PATH=%ProgramData%\chocolatey\lib\nodejs-lts\tools;%PATH%"
        exit /b 0
    )
    echo [!] Chocolatey install failed. Trying direct download...
)

echo [*] Downloading Node.js LTS installer directly from nodejs.org...
set "NODE_INDEX_URL=https://nodejs.org/dist/latest-v22.x/"
set "TEMP_MSI=%TEMP%\node-install.msi"

powershell -NoProfile -Command ^
    "$ErrorActionPreference='Stop';" ^
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;" ^
    "$page = Invoke-WebRequest -Uri '%NODE_INDEX_URL%' -UseBasicParsing;" ^
    "$name = ($page.Links.href | Where-Object { $_ -like '*x64.msi' } | Select-Object -First 1);" ^
    "if (-not $name) { exit 1 };" ^
    "Invoke-WebRequest -Uri ('%NODE_INDEX_URL%' + $name) -OutFile '%TEMP_MSI%' -UseBasicParsing"

if errorlevel 1 (
    echo [x] Download failed ^(no internet, or nodejs.org unreachable^).
    echo [i] Opening https://nodejs.org/ so you can download it manually...
    start "" "https://nodejs.org/"
    exit /b 1
)

echo [*] Running installer ^(a UAC prompt may appear^)...
msiexec /i "%TEMP_MSI%" /qn /norestart
if errorlevel 1 (
    echo [x] msiexec reported an error installing Node.js.
    del "%TEMP_MSI%" 2>nul
    exit /b 1
)
timeout /t 5 /nobreak >nul
del "%TEMP_MSI%" 2>nul
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%PATH%"
exit /b 0
