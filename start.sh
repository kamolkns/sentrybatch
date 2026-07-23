#!/usr/bin/env bash
#
# start.sh — Launcher for Sentry Batch
# https://github.com/kamolkns/sentrybatch
#
# Sentry Batch is a browser-based SPA that uses ES modules and a Service
# Worker, so it must be served over HTTP (file:// will not work). This
# script ensures Node.js is available, serves the project root via
# http-server, and opens it in the default browser.
#
# Usage:  ./start.sh [--port PORT] [--log FILE] [--no-browser]

# ---------------------------------------------------------------------------
# Guard: must run under bash. If invoked via `sh start.sh`, re-exec under bash
# instead of failing on `set -o pipefail` or array syntax with a cryptic error.
# ---------------------------------------------------------------------------
if [ -z "${BASH_VERSION:-}" ]; then
    if command -v bash >/dev/null 2>&1; then
        exec bash "$0" "$@"
    else
        echo "This script requires bash, which was not found on PATH." >&2
        echo "Install bash or run: bash start.sh" >&2
        exit 1
    fi
fi

set -euo pipefail

# ===========================================================================
# CONSTANTS
# ===========================================================================
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"
DEFAULT_PORT=8080
MIN_NODE_MAJOR=18
CLEANUP_DONE=0
SERVER_LOG="$(mktemp -t sentrybatch.XXXXXX 2>/dev/null || echo "/tmp/sentrybatch.$$.log")"
LOCK_FILE=""

# ===========================================================================
# COLOR & OUTPUT HELPERS
# ===========================================================================
if [ -t 1 ]; then
    C_RESET="\033[0m"; C_BOLD="\033[1m"; C_GREEN="\033[32m"
    C_YELLOW="\033[33m"; C_RED="\033[31m"; C_CYAN="\033[36m"; C_DIM="\033[2m"
else
    C_RESET=""; C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_DIM=""
fi

header()  { printf "\n%b[*]%b %s\n" "${C_CYAN}"   "${C_RESET}" "$1"; }
info()    { printf "  %b[*]%b %s\n" "${C_CYAN}"   "${C_RESET}" "$1"; }
ok()      { printf "  %b[+]%b %s\n" "${C_GREEN}"  "${C_RESET}" "$1"; }
warn()    { printf "  %b[!]%b %s\n" "${C_YELLOW}" "${C_RESET}" "$1"; }
err()     { printf "  %b[x]%b %s\n" "${C_RED}"    "${C_RESET}" "$1" >&2; }
die()     { err "$1"; echo ""; err "Full log: $SERVER_LOG"; exit "${2:-1}"; }
is_num()  { [[ "$1" =~ ^[0-9]+$ ]]; }

# ===========================================================================
# PRIVILEGE HELPER — works whether we're root, have sudo, or have neither
# ===========================================================================
run_priv() {
    if [ "$(id -u 2>/dev/null || echo 1)" -eq 0 ]; then
        "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo "$@"
    else
        die "This step needs root privileges but 'sudo' isn't available. Re-run as root, or install sudo."
    fi
}

# ===========================================================================
# PARSE ARGUMENTS  (supports --flag value AND --flag=value)
# ===========================================================================
PORT="$DEFAULT_PORT"
LOG_FILE=""
NO_BROWSER=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --port=*) PORT="${1#*=}"; shift ;;
        --port)
            [ $# -ge 2 ] || die "--port requires a value"
            PORT="$2"; shift 2 ;;
        --log=*) LOG_FILE="${1#*=}"; shift ;;
        --log)
            [ $# -ge 2 ] || die "--log requires a file path"
            LOG_FILE="$2"; shift 2 ;;
        --no-browser) NO_BROWSER=1; shift ;;
        --help|-h)
            echo "Usage: $0 [--port PORT] [--log FILE] [--no-browser]"
            echo "  --port PORT     HTTP server port (default: $DEFAULT_PORT)"
            echo "  --log FILE      Copy server output to FILE for troubleshooting"
            echo "  --no-browser    Don't auto-open the browser"
            exit 0
            ;;
        *) die "Unknown argument: $1 (use --help for usage)" ;;
    esac
done

