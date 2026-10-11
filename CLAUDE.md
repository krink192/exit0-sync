# exit0-sync: notes for Claude

Self-hosted sync server for exit 0. Public, AGPL-3.0-or-later. Sole copyright holder: krink192.

## Layout
- `bin/exit0-sync.js`: CLI (serve, user add/passwd/list/delete, devices, backup)
- `src/server.js`: HTTP routing, protocol v1, static file serving, CORS, body limits
- `src/store.js`: all SQL (users, devices, packs/epochs, replicas)
- `src/db.js`: node:sqlite open + migrations (append to MIGRATIONS, never edit an old entry)
- `src/auth.js`: scrypt hashing, tokens, rate limiter
- `test/`: `node:test` suites; `npm test`

## Rules
- Zero runtime dependencies. Node built-ins only (node:http, node:sqlite, node:crypto).
- Every feature gets a test. CI runs Node 22 and 24, plus a Docker build and smoke test.
- The server never interprets replica docs. Merge logic belongs in the app (exit0-linux-essentials `docs/js/core.js`).
- Protocol changes must stay backward compatible with protocol 1 or bump `protocol` in `/v1/health`.
- Paid features (billing, Teams, hosted accounts, entitlements) do NOT go here; they live in the private exit0-cloud repo.
- Never copy third-party GPL/AGPL code into exit0-cloud. Flag any outside contribution to this repo before code from it is reused privately.
- Secrets never go in git. No credentials in tests beyond throwaway strings.
