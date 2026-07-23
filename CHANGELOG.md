# Changelog

## 1.2.0 — 2026-07-23

### Added
- Comprehensive Windows launcher (`Open Sentry Batch.bat`) with auto-install via winget, Chocolatey, or direct MSI download.
- Cross-platform Linux/macOS launcher (`start.sh`) supporting apt, pacman, dnf, yum, zypper, brew, macports, nix, apk, portage, and winget.
- Port conflict detection with automatic fallback to next available port.
- Server health checks via HTTP probe (curl/wget) instead of blind sleep.
- Internet connectivity check before installing dependencies.
- Browser auto-detection across all platforms.
- Signal handling and cleanup trap for graceful shutdown.
- Argument parsing (`--port`, `--log`, `--help`) for both launchers.
- Minimum Node.js version enforcement (v18+).
- Architecture-aware installer selection (x64, ARM64, x86).

### Changed
- VT usage counter now only increments after successful API responses (not on 401/403).
- `apiFetch` now forwards `method`, `body`, and `proxyPrefix` options to `request`.
- Service worker APP_SHELL includes `favicon.ico` and `icon-180.png` for full offline coverage.
- Service worker cache keys now match HTML references (removed `?v=` params from HTML).
- Strictened domain validation — requires minimum 2-char TLD, rejects leading-digit labels.
- `extractHostname` strips port numbers from bare IP:port inputs.
- Session loading validates IP addresses before inserting into results.
- Filter pill click handler scoped to table toolbar to avoid conflicts with tag pills.

### Fixed
- VT daily quota incorrectly incremented on auth failures (401/403).
- `retrySingle` now accepts abort signal for stop-button cancellation.
- VirusTotal passive DNS fallback now checks response status before parsing JSON.
- Country display no longer shows mojibake characters from Latin-1 encoding artifacts.

## 1.1.1 — 2026-07-20

### Added
- Linux/macOS launcher script (`start.sh`) with automatic Node.js detection and installation.
- Windows batch launcher (`Open Sentry Batch.bat`) with Node.js check and browser launch.
- Multi-architecture icon set (16px to 512px) for PWA and platform integration.
- This CHANGELOG and SECURITY.md for project governance.

### Changed
- Moved to ES module architecture with `import`/`export` across all JS files.
- Cleared dead code: removed `charts.js`, `table.js`, `ui.js`, `guard.js`, unused HTML templates.
- Simplified project structure by consolidating into root directory.
- Updated README, CONTRIBUTING, CODE_OF_CONDUCT, and LICENSE to match v1.1 release.
- Service worker APP_SHELL aligned with current file list.
- All DNS-over-HTTPS calls now go through the CORS proxy for reliability.
- Rate-limit handling improved for both VT public and premium tiers.

### Fixed
- DNS resolution fallback chain: Google → Cloudflare → Quad9 → VT passive DNS for dead domains.
- IPv4-mapped IPv6 addresses not being recognized as valid IPs.
- CORS proxy now properly encodes target URLs per RFC 3986.

## 1.0.0 — 2026-07-18

### Added
- Initial release of Sentry Batch — bulk IP reputation and threat intelligence console.
- Multi-source enrichment: VirusTotal, AbuseIPDB, AlienVault OTX, ThreatFox, geolocation, RDAP/WHOIS.
- Risk scoring engine with visual risk-level indicators.
- Batch processing with configurable concurrency, pause/resume/stop.
- Launch guard to prevent direct `file://` access.
- Service worker for offline app-shell caching.
- Virtual-scrolled results table with sort, filter, search, and column visibility controls.
- Rich visualizations: charts (doughnut, bar), interactive world map, risk heatmap, ASN/country/provider timelines.
- Export formats: CSV, JSON, HTML, PDF, Markdown, STIX 2.1, OpenIOC.
- Analyst workspace with per-IP notes, tags, custom filters, and saved searches.
- Session save/load with history (last 10 sessions).
- Theme support (dark/light) with system preference detection.
- CORS proxy configuration for browser-based API access.
- Keyboard shortcuts: Ctrl+Enter (start), Ctrl+S (export CSV), Ctrl+F (search), Escape (stop).
- Settings import/export and cache management.

### Changed
- Complete UI redesign with professional dark/light palettes, compact spacing, and monospace data presentation.
- All empty-state messages replaced with actionable, analyst-oriented language.
- Log messages rewritten for operational clarity and lifecycle tracking.
- Renamed `v1.html` to `index.html` and updated all internal references.
- Project structure organized with `assets/`, `docs/`, `examples/` directories.
- Added CHANGELOG.md, LICENSE (MIT), SECURITY.md, and full project README.

### Fixed
- Column visibility sync on import — hidden columns persist correctly across sessions.
- Sort handler uses `th[data-key]` selector for reliable column sorting.
- Service worker APP_SHELL now includes `guard.js` and `utils.js` for reliable offline caching.
- All configuration references updated to use `index.html` (launcher, SW, manifest, docs).
