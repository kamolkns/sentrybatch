# Contributing to Sentry Batch

## Reporting Bugs

Open a GitHub Issue with:

- A clear title and description
- Steps to reproduce
- Expected vs actual behavior
- Browser and OS version
- Console errors (if any)

## Requesting Features

Open a GitHub Issue with:

- The problem you're trying to solve
- How the feature would work
- Any relevant examples or references

## Pull Requests

1. Fork the repository and create a branch from `main`.
2. Make your changes. Keep them focused — one change per PR.
3. Run a local HTTP server and verify the application loads without console errors.
4. If your change adds a new dependency, update the Acknowledgments section in README.md.
5. Open a PR against `main` with a clear description of what changed and why.

## Coding Style

- Follow the existing code style in the file you're editing.
- No semicolons where the project omits them. No trailing commas.
- Use descriptive variable names — prefer `ip` over `x`, `riskLabel` over `rl`.
- Keep functions small and focused.

## Testing

The project does not currently have an automated test suite. Test your changes manually:

1. Start `python -m http.server 8080` in the project root.
2. Open `http://localhost:8080/launcher.html`.
3. Verify the feature works and no regressions are visible in the browser console.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
