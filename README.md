# Sentry Batch

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub release](https://img.shields.io/badge/release-v1.0.0-blue)](https://github.com/kamolkns/sentrybatch/releases)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES%20Modules-yellow)](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

Bulk IP reputation and threat intelligence console. Analyze hundreds of IP addresses through VirusTotal, AbuseIPDB, and open-source threat intelligence feeds in a single browser-based desktop tool.

## Prerequisites

[Python 3.10 or newer](https://www.python.org/downloads/) is required to run the local HTTP server.

## Features

- **Batch IP analysis** — Process up to 1,000 IPs per run with configurable batch sizes and concurrency
- **Multi-source enrichment** — VirusTotal, AbuseIPDB, AlienVault OTX, ThreatFox, geolocation, and RDAP/WHOIS
- **Risk scoring** — Weighted score combining VT detection ratio, AbuseIPDB confidence, and reputation metrics
- **Rich visualizations** — Doughnut/bar charts, world map, risk heatmap, ASN/country/provider timelines
- **Multiple export formats** — CSV, JSON, HTML, PDF, Markdown, STIX 2.1, OpenIOC
- **Analyst workspace** — Per-IP notes, tagging, custom filters, column visibility, saved searches
- **Session persistence** — Save/load sessions, cache management, auto-resume
- **Offline-capable** — Service worker caches app shell for repeat launches
- **Launch guard** — Prevents accidental direct file:// access that breaks ES module imports

## Screenshots

*(Screenshots to be added.)*

## Requirements

- **Windows 10 or Windows 11**
- **Python 3.10 or newer**
- A modern **Chromium-based browser** (Chrome, Edge, Brave, etc.)

## Getting Started

### Installation

1. Download and install Python from the official website:

   https://www.python.org/downloads/

2. During installation, enable:

   ✓ Add Python to PATH

3. Verify installation by opening Command Prompt and running:

   ```powershell
   python --version
   ```

   A version number should be displayed.

### Starting Sentry Batch

Launch the application using:

    Open Sentry Batch.bat

The launcher will:

- start the local HTTP server
- wait until the server is ready
- automatically open the application in the browser

### Opening the app

Open `index.html` via an HTTP server (see [Open Sentry Batch.bat](Open%20Sentry%20Batch.bat) or run `npx http-server -p 8080`). The app must be served over HTTP for ES modules and the Service Worker to work.

### Configuration

1. Open the **Settings** panel.
2. Enable **VirusTotal** and/or **AbuseIPDB** via their toggle switches.
3. Paste your API keys into the corresponding fields.
4. Set a **CORS proxy prefix** if needed (see note below).
5. Click **Test** to verify connectivity.

> **Browser CORS note:** VirusTotal and AbuseIPDB do not send CORS headers, so browsers block direct `fetch()` calls from a page loaded via `http://`. You'll see "Blocked by browser (CORS)" even with a valid key. Fix it by setting a CORS proxy prefix in Settings — either a public proxy like `https://corsproxy.io/?url=` (quick testing only) or a self-hosted proxy (recommended for production).

### Troubleshooting

#### Python is not installed

If the launcher reports that Python could not be started, install Python from:

https://www.python.org/downloads/

Make sure "Add Python to PATH" was enabled during installation.

#### Port 8080 already in use

If another application is using port 8080, close that application and launch Sentry Batch again.

#### Windows Firewall

The application uses only localhost (127.0.0.1) and does not expose the server to the Internet.

### Notes

- The built-in Python HTTP server is only used to serve local application files.
- No backend service is required.
- No data is uploaded to external servers except the threat intelligence APIs configured by the user.

## Project Structure

```
.
├── index.html              # Main application entry point (routed via launcher)

├── main.js                 # Core application logic and application controller
├── api.js                  # HTTP request layer with timeout
├── utils.js                # Shared utility functions
├── cache.js                # localStorage cache with LRU eviction
├── charts.js               # Chart visualization helpers
├── config.js               # Application configuration constants
├── intelligence.js         # AlienVault OTX / ThreatFox integration
├── parser.js               # IP list parser (CIDR, ranges, comments, dedup)
├── table.js                # Virtual-scrolled table renderer
├── ui.js                   # UI utilities and components
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
├── Open Sentry Batch.bat   # Windows launcher script
├── assets/                 # Static assets (icons, images)
├── docs/                   # Documentation
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
- **CORS proxy may be required** — VirusTotal and AbuseIPDB do not send browser CORS headers. A CORS proxy (public or self-hosted) is needed when running from `http://localhost`. See Configuration above.
- **Modern browser required** — The application uses ES modules, Service Workers, and other modern web APIs. Internet Explorer and older browsers are not supported.
- **Maximum 1,000 IPs per batch** — Input lists exceeding 1,000 unique entries are truncated to the first 1,000.
- **Domains are resolved before checking** — Domain analysis resolves to an IP first. The IP is then checked against threat feeds. Domain-only intelligence (e.g., WHOIS) is not collected.

## Acknowledgments

Sentry Batch uses data and services from:

- **[VirusTotal](https://www.virustotal.com)** — Threat intelligence and detection engine
- **[AbuseIPDB](https://www.abuseipdb.com)** — IP reputation and abuse reporting
- **[AlienVault OTX](https://otx.alienvault.com)** — Open threat exchange pulse data
- **[ThreatFox](https://threatfox.abuse.ch)** — Malware indicator sharing platform
- **[ipapi.co](https://ipapi.co)** — IP geolocation data
- **[Google Public DNS](https://developers.google.com/speed/public-dns)** — DNS-over-HTTPS resolution
- **[Chart.js](https://www.chartjs.org)** — Visualization library

## License

MIT — see `LICENSE` for details.
