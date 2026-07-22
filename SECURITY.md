# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.1.x   | Yes       |

## Reporting a Vulnerability

Vulnerabilities can be reported by opening a GitHub Issue on the repository. Please include:

- A description of the issue
- Steps to reproduce
- The potential impact

You should receive a response within 48 hours. If the issue is confirmed, a fix will be released as soon as possible depending on severity.

## Security Practices

- **API keys** are stored in `sessionStorage` only and are never written to disk or `localStorage`.
- **Legacy key cleanup** — any previously stored API keys in `localStorage` are removed on application startup.
- **Content Security Policy** — the application enforces a strict CSP that restricts script sources, form actions, and frame ancestors.
- **Subresource Integrity** — third-party scripts (Chart.js) are loaded with SRI hashes to prevent supply-chain tampering.
- **Service worker isolation** — the service worker caches only the app shell and static assets. All API, proxy, and external requests bypass the cache entirely, ensuring no credentials are stored offline.
- **No telemetry** — the application makes no network calls beyond the configured APIs and CORS proxy. No analytics, no tracking.
