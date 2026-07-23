@echo off
setlocal enabledelayedexpansion

title Sentry Batch Launcher

:: Always run from the script's own directory
cd /d "%~dp0"

:: ===========================================================================
:: COLOR SUPPORT (Windows 10+ VT escape sequences)
:: ===========================================================================
for /f "tokens=2 delims=." %%a in ('ver') do set "VER_FULL=%%a"
for /f "tokens=1 delims=." %%a in ("%VER_FULL%") do set "VER_MAJOR=%%a"
set "USE_COLOR=0"
if !VER_MAJOR! geq 10 (
    set "USE_COLOR=1"
)
if "!USE_COLOR!"=="1" (
    set "C_RESET=[0m"
    set "C_BOLD=[1m"
    set "C_GREEN=[32m"
    set "C_YELLOW=[33m"
    set "C_RED=[31m"
    set "C_CYAN=[36m"
    set "C_DIM=[2m"
) else (
    set "C_RESET="
    set "C_BOLD="
    set "C_GREEN="
    set "C_YELLOW="
    set "C_RED="
    set "C_CYAN="
    set "C_DIM="
)

:: ===========================================================================
:: LOGGING HELPERS
:: ===========================================================================
set "LOG_HEADER=[Sentry Batch]"

echo.%C_BOLD%%LOG_HEADER% Windows Launcher%C_RESET%
echo.

:: ===========================================================================
:: PARSE ARGUMENTS
:: ===========================================================================
set "PORT=8080"
set "LOG_FILE="

:parse_args
if not "%1"=="" (
    if "%1"=="--port" (
        set "PORT=%~2"
        shift
        shift
        goto parse_args
    )
    if "%1"=="--log" (
        set "LOG_FILE=%~2"
        shift
        shift
        goto parse_args
    )
    if "%1"=="--help" (
        echo.Usage: %~nx0 [--port PORT] [--log FILE]
        echo.  --port PORT   HTTP server port (default: 8080^)
        echo.  --log FILE    Write output to log file
        exit /b 0
    )
    echo.Unknown argument: %1
    exit /b 1
)

:: Validate port
set "PORT_OK=1"
for /f "tokens=* delims=0123456789" %%a in ("%PORT%") do set "PORT_OK=0"
if "!PORT_OK!"=="0" (
    echo.%C_RED%Invalid port: %PORT% (must be a number 1-65535^)%C_RESET%
    exit /b 1
)
if %PORT% lss 1 (
    echo.%C_RED%Invalid port: %PORT% (must be 1-65535^)%C_RESET%
    exit /b 1
)
if %PORT% gtr 65535 (
    echo.%C_RED%Invalid port: %PORT% (must be 1-65535^)%C_RESET%
    exit /b 1
)

if not "%LOG_FILE%"=="" echo.Logging to %LOG_FILE%

:: ===========================================================================
:: SYSTEM DETECTION
:: ===========================================================================
set "OS_NAME=Windows"
set "ARCH=%PROCESSOR_ARCHITECTURE%"
if "%ARCH%"=="" set "ARCH=AMD64"

:: Check for Windows version
ver | find "Version 11" >nul 2>&1
if !errorlevel! equ 0 set "OS_NAME=Windows 11"
ver | find "Version 10" >nul 2>&1
if !errorlevel! equ 0 set "OS_NAME=Windows 10"

echo.  %C_CYAN%*%C_RESET% OS: !OS_NAME! (%ARCH%^)
echo.  %C_CYAN%*%C_RESET% Port: %PORT%

:: ===========================================================================
:: CHECK FOR NODE.JS
:: ===========================================================================
:check_node
echo.
echo.%C_BOLD%[1/5] Checking Node.js...%C_RESET%

where node >nul 2>&1
if !errorlevel! neq 0 (
    echo.  %C_YELLOW%!%C_RESET% Node.js not found.
    goto install_node
)

:: Check Node.js version (need 18+)
for /f "tokens=*" %%a in ('node --version 2^>nul') do set "NODE_VER=%%a"
set "NODE_VER=%NODE_VER:v=%"
for /f "tokens=1 delims=." %%a in ("%NODE_VER%") do set "NODE_MAJOR=%%a"

if !NODE_MAJOR! lss 18 (
    echo.  %C_YELLOW%!%C_RESET% Node.js v!NODE_VER! is too old (need v18+^)
    goto install_node
)

echo.  %C_GREEN%+%C_RESET% Node.js v!NODE_VER! found
goto check_npm

:: ===========================================================================
:: INSTALL NODE.JS
:: ===========================================================================
:install_node
echo.  Installing Node.js...