if ! is_num "$PORT" || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    die "Invalid port: '$PORT' (must be a number 1-65535)"
fi

# ===========================================================================
# SINGLE-INSTANCE LOCK (prevents two copies of this script fighting for
# the same port and stepping on each other's cleanup trap)
# ===========================================================================
acquire_lock() {
    local lock_dir="${TMPDIR:-/tmp}/sentrybatch-${PORT}.lock"
    if mkdir "$lock_dir" 2>/dev/null; then
        LOCK_FILE="$lock_dir"
        echo $$ > "$LOCK_FILE/pid" 2>/dev/null || true
    else
        local old_pid=""
        [ -f "$lock_dir/pid" ] && old_pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
        if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
            die "Sentry Batch already appears to be running on port $PORT (PID $old_pid). Stop it first, or use --port to pick a different one."
        else
            # Stale lock from a crashed run — reclaim it.
            rm -rf "$lock_dir" 2>/dev/null || true
            mkdir "$lock_dir" 2>/dev/null && LOCK_FILE="$lock_dir"
            echo $$ > "$LOCK_FILE/pid" 2>/dev/null || true
        fi
    fi
}

# ===========================================================================
# CLEANUP TRAP
# ===========================================================================
cleanup() {
    [ "$CLEANUP_DONE" -eq 1 ] && return
    CLEANUP_DONE=1
    echo ""
    warn "Shutting down Sentry Batch..."

    if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
        ok "Server process terminated."
    fi

    if command -v lsof >/dev/null 2>&1; then
        local pids
        pids="$(lsof -ti ":$PORT" 2>/dev/null || true)"
        [ -n "$pids" ] && kill $pids 2>/dev/null || true
    elif command -v fuser >/dev/null 2>&1; then
        fuser -k "${PORT}/tcp" 2>/dev/null || true
    fi

    if [ -n "$LOG_FILE" ]; then
        cp -f "$SERVER_LOG" "$LOG_FILE" 2>/dev/null || true
        info "Log saved to $LOG_FILE"
    fi
    rm -f "$SERVER_LOG" 2>/dev/null || true
    [ -n "$LOCK_FILE" ] && rm -rf "$LOCK_FILE" 2>/dev/null || true
    ok "Goodbye."
}
trap cleanup EXIT INT TERM HUP

acquire_lock

# ===========================================================================
# SYSTEM DETECTION
# ===========================================================================
printf "%b\n" "${C_BOLD}==> Sentry Batch Launcher${C_RESET}"

detect_system() {
    local os distro="" pkg_manager=""
    os="$(uname -s 2>/dev/null || echo unknown)"

    case "$os" in
        Darwin)
            distro="macOS"
            if command -v brew >/dev/null 2>&1; then pkg_manager="brew"
            elif command -v port >/dev/null 2>&1; then pkg_manager="macports"; fi
            ;;
        Linux)
            if [ -r /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null; then
                distro="WSL"
            fi
            if   command -v apt >/dev/null 2>&1; then          pkg_manager="apt"
            elif command -v apt-get >/dev/null 2>&1; then      pkg_manager="apt-get"
            elif command -v pacman >/dev/null 2>&1; then       pkg_manager="pacman"
            elif command -v dnf >/dev/null 2>&1; then          pkg_manager="dnf"
            elif command -v yum >/dev/null 2>&1; then          pkg_manager="yum"
            elif command -v zypper >/dev/null 2>&1; then       pkg_manager="zypper"
            elif command -v xbps-install >/dev/null 2>&1; then pkg_manager="xbps"
            elif command -v eopkg >/dev/null 2>&1; then        pkg_manager="eopkg"
            elif command -v slackpkg >/dev/null 2>&1; then     pkg_manager="slackpkg"
            elif command -v apk >/dev/null 2>&1; then          pkg_manager="apk"
            elif command -v emerge >/dev/null 2>&1; then       pkg_manager="portage"
            elif command -v nix-env >/dev/null 2>&1; then      pkg_manager="nix"
            fi
            if [ -z "$distro" ]; then
                if [ -r /etc/os-release ]; then
                    distro="$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-Linux}")"
                fi
                [ -z "$distro" ] && distro="Linux"
            fi
            ;;
        FreeBSD) distro="FreeBSD"; command -v pkg >/dev/null 2>&1 && pkg_manager="freebsd-pkg" ;;
        OpenBSD) distro="OpenBSD"; command -v pkg_add >/dev/null 2>&1 && pkg_manager="openbsd-pkg" ;;
        MINGW*|MSYS*|CYGWIN*) distro="Windows (Git Bash/MSYS2)"; pkg_manager="winget" ;;
        *) distro="$os" ;;
    esac

    # Trailing newline matters here: without it, `read` reports a non-zero
    # exit status on the final field even though it read correctly, which
    # would trip `set -e` and kill the script right after this call.
    printf '%s|%s|%s\n' "$distro" "$pkg_manager" "$os"
}

