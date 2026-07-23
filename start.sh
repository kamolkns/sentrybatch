#!/usr/bin/env bash
#
# start.sh — Launcher for Sentry Batch
# https://github.com/kamolkns/sentrybatch
#
# Sentry Batch is a browser-based SPA that uses ES modules and a Service
# Worker, so it must be served over HTTP (file:// will not work). This
# script ensures Node.js is available, serves the project root on port
# 8080 via http-server, and opens it in the default browser.
#
# Usage:  ./start.sh [--port PORT] [--log FILE]

set -euo pipefail

# ===========================================================================
# CONSTANTS
# ===========================================================================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"
DEFAULT_PORT=8080
MIN_NODE_MAJOR=18
CLEANUP_DONE=0

# ===========================================================================
# COLOR & OUTPUT HELPERS
# ===========================================================================
if [ -t 1 ]; then
    C_RESET="\033[0m"
    C_BOLD="\033[1m"
    C_GREEN="\033[32m"
    C_YELLOW="\033[33m"
    C_RED="\033[31m"
    C_CYAN="\033[36m"
    C_DIM="\033[2m"
else
    C_RESET=""; C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_DIM=""
fi

header()  { printf "\n%b[*]%b %s\n" "${C_CYAN}"   "${C_RESET}" "$1"; }
info()    { printf "  %b[*]%b %s\n" "${C_CYAN}"   "${C_RESET}" "$1"; }
ok()      { printf "  %b[+]%b %s\n" "${C_GREEN}"  "${C_RESET}" "$1"; }
warn()    { printf "  %b[!]%b %s\n" "${C_YELLOW}" "${C_RESET}" "$1"; }
err()     { printf "  %b[x]%b %s\n" "${C_RED}"    "${C_RESET}" "$1" >&2; }
die()     { err "$1"; exit "${2:-1}"; }

# ===========================================================================
# PARSE ARGUMENTS
# ===========================================================================
PORT="$DEFAULT_PORT"
LOG_FILE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --port) PORT="${2:-$DEFAULT_PORT}"; shift 2 ;;
        --log)  LOG_FILE="$2"; shift 2 ;;
        --help|-h)
            echo "Usage: $0 [--port PORT] [--log FILE]"
            echo "  --port PORT   HTTP server port (default: $DEFAULT_PORT)"
            echo "  --log FILE    Write output to log file"
            exit 0
            ;;
        *) die "Unknown argument: $1 (use --help for usage)" ;;
    esac
done

# Validate port
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    die "Invalid port: $PORT (must be 1-65535)"
fi

# Redirect to log file if requested
if [ -n "$LOG_FILE" ]; then
    exec > >(tee -a "$LOG_FILE") 2>&1
fi

# ===========================================================================
# CLEANUP TRAP
# ===========================================================================
cleanup() {
    if [ "$CLEANUP_DONE" -eq 1 ]; then return; fi
    CLEANUP_DONE=1
    echo ""
    warn "Shutting down Sentry Batch..."
    if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
        ok "Server process terminated."
    fi
    # Kill any lingering http-server on our port
    if command -v lsof >/dev/null 2>&1; then
        local pids
        pids=$(lsof -ti ":$PORT" 2>/dev/null || true)
        if [ -n "$pids" ]; then
            kill $pids 2>/dev/null || true
        fi
    elif command -v fuser >/dev/null 2>&1; then
        fuser -k "${PORT}/tcp" 2>/dev/null || true
    fi
    ok "Goodbye."
}

trap cleanup EXIT INT TERM HUP

# ===========================================================================
# SYSTEM DETECTION
# ===========================================================================
printf "%b\n" "${C_BOLD}==> Sentry Batch Launcher${C_RESET}"

