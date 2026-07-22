#!/usr/bin/env bash
#
# start.sh — Launcher for Sentry Batch
# https://github.com/kamolkns/sentrybatch
#
# Sentry Batch is a browser-based SPA that uses ES modules and a Service
# Worker, so it must be served over HTTP (file:// will not work). This
# script ensures Node.js is available, serves the project root on port
# 8080 via http-server, and opens it in the default browser.

set -euo pipefail

# ---------------------------------------------------------------------------
# Colors (fall back to plain text if the terminal doesn't support them)
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
    C_RESET="\033[0m"
    C_BOLD="\033[1m"
    C_GREEN="\033[32m"
    C_YELLOW="\033[33m"
    C_RED="\033[31m"
    C_CYAN="\033[36m"
else
    C_RESET=""
    C_BOLD=""
    C_GREEN=""
    C_YELLOW=""
    C_RED=""
    C_CYAN=""
fi

info()  { printf "%b[*]%b %s\n" "${C_CYAN}"   "${C_RESET}" "$1"; }
ok()    { printf "%b[+]%b %s\n" "${C_GREEN}"  "${C_RESET}" "$1"; }
warn()  { printf "%b[!]%b %s\n" "${C_YELLOW}" "${C_RESET}" "$1"; }
err()   { printf "%b[x]%b %s\n" "${C_RED}"    "${C_RESET}" "$1" >&2; }

# ---------------------------------------------------------------------------
# 1. Always operate from the script's own directory so the HTTP server
#    serves the correct project root, regardless of invocation location.
# ---------------------------------------------------------------------------
cd "$(dirname "$0")"

printf "%b\n" "${C_BOLD}Starting Sentry Batch...${C_RESET}"

# ---------------------------------------------------------------------------
# 2. Ensure Node.js is installed. Install it automatically if missing.
# ---------------------------------------------------------------------------
install_node() {
    warn "Node.js not found. Attempting automatic installation..."

    local os
    os="$(uname -s 2>/dev/null || echo unknown)"

    if [ "$os" = "Darwin" ]; then
        # -------------------- macOS --------------------
        if ! command -v brew >/dev/null 2>&1; then
            info "Homebrew not found. Installing Homebrew first..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        fi
        info "Installing Node.js via Homebrew..."
        brew install node

    elif [ "$os" = "Linux" ]; then
        # -------------------- Linux --------------------
        if command -v pacman >/dev/null 2>&1; then
            info "Detected Arch Linux. Installing via pacman..."
            sudo pacman -S --noconfirm nodejs npm

        elif command -v apt >/dev/null 2>&1; then
            info "Detected Debian/Ubuntu. Installing via apt..."
            sudo apt update -qq && sudo apt install -y nodejs npm

        elif command -v dnf >/dev/null 2>&1; then
            info "Detected Fedora. Installing via dnf..."
            sudo dnf install -y nodejs npm

        elif command -v nix-env >/dev/null 2>&1; then
            info "Detected NixOS. Re-executing inside nix-shell with nodejs..."
            exec nix-shell -p nodejs --run "$0"

        else
            err "Unsupported OS. Please install Node.js manually from https://nodejs.org/"
            exit 1
        fi

    else
        err "Unsupported OS. Please install Node.js manually from https://nodejs.org/"
        exit 1
    fi
}

if ! command -v node >/dev/null 2>&1; then
    install_node

    if ! command -v node >/dev/null 2>&1; then
        err "Node.js installation failed or node is still not on PATH."
        err "Please install Node.js manually from https://nodejs.org/"
        exit 1
    fi

    ok "Node.js installed successfully."
else
    ok "Node.js found: $(node --version)"
fi

# ---------------------------------------------------------------------------
# 3. Start the HTTP server (port 8080 — matches the project's .bat launcher)
# ---------------------------------------------------------------------------
info "Launching HTTP server on port 8080..."

npx --yes http-server -p 8080 &
SERVER_PID=$!

# Basic sanity check that the process actually started
sleep 1
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    err "Failed to start http-server. Check the output above for details."
    exit 1
fi

ok "Server running (PID $SERVER_PID) at http://localhost:8080/"

# ---------------------------------------------------------------------------
# 4. Wait for the server to come up, then open the browser
# ---------------------------------------------------------------------------
info "Waiting for server to become ready..."
sleep 3

URL="http://localhost:8080/"

if command -v xdg-open >/dev/null 2>&1; then
    info "Opening browser via xdg-open..."
    xdg-open "$URL" 2>/dev/null || true
elif command -v open >/dev/null 2>&1; then
    info "Opening browser via open..."
    open "$URL" 2>/dev/null || true
else
    warn "Open $URL in your browser."
fi

ok "Sentry Batch is running. Press Ctrl+C to stop the server."

# ---------------------------------------------------------------------------
# 5. Keep the script alive so the server keeps running until interrupted
# ---------------------------------------------------------------------------
wait "$SERVER_PID"