IFS='|' read -r DISTRO PKG_MANAGER OS_KERNEL < <(detect_system)
info "System: $DISTRO | Package manager: ${PKG_MANAGER:-none detected}"

# ===========================================================================
# DEPENDENCY: Node.js
# ===========================================================================
install_node() {
    header "Installing Node.js..."

    case "$PKG_MANAGER" in
        apt|apt-get)
            run_priv "${PKG_MANAGER}" update -qq || true
            if ! run_priv "${PKG_MANAGER}" install -y nodejs npm 2>>"$SERVER_LOG"; then
                warn "Distro package too old, trying NodeSource..."
                command -v curl >/dev/null 2>&1 || die "curl is required to fetch the NodeSource install script."
                curl -fsSL https://deb.nodesource.com/setup_22.x | run_priv bash - \
                    && run_priv "${PKG_MANAGER}" install -y nodejs
            fi
            ;;
        pacman)
            run_priv pacman -Sy --noconfirm nodejs npm 2>>"$SERVER_LOG" \
                || die "Failed to install Node.js via pacman."
            ;;
        dnf)
            run_priv dnf install -y nodejs npm 2>>"$SERVER_LOG" || {
                run_priv dnf module enable -y nodejs:22 2>/dev/null || true
                run_priv dnf install -y nodejs npm
            }
            ;;
        yum)
            command -v curl >/dev/null 2>&1 || die "curl is required to fetch the NodeSource install script."
            curl -fsSL https://rpm.nodesource.com/setup_22.x | run_priv bash - \
                && run_priv yum install -y nodejs
            ;;
        zypper)   run_priv zypper --non-interactive install nodejs npm ;;
        xbps)     run_priv xbps-install -Sy nodejs ;;
        eopkg)    run_priv eopkg install -y nodejs ;;
        slackpkg) run_priv slackpkg install nodejs ;;
        apk)      run_priv apk add nodejs npm ;;
        portage)  run_priv emerge --ask=n dev-lang/nodejs ;;
        nix)
            info "Re-executing inside nix-shell with Node.js..."
            exec nix-shell -p nodejs --run "bash \"$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")\" --port $PORT"
            ;;
        brew)
            if ! command -v brew >/dev/null 2>&1; then
                info "Installing Homebrew..."
                /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
                if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"
                elif [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
            fi
            brew install node
            ;;
        macports)    run_priv port install nodejs22 npm ;;
        freebsd-pkg) run_priv pkg install -y node npm ;;
        openbsd-pkg) run_priv pkg_add node ;;
        winget)      winget install OpenJS.NodeJS.LTS ;;
        *) die "No supported package manager found for '$DISTRO'. Install Node.js manually from https://nodejs.org/" ;;
    esac

    if [ "$PKG_MANAGER" = "brew" ]; then
        if [ -x /opt/homebrew/bin/node ]; then export PATH="/opt/homebrew/bin:$PATH"
        elif [ -x /usr/local/bin/node ]; then export PATH="/usr/local/bin:$PATH"; fi
    fi
}

