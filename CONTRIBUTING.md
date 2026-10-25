# Contributing

Use a feature or fix branch and open a pull request. `main` requires the **CI result** check; do not bypass it. Keep changes focused and describe the problem, resulting behavior, validation and compatibility limits.

Follow the development commands in [README.md](README.md#develop-and-validate). Code, dependency and workflow changes require TypeScript checks, formatting, engine tests, UI tests, Rust tests, a Windows build and the installed-app smoke test. Documentation-only changes use the lightweight checks enforced by the same gate.

Use temporary directories and simulated bulbs for automated tests. Never commit real setup codes, controller stores, logs, Wi-Fi details or user-specific configurations. `npm run check:public` inspects tracked source for obvious private paths and credential patterns; review the full diff too. It is not a complete secret scanner.

Configuration changes must preserve stable lamp IDs and pairings. Update the native host, shared parser, example, schema and migration tests together. Never change the app identifier or Matter controller ID as a migration shortcut.

For a release, update the package, lockfile, Cargo and Tauri versions on a PR. Wait for required checks on final source, merge without bypasses, tag the verified merge commit and create a matching GitHub Release. Attach the installer from successful main-commit CI and its SHA-256 file. Mark alpha/beta/RC versions as prereleases. GitHub Releases do not publish npm packages.

GitHub normalizes whitespace in uploaded asset names. Align `SHA256SUMS.txt` with the final public filenames and verify that the downloaded installer bytes still match the tested CI artifact.
