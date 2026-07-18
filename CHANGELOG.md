# Changelog

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