detect_system() {
    local os="$(uname -s 2>/dev/null || echo unknown)"
    local distro=""
    local pkg_manager=""

    case "$os" in
        Darwin)
            distro="macOS"
            if command -v brew >/dev/null 2>&1; then
                pkg_manager="brew"
            elif command -v port >/dev/null 2>&1; then
                pkg_manager="macports"
            fi
            ;;
        Linux)
            if   command -v apt >/dev/null 2>&1; then        pkg_manager="apt"
            elif command -v apt-get >/dev/null 2>&1; then    pkg_manager="apt-get"
            elif command -v pacman >/dev/null 2>&1; then     pkg_manager="pacman"
            elif command -v dnf >/dev/null 2>&1; then        pkg_manager="dnf"
            elif command -v yum >/dev/null 2>&1; then        pkg_manager="yum"
            elif command -v zypper >/dev/null 2>&1; then     pkg_manager="zypper"
            elif command -v nix-env >/dev/null 2>&1; then    pkg_manager="nix"
            elif command -v apk >/dev/null 2>&1; then        pkg_manager="apk"
            elif command -v emerge >/dev/null 2>&1; then     pkg_manager="portage"
            fi
            if [ -f /etc/os-release ]; then
                distro=$(grep -oP '^PRETTY_NAME="\K[^"]+' /etc/os-release 2>/dev/null || echo "Linux")
            else
                distro="Linux"
            fi
            ;;
        MINGW*|MSYS*|CYGWIN*)
            distro="Windows (Git Bash/MSYS2)"
            pkg_manager="winget"
            ;;
        *)
            distro="$os"
            ;;
    esac

    echo "$distro|$pkg_manager|$os"
}

IFS='|' read -r DISTRO PKG_MANAGER OS_KERNEL < <(detect_system)
info "System: $DISTRO | Package manager: ${PKG_MANAGER:-none detected}"

# ===========================================================================
# DEPENDENCY: Node.js
# ===========================================================================
ensure_node() {
    # Check if node is available
    if ! command -v node >/dev/null 2>&1; then
        warn "Node.js is not installed."
        install_node
        # Re-check after installation
        if ! command -v node >/dev/null 2>&1; then
            die "Node.js installation failed. Install manually from https://nodejs.org/"
        fi
        ok "Node.js installed: $(node --version)"
        return
    fi

    # Check minimum version
    local node_ver
    node_ver=$(node --version 2>/dev/null | sed 's/^v//')
    local node_major="${node_ver%%.*}"
    if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
        warn "Node.js $node_ver is too old (need v$MIN_NODE_MAJOR+). Upgrading..."
        install_node
        node_ver=$(node --version 2>/dev/null | sed 's/^v//')
        node_major="${node_ver%%.*}"
        if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
            die "Still on Node.js $node_ver after upgrade. Please install v$MIN_NODE_MAJOR+ manually."
        fi
        ok "Node.js upgraded: $(node --version)"
    else
        ok "Node.js found: $(node --version)"
    fi

    # Check for npm/npx
    if ! command -v npm >/dev/null 2>&1; then
        warn "npm not found. Installing..."
        install_node
    fi
    if ! command -v npx >/dev/null 2>&1; then
        warn "npx not found. Installing..."
        install_node
    fi
}

install_node() {
    header "Installing Node.js..."

    case "$PKG_MANAGER" in
        apt|apt-get)
            if [ "$(id -u)" -ne 0 ]; then
                warn "Package installation requires sudo for apt."
            fi
            sudo "${PKG_MANAGER}" update -qq || true
            # Try the official NodeSource setup for a recent version
            if ! sudo "${PKG_MANAGER}" install -y nodejs npm 2>/dev/null; then
                warn "Fallback: installing via NodeSource..."
                curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && \
                    sudo "${PKG_MANAGER}" install -y nodejs
            fi
            ;;
        pacman)
            if [ "$(id -u)" -ne 0 ]; then
                warn "Package installation requires sudo for pacman."
            fi
            sudo pacman -S --noconfirm nodejs npm 2>/dev/null || \
                sudo pacman -S --noconfirm nodejs-lts-iron npm 2>/dev/null || \
                die "Failed to install Node.js via pacman."
            ;;
        dnf)
            if [ "$(id -u)" -ne 0 ]; then
                warn "Package installation requires sudo for dnf."
            fi
            sudo dnf install -y nodejs npm 2>/dev/null || {
                sudo dnf module enable -y nodejs:22 2>/dev/null || true
                sudo dnf install -y nodejs npm
            }
            ;;
        yum)
            if [ "$(id -u)" -ne 0 ]; then
                warn "Package installation requires sudo for yum."
            fi
            curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash - && \
                sudo yum install -y nodejs
            ;;
        zypper)
            if [ "$(id -u)" -ne 0 ]; then
                warn "Package installation requires sudo for zypper."
            fi
            sudo zypper --non-interactive install nodejs npm
            ;;
        brew)
            if ! command -v brew >/dev/null 2>&1; then
                info "Installing Homebrew..."
                /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
                # Add to PATH for this session
                if [ -x /opt/homebrew/bin/brew ]; then
                    eval "$(/opt/homebrew/bin/brew shellenv)"
                elif [ -x /usr/local/bin/brew ]; then
                    eval "$(/usr/local/bin/brew shellenv)"
                fi
            fi
            brew install node
            ;;
        macports)
            sudo port install nodejs22 npm
            ;;
        nix)
            info "Re-executing inside nix-shell with Node.js..."
            exec nix-shell -p nodejs --run "$0 --port $PORT${LOG_FILE:+ --log \"$LOG_FILE\"}"
            ;;
        apk)
            if [ "$(id -u)" -ne 0 ]; then
                warn "Package installation requires sudo for apk."
            fi
            sudo apk add nodejs npm
            ;;
        portage)
            if [ "$(id -u)" -ne 0 ]; then
                warn "Package installation requires sudo for emerge."
            fi
            sudo emerge --ask=n dev-lang/nodejs
            ;;
        winget)
            winget install OpenJS.NodeJS.LTS
            ;;
        *)
            die "No supported package manager found. Install Node.js from https://nodejs.org/"
            ;;
    esac

    # Refresh PATH if brew installed into a non-standard location
    if [ "$PKG_MANAGER" = "brew" ]; then
        if [ -x /opt/homebrew/bin/node ]; then
            export PATH="/opt/homebrew/bin:$PATH"
        elif [ -x /usr/local/bin/node ]; then
            export PATH="/usr/local/bin:$PATH"
        fi
    fi
}

