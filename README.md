# Sentry Batch

Bulk IP reputation and threat intelligence console. Analyze hundreds of IP addresses through VirusTotal, AbuseIPDB, and open-source threat intelligence feeds in a single browser-based desktop tool.

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

- **Python 3** (for the included local HTTP server) or any HTTP server of your choice
- A modern **browser** with ES module and Service Worker support

### Browser Compatibility

| Browser | Supported | Notes |
|---------|-----------|-------|
| Chrome 89+ | Yes | Full support |
| Edge 89+ | Yes | Full support |
| Firefox 90+ | Yes | Full support |
| Safari 15+ | Yes | Limited Service Worker caching |
| Opera 75+ | Likely | Not regularly tested |
| Internet Explorer | No | Not supported |

## Getting Started

### Running Locally

1. Start a local HTTP server in the project directory:

   ```powershell
   python -m http.server 8080
   ```

2. Open `http://localhost:8080/launcher.html` in your browser.

   Alternatively, double-click **Open Sentry Batch.bat** (Windows) which starts the server and opens the launcher automatically.

### Why launcher.html?

Sentry Batch uses ES modules (`<script type="module">`), which are blocked by browsers when loading pages via the `file://` protocol. The launcher sets a sessionStorage flag and redirects to `index.html`, where `guard.js` checks for that flag. If you open `index.html` directly, the guard redirects to a helpful message explaining how to launch the application correctly.

### Configuration

1. Open the **Settings** panel.
2. Enable **VirusTotal** and/or **AbuseIPDB** via their toggle switches.
3. Paste your API keys into the corresponding fields.
4. Set a **CORS proxy prefix** if needed (see note below).
5. Click **Test** to verify connectivity.

> **Browser CORS note:** VirusTotal and AbuseIPDB do not send CORS headers, so browsers block direct `fetch()` calls from a page loaded via `http://`. You'll see "Blocked by browser (CORS)" even with a valid key. Fix it by setting a CORS proxy prefix in Settings — either a public proxy like `https://corsproxy.io/?url=` (quick testing only) or a self-hosted proxy (recommended for production).

## Project Structure

```
.
├── index.html              # Main application entry point (routed via launcher)
├── launcher.html           # Bootstrapper that sets launch context
├── guard.js                # Launch guard — prevents direct file:// access
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

## License

MIT — see `LICENSE` for details.