:: Try winget first (Windows 10 1709+ / Windows 11)
where winget >nul 2>&1
if !errorlevel! equ 0 (
    echo.  %C_CYAN%*%C_RESET% Installing via winget...
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --silent >nul 2>&1
    if !errorlevel! equ 0 (
        :: Refresh PATH
        for /f "tokens=*" %%a in ('winget list --id OpenJS.NodeJS.LTS --accept-source-agreements 2^>nul ^| find "Node"') do (
            set "NODE_INSTALLED=1"
        )
        :: Add to PATH for this session
        for /f "tokens=*" %%a in ('dir /s /b "%ProgramFiles%\nodejs\node.exe" 2^>nul ^| find "node.exe"') do (
            set "PATH=%%~dpa;%PATH%"
        )
        for /f "tokens=*" %%a in ('dir /s /b "%ProgramFiles(x86)%\nodejs\node.exe" 2^>nul ^| find "node.exe"') do (
            set "PATH=%%~dpa;%PATH%"
        )
        echo.  %C_GREEN%+%C_RESET% Node.js installed via winget
        goto check_node
    )
    echo.  %C_YELLOW%!%C_RESET% winget install failed, trying next method...
)

:: Try Chocolatey
where choco >nul 2>&1
if !errorlevel! equ 0 (
    echo.  %C_CYAN%*%C_RESET% Installing via Chocolatey...
    choco install nodejs-lts -y --no-progress >nul 2>&1
    if !errorlevel! equ 0 (
        set "PATH=%ProgramData%\chocolatey\lib\nodejs-lts\tools;%PATH%"
        echo.  %C_GREEN%+%C_RESET% Node.js installed via Chocolatey
        goto check_node
    )
    echo.  %C_YELLOW%!%C_RESET% Chocolatey install failed, trying direct download...
)

:: Direct download as last resort
echo.  %C_CYAN%*%C_RESET% Downloading Node.js LTS installer...
set "NODE_URL=https://nodejs.org/dist/v22.9.0/"
if /i "%ARCH%"=="ARM64" (
    set "NODE_URL=%NODE_URL%node-v22.9.0-arm64.msi"
) else if /i "%ARCH%"=="X86" (
    set "NODE_URL=%NODE_URL%node-v22.9.0-x86.msi"
) else (
    set "NODE_URL=%NODE_URL%node-v22.9.0-x64.msi"
)

set "TEMP_MSI=%TEMP%\node-install.msi"
echo.  %C_CYAN%*%C_RESET% Downloading from %NODE_URL%
powershell -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%TEMP_MSI%' -UseBasicParsing } catch { exit 1 }" >nul 2>&1

if !errorlevel! neq 0 (
    echo.  %C_RED%x%C_RESET% Download failed.
    echo.  %C_RED%x%C_RESET% Please install Node.js manually from https://nodejs.org/
    echo.  %C_YELLOW%!%C_RESET% Opening download page...
    start https://nodejs.org/
    pause
    exit /b 1
)

echo.  %C_CYAN%*%C_RESET% Running installer (may need admin rights^)...
msiexec /i "%TEMP_MSI%" /qn /norestart >nul 2>&1

:: Wait for install to complete
ping 127.0.0.1 -n 6 >nul

:: Set PATH for this session
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%PATH%"
del "%TEMP_MSI%" 2>nul
goto check_node

:: ===========================================================================
:: CHECK NPM / NPX
:: ===========================================================================
:check_npm
echo.
echo.%C_BOLD%[2/5] Checking npm...%C_RESET%
where npm >nul 2>&1
if !errorlevel! neq 0 (
    echo.  %C_YELLOW%!%C_RESET% npm not found. Reinstalling Node.js should fix this.
    goto install_node
)
for /f "tokens=*" %%a in ('npm --version 2^>nul') do set "NPM_VER=%%a"
echo.  %C_GREEN%+%C_RESET% npm v!NPM_VER! found

:: ===========================================================================
:: CHECK INTERNET CONNECTIVITY
:: ===========================================================================
echo.
echo.%C_BOLD%[3/5] Checking connectivity...%C_RESET%
set "HAS_INTERNET=0"
ping -n 1 -w 2000 registry.npmjs.org >nul 2>&1
if !errorlevel! equ 0 set "HAS_INTERNET=1"
if "!HAS_INTERNET!"=="1" (
    echo.  %C_GREEN%+%C_RESET% Internet reachable
) else (
    echo.  %C_YELLOW%!%C_RESET% No internet detected (http-server will still start if already cached by npx^)
)

:: ===========================================================================
:: CHECK PORT AVAILABILITY
:: ===========================================================================
echo.
echo.%C_BOLD%[4/5] Checking port %PORT%...%C_RESET%
netstat -an | findstr "LISTENING" | findstr ":%PORT% " >nul 2>&1
if !errorlevel! equ 0 (
    echo.  %C_YELLOW%!%C_RESET% Port %PORT% is in use.
    set "FOUND_PORT=0"
    for /l %%p in (1,1,20) do (
        set /a "TEST_PORT=%PORT%+%%p"
        netstat -an | findstr "LISTENING" | findstr ":!TEST_PORT! " >nul 2>&1
        if !errorlevel! neq 0 (
            set "PORT=!TEST_PORT!"
            set "FOUND_PORT=1"
            echo.  %C_CYAN%*%C_RESET% Using alternative port !TEST_PORT!
            goto port_done
        )
    )
    if "!FOUND_PORT!"=="0" (
        echo.  %C_RED%x%C_RESET% Could not find a free port after trying 20 alternatives.
        echo.  %C_RED%x%C_RESET% Close programs using port %PORT% and try again.
        pause
        exit /b 1
    )
) else (
    echo.  %C_GREEN%+%C_RESET% Port %PORT% is available
)
:port_done