# ===========================================================================
# DEPENDENCY: http-server
# ===========================================================================
ensure_http_server() {
    # http-server is fetched on-demand by npx. Verify npx works.
    info "Verifying npx works..."
    if ! npx --version >/dev/null 2>&1; then
        warn "npx is broken or missing. Trying to fix..."
        npm install -g npx 2>/dev/null || die "Cannot use npx. Try: npm install -g http-server"
    fi
}

# ===========================================================================
# PORT CHECK
# ===========================================================================
check_port() {
    local port="$1"
    if command -v lsof >/dev/null 2>&1; then
        if lsof -i ":$port" >/dev/null 2>&1; then
            return 1
        fi
    elif command -v ss >/dev/null 2>&1; then
        if ss -tln "sport = :$port" 2>/dev/null | grep -q LISTEN; then
            return 1
        fi
    elif command -v netstat >/dev/null 2>&1; then
        if netstat -tln 2>/dev/null | grep -q ":$port "; then
            return 1
        fi
    elif command -v fuser >/dev/null 2>&1; then
        if fuser "${port}/tcp" >/dev/null 2>&1; then
            return 1
        fi
    fi
    return 0
}

# ===========================================================================
# INTERNET CHECK
# ===========================================================================
check_internet() {
    local targets=(
        "https://registry.npmjs.org"
        "https://google.com"
        "https://1.1.1.1"
    )
    for target in "${targets[@]}"; do
        if command -v curl >/dev/null 2>&1; then
            if curl -fsSL --connect-timeout 3 "$target" >/dev/null 2>&1; then
                return 0
            fi
        elif command -v wget >/dev/null 2>&1; then
            if wget -q --timeout=3 "$target" -O /dev/null 2>/dev/null; then
                return 0
            fi
        fi
    done
    return 1
}

# ===========================================================================
# PROJECT CHECK
# ===========================================================================
check_project() {
    if [ ! -f "$PROJECT_ROOT/index.html" ]; then
        die "index.html not found in $PROJECT_ROOT. Run this script from the Sentry Batch directory."
    fi
    if [ ! -f "$PROJECT_ROOT/main.js" ]; then
        warn "main.js not found — the app may not work correctly."
    fi
}

# ===========================================================================
# FIND BROWSER
# ===========================================================================
find_browser() {
    local browser_cmds=()

    case "$OS_KERNEL" in
        Darwin)
            browser_cmds=("open")
            ;;
        Linux)
            browser_cmds=("xdg-open" "gio open" "gnome-open" "kde-open" "exo-open")
            # Also check for specific browser binaries
            for b in google-chrome chromium chromium-browser firefox brave-browser edge midori; do
                if command -v "$b" >/dev/null 2>&1; then
                    browser_cmds+=("$b")
                fi
            done
            ;;
        MINGW*|MSYS*|CYGWIN*)
            browser_cmds=("start" "explorer")
            ;;
        *)
            browser_cmds=("xdg-open")
            ;;
    esac

    for cmd in "${browser_cmds[@]}"; do
        if command -v "$cmd" >/dev/null 2>&1; then
            echo "$cmd"
            return 0
        fi
    done
    echo ""
    return 1
}