ensure_node() {
    if ! command -v node >/dev/null 2>&1; then
        warn "Node.js is not installed."
        install_node
        command -v node >/dev/null 2>&1 || die "Node.js installation failed. Install manually from https://nodejs.org/"
        ok "Node.js installed: $(node --version)"
    else
        local node_ver node_major
        node_ver="$(node --version 2>/dev/null | sed 's/^v//')"
        node_major="${node_ver%%.*}"

        if ! is_num "$node_major"; then
            warn "Could not parse Node.js version ('$node_ver') — continuing without a version check."
        elif [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
            warn "Node.js $node_ver is older than recommended v$MIN_NODE_MAJOR+. Upgrading..."
            install_node
            node_ver="$(node --version 2>/dev/null | sed 's/^v//')"
            node_major="${node_ver%%.*}"
            if is_num "$node_major" && [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
                warn "Still on Node.js $node_ver after upgrade attempt — continuing anyway."
            else
                ok "Node.js upgraded: $(node --version)"
            fi
        else
            ok "Node.js found: $(node --version)"
        fi
    fi

    if ! command -v npm >/dev/null 2>&1; then
        warn "npm not found alongside node. Reinstalling Node.js..."
        install_node
        command -v npm >/dev/null 2>&1 || die "npm still missing after reinstall. Try installing Node.js manually from https://nodejs.org/"
    fi
    if ! command -v npx >/dev/null 2>&1; then
        die "npx not found (should ship with npm 5.2+). Try: npm install -g npx"
    fi
}

# ===========================================================================
# PORT CHECK
# ===========================================================================
check_port() {
    local port="$1"
    if command -v lsof >/dev/null 2>&1; then
        lsof -i ":$port" >/dev/null 2>&1 && return 1
    elif command -v ss >/dev/null 2>&1; then
        ss -tln 2>/dev/null | awk '{print $4}' | grep -q ":$port\$" && return 1
    elif command -v netstat >/dev/null 2>&1; then
        netstat -tln 2>/dev/null | grep -q ":$port " && return 1
    elif command -v fuser >/dev/null 2>&1; then
        fuser "${port}/tcp" >/dev/null 2>&1 && return 1
    fi
    return 0
}

find_free_port() {
    local start="$1" max_attempts=20 candidate
    for ((i = 0; i <= max_attempts; i++)); do
        candidate=$((start + i))
        [ "$candidate" -gt 65535 ] && break
        if check_port "$candidate"; then
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 1
}

# ===========================================================================
# INTERNET CHECK
# ===========================================================================
check_internet() {
    local targets=("https://registry.npmjs.org" "https://github.com")
    for target in "${targets[@]}"; do
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL --connect-timeout 3 "$target" >/dev/null 2>&1 && return 0
        elif command -v wget >/dev/null 2>&1; then
            wget -q --timeout=3 "$target" -O /dev/null 2>/dev/null && return 0
        fi
    done
    return 1
}

# ===========================================================================
# PROJECT CHECK
# ===========================================================================
check_project() {
    [ -f "$PROJECT_ROOT/index.html" ] || die "index.html not found in $PROJECT_ROOT. Run this script from the Sentry Batch project root."
}

# ===========================================================================
# FIND BROWSER
# ===========================================================================
find_browser() {
    local browser_cmds=()
    case "$OS_KERNEL" in
        Darwin) browser_cmds=("open") ;;
        MINGW*|MSYS*|CYGWIN*) browser_cmds=("start" "explorer") ;;
        *)
            browser_cmds=("xdg-open" "gio open" "gnome-open" "kde-open" "exo-open")
            for b in google-chrome chromium chromium-browser firefox brave-browser microsoft-edge midori; do
                command -v "$b" >/dev/null 2>&1 && browser_cmds+=("$b")
            done
            ;;
    esac
    local cmd
    for cmd in "${browser_cmds[@]:-}"; do
        [ -n "$cmd" ] || continue
        command -v "${cmd%% *}" >/dev/null 2>&1 && { echo "$cmd"; return 0; }
    done
    return 1
}

