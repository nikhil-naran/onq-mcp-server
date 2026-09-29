# Preparation validation

## Windows-hosted original-file delivery

Validated in a Linux workspace with Node 24.19.0:

- `npm run build` and `npm run check`: passed, including 1,083 tests across 203 files, TypeScript, lint and dependency architecture checks. The same three existing lint warnings remain.
- `npm run test:ci`: passed with coverage gates satisfied (88.31% statements, 91.11% lines before the final error-message and connection-close refinements; the complete check passed again afterward).
- Local HTTP tests cover exact bytes, checksums, Unicode filenames, HEAD, ranges, expiry, reservations, capacity, invalid requests and shutdown. MCP tests cover all five original-file sources and files above the inline limit.
- The synthetic two-page PDF was fetched through the loopback endpoint, matched its SHA-256, and parsed with the expected final-page text. This is not a public-tunnel or phone acceptance result.
- The configuration helper preserved existing authentication and write settings, created a backup and rejected an invalid URL without changing the configuration.
- `git diff --check` and JavaScript helper syntax/lint checks: passed.

PowerShell scripts were reviewed but not executed on Windows. Cloudflare login, DNS, startup tasks, public HTTPS reachability and ChatGPT mobile download/image reading remain the acceptance steps in [DOWNLOADS.md](DOWNLOADS.md). The feature is opt-in and no live endpoint was deployed during this validation.

## Earlier preparation

Validated locally on macOS with Node 24.16.0 after integrating upstream v1.3.1.

- `npm run check`: passed (lint, TypeScript, tests, dependency architecture).
- `npm ci --ignore-scripts --no-audit --no-fund` and `npm run build`: passed from the merged lockfile.
- 1,062 tests passed across 200 files, including mock D2L end-to-end tests and the Queen's-specific adaptation tests.
- Lint reported three existing unused-disable warnings and no errors.
- `git diff --check`: passed.
- Real PDF parser/render smoke: a sparse one-page PDF returned a valid PNG preview.
- `node scripts/verify-agenda.mjs`: passed data delivery, course/type filters, partial-data warning, empty state, mobile width and browser-console checks.
- Desktop and mobile dark screenshots inspected. Sample course data is labeled and appears only in the verification script/screenshots, not in the product.

Mock D2L end-to-end tests exercise stdio MCP. They do not establish Queen’s tenant permissions, browser SSO reliability, or actual ChatGPT UI compatibility. PowerShell scripts were reviewed but were not executed on Windows. Tunnel binary initialization, live login, DPAPI round-trip, task registration, and startup recovery remain in the Windows acceptance checklist.

The source package excludes dependencies, private profiles, API keys, and local verification artifacts. Setup installs Windows dependencies from the lockfile. Live Queen's API responses and the Windows update still need verification after this branch is pulled on Windows.