# ===========================================================================
# MAIN
# ===========================================================================

# 1. Check internet
header "Connectivity"
if check_internet; then
    ok "Internet reachable"
else
    warn "No internet detected. http-server will still start if already cached."
    warn "Expected Internet access for installing Node.js and http-server."
fi

# 2. Check project files
header "Project"
check_project
ok "Project root: $PROJECT_ROOT"

# 3. Ensure Node.js
header "Dependencies"
ensure_node
ok "npm: $(npm --version 2>/dev/null || echo '?')"
ensure_http_server

# 4. Check port availability
header "Port"
if check_port "$PORT"; then
    ok "Port $PORT is available"
else
    warn "Port $PORT is already in use."
    # Try to find the next available port
    alt_port=$PORT
    max_attempts=20
    for ((i=1; i<=max_attempts; i++)); do
        alt_port=$((PORT + i))
        if check_port "$alt_port"; then
            warn "Using alternative port $alt_port instead."
            PORT=$alt_port
            break
        fi
    done
    if [ "$PORT" -eq "$((PORT))" ] && ! check_port "$PORT"; then
        # Still blocked
        pids=""
        if command -v lsof >/dev/null 2>&1; then
            pids=$(lsof -ti ":$PORT" 2>/dev/null || true)
        fi
        if [ -n "$pids" ]; then
            warn "Process(es) $pids are using port $PORT."
            warn "To kill them: kill $pids"
        fi
        die "Could not find a free port after trying $max_attempts alternatives."
    fi
fi

# 5. Start http-server
header "Server"
info "Starting HTTP server on port $PORT..."
info "URL: http://localhost:$PORT/"

# Use http-server with proper flags
npx --yes http-server "$PROJECT_ROOT" \
    -p "$PORT" \
    -a 127.0.0.1 \
    --cors \
    --cache -1 \
    --silent &
SERVER_PID=$!

# Wait for server to become ready with exponential backoff
SERVER_READY=0
for attempt in 1 2 3 4 5; do
    sleep $((attempt))

    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        # Process died — wait a moment and check exit status
        wait "$SERVER_PID" 2>/dev/null || true
        die "http-server failed to start. Try: npx http-server -p $PORT"
    fi

    # Probe the server
    if command -v curl >/dev/null 2>&1; then
        if curl -fsSL --connect-timeout 2 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
            SERVER_READY=1
            break
        fi
    elif command -v wget >/dev/null 2>&1; then
        if wget -q --timeout=2 "http://127.0.0.1:$PORT/" -O /dev/null 2>/dev/null; then
            SERVER_READY=1
            break
        fi
    else
        # Can't probe, but process is alive — assume it's working
        SERVER_READY=1
        break
    fi
done

if [ "$SERVER_READY" -eq 0 ]; then
    die "Server did not become ready. Check: http://127.0.0.1:$PORT/"
fi

ok "Server running (PID $SERVER_PID) at http://localhost:$PORT/"

# 6. Open browser
header "Browser"
BROWSER_CMD=$(find_browser || true)
URL="http://localhost:$PORT/"

if [ -n "$BROWSER_CMD" ]; then
    info "Opening browser via $BROWSER_CMD..."
    case "$BROWSER_CMD" in
        open)     "$BROWSER_CMD" "$URL" 2>/dev/null || true ;;
        xdg-open) "$BROWSER_CMD" "$URL" 2>/dev/null || true ;;
        start)    "$BROWSER_CMD" "$URL" 2>/dev/null || true ;;
        explorer) "$BROWSER_CMD" "http://127.0.0.1:$PORT/" 2>/dev/null || true ;;
        *)        "$BROWSER_CMD" "$URL" 2>/dev/null || true ;;
    esac
    ok "Browser opened."
else
    warn "Could not detect a browser opener. Open $URL manually."
fi

# 7. Done
echo ""
printf "%b" "${C_BOLD}"
printf "%s" "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
printf "%b\n" "${C_RESET}"
ok "Sentry Batch is running at ${C_BOLD}http://localhost:$PORT/${C_RESET}"
info "Press ${C_BOLD}Ctrl+C${C_RESET} to stop the server."
printf "%b" "${C_BOLD}"
printf "%s" "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
printf "%b\n" "${C_RESET}"

# 8. Stay alive
wait "$SERVER_PID"