# ===========================================================================
# FAILURE DIAGNOSTICS
# ===========================================================================
diagnose_failure() {
    if grep -q "EADDRINUSE" "$SERVER_LOG" 2>/dev/null; then
        err "Port $PORT was grabbed by something else at the last second (race condition)."
        err "Fix: ./start.sh --port $((PORT + 1))"
    elif grep -q "EACCES" "$SERVER_LOG" 2>/dev/null; then
        err "Permission denied binding to port $PORT."
        err "Fix: use a port above 1024, or check firewall/antivirus rules."
    elif grep -qE "ENOTFOUND|ETIMEDOUT|ENETUNREACH" "$SERVER_LOG" 2>/dev/null; then
        err "Network error — npx couldn't reach the npm registry to fetch http-server."
        err "Fix: check your internet connection, proxy, or firewall (registry.npmjs.org)."
    elif grep -q "ENOENT" "$SERVER_LOG" 2>/dev/null; then
        err "A required file was missing. Try clearing the npx cache:"
        err "  npm cache clean --force"
    else
        err "Unrecognized failure. Full output:"
        echo "------------------------------------------------------------"
        cat "$SERVER_LOG" 2>/dev/null || true
        echo "------------------------------------------------------------"
    fi
}

# ===========================================================================
# MAIN
# ===========================================================================
header "Connectivity"
if check_internet; then
    ok "Internet reachable"
else
    warn "No internet detected. Fine if Node.js/http-server are already installed and cached."
fi

header "Project"
check_project
ok "Project root: $PROJECT_ROOT"

header "Dependencies"
ensure_node
ok "npm: $(npm --version 2>/dev/null || echo '?')"

header "Port"
if check_port "$PORT"; then
    ok "Port $PORT is available"
else
    warn "Port $PORT is already in use."
    if ALT_PORT="$(find_free_port "$((PORT + 1))")"; then
        warn "Using alternative port $ALT_PORT instead."
        PORT="$ALT_PORT"
    else
        if command -v lsof >/dev/null 2>&1; then
            pids="$(lsof -ti ":$PORT" 2>/dev/null || true)"
            [ -n "$pids" ] && warn "Process(es) holding port $PORT: $pids (try: kill $pids)"
        fi
        die "Could not find a free port near $PORT after 20 attempts."
    fi
fi

header "Server"
info "Starting HTTP server on port $PORT..."
info "Logging server output to $SERVER_LOG"

# Even though we just checked the port, another process could still grab it
# in the split second before we bind (TOCTOU race). diagnose_failure() below
# catches that via EADDRINUSE in the log rather than assuming the check was final.
npx --yes http-server "$PROJECT_ROOT" -p "$PORT" -a 127.0.0.1 --cors --cache -1 \
    > >(tee -a "$SERVER_LOG") 2>&1 &
SERVER_PID=$!

SERVER_READY=0
for attempt in 1 2 3 4 5; do
    sleep "$attempt"
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        wait "$SERVER_PID" 2>/dev/null || true
        err "http-server exited before becoming ready."
        diagnose_failure
        die "Server failed to start."
    fi
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --connect-timeout 2 "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && { SERVER_READY=1; break; }
    elif command -v wget >/dev/null 2>&1; then
        wget -q --timeout=2 "http://127.0.0.1:$PORT/" -O /dev/null 2>/dev/null && { SERVER_READY=1; break; }
    else
        SERVER_READY=1  # no probe tool available; process is alive, assume OK
        break
    fi
done

if [ "$SERVER_READY" -eq 0 ]; then
    diagnose_failure
    die "Server did not respond after multiple attempts. Check http://127.0.0.1:$PORT/ manually."
fi

ok "Server running (PID $SERVER_PID) at http://localhost:$PORT/"

header "Browser"
URL="http://localhost:$PORT/"
if [ "$NO_BROWSER" -eq 1 ]; then
    info "--no-browser set — skipping."
elif BROWSER_CMD="$(find_browser)"; then
    info "Opening browser via ${BROWSER_CMD%% *}..."
    if [[ "$BROWSER_CMD" == explorer ]]; then
        "$BROWSER_CMD" "http://127.0.0.1:$PORT/" 2>/dev/null || true
    else
        ${BROWSER_CMD} "$URL" 2>/dev/null || true
    fi
    ok "Browser opened."
else
    warn "Could not detect a browser opener. Open $URL manually."
fi

echo ""
printf "%b" "${C_BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}\n"
ok "Sentry Batch is running at ${C_BOLD}http://localhost:$PORT/${C_RESET}"
info "Press ${C_BOLD}Ctrl+C${C_RESET} to stop the server."
printf "%b" "${C_BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}\n"

wait "$SERVER_PID"
