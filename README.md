# Sentry Batch

This version uses browser ES modules. Serve this folder over a local web server instead of opening `v1.html` directly from the file system.

If Python is installed, run this command in the project folder:

```powershell
python -m http.server 8080
```

Then open `http://localhost:8080/v1.html`.

## Security behavior

- VirusTotal and AbuseIPDB keys are stored in `sessionStorage` only and disappear when the browser session ends.
- Legacy persistent copies of those keys are removed on first load.
- The page uses a Content Security Policy and verifies its pinned Chart.js script with Subresource Integrity.
