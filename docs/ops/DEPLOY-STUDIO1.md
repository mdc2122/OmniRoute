---
title: "deploy/studio1 fork deploy branch"
version: 3.8.52
lastUpdated: 2026-10-20
---

# `deploy/studio1`: fork-only deploy branch

This branch is the OmniRoute build that one self-hosted gateway runs. It is never opened as an upstream pull
request. Operational details (host, service, backups, verification) live in the operator's private homelab
runbook, not here.

## What this branch carries on top of upstream `release/v3.8.52`

| Commit subject (prefix)                                                    | Why                                                                                                                                                              |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy-build: Muse (PR15234 ...) + Cursor (PR15024)`                      | Muse two-account rotation with caller-bound reasoning ownership, the OAuth `/responses` URL fix, health-aware session claiming; Cursor `cursor-api` live catalog |
| `deploy-build: floor tiny Muse output budgets`                             | Muse spends small output budgets entirely on hidden reasoning and returns empty                                                                                  |
| `deploy-build: same-owner retry for empty Muse responses`                  | Muse sometimes answers 200 with no output; retry on the owning account                                                                                           |
| `deploy-build: keep Muse empty-response flakes from locking out the owner` | Empty-response flakes must not cool down the account                                                                                                             |
| `fix(cursor): keep composer turns open across KV saves ...` (#15261)       | Composer tool calls; merged upstream after the v3.8.52 cut. Drop this on a rebase onto a release that contains it                                                |
| `deploy-build: register Muse Wonder ids with the Responses format`         | Stock upstream v3.8.52 sends unlisted `muse-wonder-*` ids a chat-completions body on `/responses` (HTTP 400). Keep until upstream registers Wonder               |

## Rules

- Never install stock `omniroute` from npm on the deploy host; it silently drops every commit above.
  That happened once (stock v3.8.52 installed 2026-10-19) and broke Muse Wonder.
- A new deploy: commit on top of this branch, push it plus a tag `deploy-studio1-YYYYMMDD-<shortsha>`,
  then build from that tag with `npm ci && npm run build:release && npm pack`. `dist/BUILD_SHA` must equal the
  tag's short SHA.
- Rebasing onto a newer upstream release: keep each commit above unless that release already contains it, then
  run the focused tests before building:

  ```sh
  node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts \
    --test --test-force-exit tests/unit/muse-code-models.test.ts tests/unit/muse-code-provider.test.ts \
    tests/unit/muse-code-responses-url.test.ts tests/unit/muse-session-ownership.test.ts \
    tests/unit/muse-empty-response-retry.test.ts tests/unit/cursor-composer-kv-toolcall-race.test.ts
  ```
