# Preparation validation

Validated locally on macOS with Node 24.16.0 before Windows handoff.

- `npm run check`: passed (lint, TypeScript, tests, dependency architecture).
- 754 tests passed across 169 files, including 12 new adaptation/PDF tests.
- Lint reported three existing unused-disable warnings and no errors.
- `git diff --check`: passed.
- Real PDF parser/render smoke: a sparse one-page PDF returned a valid PNG preview.
- `node scripts/verify-agenda.mjs`: passed data delivery, course/type filters, partial-data warning, empty state, mobile width and browser-console checks.
- Desktop and mobile dark screenshots inspected. Sample course data is labeled and appears only in the verification script/screenshots, not in the product.

Mock D2L end-to-end tests exercise stdio MCP. They do not establish Queen’s tenant permissions, browser SSO reliability, or actual ChatGPT UI compatibility. PowerShell scripts were reviewed but were not executed on Windows. Tunnel binary initialization, live login, DPAPI round-trip, task registration, and startup recovery remain in the Windows acceptance checklist.

The source package excludes dependencies, private profiles, API keys, and local verification artifacts. Setup installs Windows dependencies from the lockfile. No changes were pushed to GitHub and no external service was deployed.
