# Sentry Batch

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub release](https://img.shields.io/badge/release-v1.2.0-blue)](https://github.com/kamolkns/sentrybatch/releases)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES%20Modules-yellow)](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

Bulk IP reputation and threat intelligence console. Analyze hundreds of IP addresses through VirusTotal, AbuseIPDB, and open-source threat intelligence feeds in a single browser-based desktop tool.

## Prerequisites

[Node.js](https://nodejs.org/) is required to run the local HTTP server via `npx http-server`.

## Features

- **Batch IP analysis** — Process up to 1,000 IPs per run with configurable batch sizes and concurrency
- **Multi-source enrichment** — VirusTotal, AbuseIPDB, AlienVault OTX, ThreatFox, geolocation, and RDAP/WHOIS
- **Risk scoring** — Weighted score combining VT detection ratio, AbuseIPDB confidence, and reputation metrics
- **Rich visualizations** — Doughnut/bar charts, world map, risk heatmap, ASN/country/provider timelines
- **Multiple export formats** — CSV, JSON, HTML, PDF, Markdown, STIX 2.1, OpenIOC
- **Analyst workspace** — Per-IP notes, tagging, custom filters, column visibility, saved searches
- **Session persistence** — Save/load sessions, cache management, auto-resume
- **Offline-capable** — Service worker caches app shell for repeat launches
- **Launch guard** — Detects `file://` access and warns you to use the HTTP server instead

## Screenshots

*(Screenshots to be added.)*

## Requirements

- **Node.js** (for the local HTTP server)
- A modern **Chromium-based browser** (Chrome, Edge, Brave, etc.)

## Getting Started

### Quick Start

**Windows:** Double-click `Open Sentry Batch.bat`

**Linux / macOS:**

```bash
chmod +x start.sh
./start.sh
```

The launcher will:
- detect your OS and package manager
- auto-install Node.js v18+ if missing (via winget, Chocolatey, apt, pacman, dnf, brew, or direct download)
- verify npm/npx are available
- check internet connectivity
- find a free port (default 8080, falls back if busy)
- start the local HTTP server
- probe the server until it responds
- open the application in your default browser

**Manual start** (if you prefer not using the launcher):

```bash
npx --yes http-server -p 8080
```

Then open `http://localhost:8080/` in your browser.

### Configuration

1. Open the **Settings** panel.
2. Enable **VirusTotal** and/or **AbuseIPDB** via their toggle switches.
3. Paste your API keys into the corresponding fields.
4. Click **Test** to verify connectivity.

> **CORS note:** VirusTotal and AbuseIPDB do not send CORS headers, so browsers block direct `fetch()` calls from `http://localhost`. Sentry Batch has a built-in CORS proxy (`https://corsproxy.io`) — no additional configuration is needed.

### Troubleshooting

#### Node.js is not installed

Both launchers will auto-install Node.js v18+ using your system's package manager or direct download. If automatic installation fails, install manually from https://nodejs.org/

#### Port 8080 already in use

The launcher will automatically detect this and try the next available port (8081, 8082, etc.). You can also specify a custom port:

```bash
./start.sh --port 9090
```

#### Windows Firewall

The application uses only localhost (127.0.0.1) and does not expose the server to the Internet.

### Notes

- The HTTP server is only used to serve local application files.
- No backend service is required.
- No data is uploaded to external servers except the threat intelligence APIs configured by the user.

## Project Structure

```
.
├── index.html              # Main application entry point
├── main.js                 # Core application logic and application controller
├── api.js                  # HTTP request layer with timeout
├── cache.js                # localStorage cache with LRU eviction
├── config.js               # Application configuration constants
├── intelligence.js         # AlienVault OTX / ThreatFox integration
├── parser.js               # IP list parser (CIDR, ranges, comments, dedup)
├── workflow.js             # File I/O, JSON helpers, and session persistence
├── sw.js                   # Service worker for offline app-shell caching
├── manifest.webmanifest    # Progressive Web App manifest
├── icon.svg                # Application icon (SVG)
├── favicon.ico             # Favicon (legacy browsers)
├── CHANGELOG.md
├── LICENSE
├── SECURITY.md
├── VERSION                 # Release version identifier
├── .gitignore
├── start.sh                # Linux/macOS launcher script
├── Open Sentry Batch.bat   # Windows launcher script
└── examples/               # Example input files
    └── sample_ips.txt
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Start batch processing |
| `Ctrl+S` | Export results as CSV |
| `Ctrl+F` | Focus search box |
| `Escape` | Stop batch processing |

## Security

- API keys are stored in `sessionStorage` only and are cleared when the browser tab closes.
- Legacy persistent key copies in `localStorage` are removed on first load.
- The page enforces a Content Security Policy and verifies third-party scripts with Subresource Integrity.
- All API/proxy requests bypass the service worker cache — no credentials are stored offline.
- See `SECURITY.md` for the full security policy and vulnerability reporting process.

## Limitations

- **Internet connection required** — All analysis is performed via live API calls. No results are available offline.
- **API rate limits apply** — VirusTotal's public tier allows 4 requests/minute (500/day). AbuseIPDB's free tier allows 1,000 checks/day. Premium tiers remove or raise these limits.
- **CORS proxy required** — VirusTotal and AbuseIPDB do not send browser CORS headers. Sentry Batch includes a built-in CORS proxy (`corsproxy.io`) — no user configuration is needed.
- **Modern browser required** — The application uses ES modules, Service Workers, and other modern web APIs. Internet Explorer and older browsers are not supported.
- **Maximum 1,000 IPs per batch** — Input lists exceeding 1,000 unique entries are truncated to the first 1,000.
- **Domains are resolved before checking** — Domain analysis resolves to an IP first via DNS-over-HTTPS (Google, Cloudflare, Quad9). If live DNS fails, VirusTotal passive DNS is used as a fallback to resolve dead domains to their last known IPs.

## Acknowledgments

Sentry Batch uses data and services from:

- **[VirusTotal](https://www.virustotal.com)** — Threat intelligence and detection engine
- **[AbuseIPDB](https://www.abuseipdb.com)** — IP reputation and abuse reporting
- **[AlienVault OTX](https://otx.alienvault.com)** — Open threat exchange pulse data
- **[ThreatFox](https://threatfox.abuse.ch)** — Malware indicator sharing platform
- **[ipapi.co](https://ipapi.co)** — IP geolocation data
- **[Google Public DNS](https://developers.google.com/speed/public-dns)** — DNS-over-HTTPS resolution
- **[Cloudflare DNS](https://cloudflare-dns.com)** — DNS-over-HTTPS resolution (fallback)
- **[Quad9 DNS](https://quad9.net)** — DNS-over-HTTPS resolution (fallback)
- **[Chart.js](https://www.chartjs.org)** — Visualization library

## License

MIT — see `LICENSE` for details.