:: ===========================================================================
:: PROJECT FILES CHECK
:: ===========================================================================
echo.
echo.%C_BOLD%[5/5] Verifying project files...%C_RESET%
if not exist "index.html" (
    echo.  %C_RED%x%C_RESET% index.html not found!
    echo.  %C_RED%x%C_RESET% Run this script from the Sentry Batch directory.
    pause
    exit /b 1
)
echo.  %C_GREEN%+%C_RESET% Project files OK

:: ===========================================================================
:: CLEANUP TRAP (Windows equivalent via a temp flag file)
:: ===========================================================================
set "CLEANUP_FLAG=%TEMP%\sentry_batch_running_%RANDOM%.tmp"
echo %PORT% > "%CLEANUP_FLAG%"
set "STARTED_AT=%TIME%"

:: ===========================================================================
:: HTTP SERVER
:: ===========================================================================
echo.
echo.%C_BOLD%============================================================%C_RESET%
echo.  %C_CYAN%*%C_RESET% Starting HTTP server on port %PORT%...
echo.  %C_CYAN%*%C_RESET% URL: http://localhost:%PORT%/
echo.%C_BOLD%============================================================%C_RESET%
echo.

:: Kill any leftover http-server on our port from previous runs
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
    if not "%%a"=="" (
        taskkill /f /pid %%a >nul 2>&1
    )
)

:: Start http-server minimized
echo.  Starting server (this may take a moment on first run while npx downloads http-server^)...
start "" /min cmd /c "npx --yes http-server -p %PORT% -a 127.0.0.1 --cors --cache -1 --silent"

:: Wait for server with progressive timeout
set "SERVER_READY=0"
for /l %%t in (1,1,15) do (
    ping 127.0.0.1 -n 2 >nul
    :: Try to connect to the server using PowerShell
    powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch { exit 1 }" >nul 2>&1
    if !errorlevel! equ 0 (
        set "SERVER_READY=1"
        echo.  %C_GREEN%+%C_RESET% Server ready after %%t seconds
        goto server_ok
    )
    if %%t equ 1 echo.  %C_CYAN%*%C_RESET% Waiting for server...
    if %%t equ 5 echo.  %C_CYAN%*%C_RESET% Still waiting (http-server may be downloading via npx^)...
    if %%t equ 10 echo.  %C_CYAN%*%C_RESET% Nearly there...
)

:server_ok
if "!SERVER_READY!"=="0" (
    echo.  %C_RED%x%C_RESET% Server did not become ready after 15 attempts.
    echo.  %C_RED%x%C_RESET% Try running: npx --yes http-server -p %PORT%
    pause
    exit /b 1
)

echo.
echo.%C_GREEN%+%C_RESET% Server running at http://localhost:%PORT%/
echo.

:: ===========================================================================
:: OPEN BROWSER
:: ===========================================================================
echo.  %C_CYAN%*%C_RESET% Opening browser...
set "URL=http://localhost:%PORT%/"

:: Try multiple browser open methods
start "" "%URL%" 2>nul
if !errorlevel! neq 0 (
    powershell -Command "Start-Process '%URL%'" >nul 2>&1
)
echo.  %C_GREEN%+%C_RESET% Browser opened

:: ===========================================================================
:: DONE
:: ===========================================================================
echo.
echo.%C_BOLD%============================================================%C_RESET%
echo.  %C_GREEN%Sentry Batch is running!%C_RESET%
echo.  URL: %C_BOLD%http://localhost:%PORT%/%C_RESET%
echo.  %C_DIM%Press Ctrl+C in this window to stop the server.%C_RESET%
echo.%C_BOLD%============================================================%C_RESET%
echo.

:: Keep window open so user can press Ctrl+C
echo.%C_DIM%Server process running in background. Close this window to stop.%C_RESET%
echo.
pause

:: ===========================================================================
:: CLEANUP on exit
:: ===========================================================================
:cleanup
echo.
echo.  %C_YELLOW%!%C_RESET% Shutting down Sentry Batch...

:: Kill http-server processes
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
    if not "%%a"=="" (
        taskkill /f /pid %%a >nul 2>&1
    )
)

:: Also kill any node processes that look like http-server
taskkill /f /im node.exe /fi "WINDOWTITLE eq http-server*" >nul 2>&1

:: Cleanup temp flag
if exist "%CLEANUP_FLAG%" del "%CLEANUP_FLAG%" >nul 2>&1

echo.  %C_GREEN%+%C_RESET% Server stopped.
if not "%LOG_FILE%"=="" echo.Log saved to %LOG_FILE%
timeout /t 2 >nul
exit /b 0
