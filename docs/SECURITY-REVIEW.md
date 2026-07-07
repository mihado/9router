# 9router Security Review (hardened fork)

This is a **hardened downstream fork** of [`decolua/9router`](https://github.com/decolua/9router).
We self-build and publish our own image (`ghcr.io/mihado/9router:hardened`) from the `hardened` branch
and run it internally behind Traefik. This document records the security review that justified the fork,
the changes we made, the risks we accepted, and — most importantly — the **checklist to re-run every time
we sync from upstream**.

> Review date: 2026-07-01 · Reviewed at upstream version `0.5.15` (commit `0b3c794`). Last hardened: 2026-07-01.
> Re-checked: 2026-07-03, rebased onto upstream `0.5.18` (commit `7f436e2`). No regressions found — see
> "Upstream-sync re-check log" below.
> Ship-readiness pass: 2026-07-04 — added security response headers, fixed stale `DOCKER.md`,
> ran `pnpm audit` and the observability sweep recorded under "Accepted residual risks" below.
> Re-checked: 2026-07-08, rebased onto upstream `0.5.20` (commit `b10b807`) via the `capabilities`
> feature branch. No regressions found — see "Upstream-sync re-check log" below.

## Why a fork

9router is an LLM proxy that stores OAuth tokens and API keys for Claude Code, Codex, GitHub Copilot,
Cursor, GLM, MiniMax, etc. in a local SQLite DB. It runs on our edge router. We needed to vet the code
before trusting it with those credentials and to remove always-on third-party egress.

**Overall verdict:** No backdoor and **no exfiltration of secrets/prompts/source to `9router.com`** was
found. The "cloud" feature is an opt-in routing toggle (off by default), not a secret-upload sync. The
real issues are insecure defaults and always-on egress beacons — addressed below.

## Findings

| # | Sev | Finding | Status in this fork |
|---|-----|---------|---------------------|
| 1 | 🔴 CRIT | Dashboard password defaults to `123456` when `INITIAL_PASSWORD` unset; the DB-export endpoint (`/api/settings/database`) re-checks the *same* password and returns **all provider tokens in cleartext**, with no rate limit on the export password header. (`src/app/api/auth/login/route.js`, `src/lib/auth/dashboardSession.js:75-82`, `src/app/api/settings/database/route.js:16`) | **Fixed in source** — `"123456"` fallback removed. `INITIAL_PASSWORD` is now mandatory. Bootstrap login forces a permanent password set. Login page no longer discloses the default. The DB-export rate-limit gap remains. |
| 2 | 🟠 HIGH | Any caller reaching `127.0.0.1:20128` is treated as "local" and gets **unauthenticated** full proxy access to all provider credentials (`src/dashboardGuard.js:136`). Remote callers via Traefik correctly require an API key. | **Fixed in source for deployed surfaces** — loopback bypass removed from `/v1*` access in `dashboardGuard.js`. Retained CLI-token-gated local surfaces stay in tree as a merge-hygiene compromise but are inaccessible in the current Docker deployment (machine-ID mismatch between host and container). `REQUIRE_API_KEY=true` remains recommended as defense in depth. |
| 3 | 🟠 HIGH | Hardcoded Google Analytics (`G-LC959F603F`) loaded on every dashboard page, no env toggle (`src/app/layout.js`). | **Fixed in source** — GA import + element removed; `@next/third-parties` dropped from deps. |
| 4 | 🟠 HIGH | cloudflared binary auto-downloaded from GitHub at boot, unconditionally (even with tunnels disabled), no checksum/signature verify (`src/shared/services/initializeApp.js:79` → `src/lib/tunnel/cloudflare/cloudflared.js`). | **Fixed in source** — entire tunnel subsystem removed (cloudflared + tailscale): `src/lib/tunnel/`, `src/app/api/tunnel/`, `appUpdater.js`, `/api/version/update`. The edge router's own Cloudflare tunnel (separate `cloudflared` service in the deployment repo) is unrelated. |
| 5 | 🟠 HIGH | SSRF guard is string-only — no DNS resolution / IP-pinning, so DNS-rebinding, 302-redirects, decimal-IP (`2130706433`), and some IPv6 forms bypass it (`src/shared/utils/ssrfGuard.js`). Applies to the auth-gated web-fetch tool (`src/sse/handlers/fetch.js`). | **Accepted / mitigated by config** — gated behind `REQUIRE_API_KEY=true` + don't expose the proxy to untrusted clients + egress-filter the router. No source fix yet. |
| 6 | 🟡 MED | Provider access/refresh tokens + API keys stored **plaintext** in SQLite `providerConnections.data`; DB export returns them in clear (`src/lib/db/repos/connectionsRepo.js`). | **Accepted** — treat the `9router-data` volume and any DB export as secret material (disk encryption / restrictive perms). No app-level at-rest encryption exists. |
| 7 | 🟡 MED | `API_KEY_SECRET` / `MACHINE_ID_SALT` ship as known default strings in `.env.example`. (Not directly forgeable — keys are validated by DB lookup, not CRC — but should be unique.) | Mitigated by **deploy config**: set unique values. |

| 8 | 🟡 MED | `ChangelogModal.js` fetched `CHANGELOG.md` from **upstream** `decolua/9router` master and rendered it via `dangerouslySetInnerHTML` without sanitization. A compromised upstream repository could inject arbitrary JS into the admin dashboard session. | **Fixed in source** — `ChangelogModal.js` and `changelogUrl` were deleted entirely. Review changelog/history on GitHub instead of fetching and rendering remote markdown in the dashboard. |
| 9 | 🟢 LOW | `src/app/api/oauth/cursor/auto-import/route.js` sqlite3 CLI fallback (lines 143, 158) built queries via string interpolation (`WHERE key='${key}'`). Keys come from hardcoded arrays so not user-controlled, but the pattern violates parameterization principles. | **Fixed in source** — single quotes in key values are now escaped with standard SQL doubling (`key.replace(/'/g, "''")`) before interpolation. The primary better-sqlite3 path already uses `?` placeholders. |

### Cleared (no action needed)

- **MITM subsystem** (`src/mitm/**`): installs a 10-year system Root CA, rewrites `/etc/hosts`, captures a
  sudo password — but it is **opt-in** (`mitmEnabled` absent from defaults) and **inert in a non-root
  Docker container** (no sudo on Alpine, cannot bind 443, cannot write the system trust store). Do not
  enable it in the container.
- **Prompt-injection surface** (RTK / Caveman / Ponytail, `open-sse/rtk/**`): injected prompts are static
  repo constants, default-off (RTK default-on but pure string compression). No `eval`/`exec`/dynamic
  `require`; tool_result content is never interpreted. A malicious provider response cannot leverage it.
- **Auth model**: `/api/*` is deny-by-default with a narrow public allowlist; login is rate-limited;
  parameterized SQL throughout (no SQLi); no path traversal in exposed routes.
- **No telemetry exfiltration**: machine ID is local-only; update check is a manual npm-registry poll;
  no auto-update; no secret-upload sync job to `9router.com`.

| 10 | 🟡 MED | Sidebar polled `npm install -g 9router@latest` update banner and offered an in-app "Copy & Shutdown" action pointing at the upstream npm package (`decolua/9router`), not this fork. Clicking it would install unreviewed upstream code. (`src/shared/components/Sidebar.js`, `src/lib/appUpdater.js`) | **Fixed in source** — removed all update-action UI and handlers; `appUpdater.js` deleted. npm version check retained as an informational banner that links to `mihado/9router hardened` branch for manual sync. |
| 11 | 🟢 LOW | Skills dashboard raw URLs pointed at upstream `decolua/9router master`; landing page GitHub links also pointed at upstream. (`src/shared/constants/skills.js`, `src/app/landing/`) | **Fixed in source** — `REPO`/`BRANCH` in `skills.js` updated to `mihado/9router` / `hardened`; landing page links updated. All skill cross-references in `skills/*/SKILL.md` updated to `mihado/9router hardened`. Stale localized READMEs (`i18n/`, `README.zh-CN.md`, `cli/README.md`) deleted. `gitbook/` docs excluded from scrub (upstream user docs, merge-conflict surface). |
| 12 | 🟢 LOW | `Dockerfile` and `docker-compose.yml` referenced upstream `decolua/9router` image. | **Fixed in source** — image refs updated to `ghcr.io/mihado/9router:hardened`. |

## Changes applied in this fork

- **Removed in-app update action** — the sidebar offered a "Copy & Shutdown" flow that installed the
  upstream `npm i -g 9router@latest` package. Replaced with an informational banner (links to
  `mihado/9router hardened` branch for manual sync); the npm version check itself is retained.
  (`src/shared/components/Sidebar.js`; `src/lib/appUpdater.js` deleted.) (Finding 10)
- **Removed entire tunnel subsystem** — `src/lib/tunnel/` (cloudflared binary download/spawn,
  quick-tunnel, tailscale install/connect/funnel), `src/app/api/tunnel/` (6 route files),
  `src/lib/appUpdater.js`, and `src/app/api/version/update/` all deleted. `initializeApp.js`
  rewritten from 286→70 lines: tunnel watchdog, network monitor, and signal handlers removed.
  `dashboardGuard.js` tunnel/tailscale allowlist entries and `tunnelDashboardAccess` gate
  stripped. Endpoint page reduced from 1295→~300 lines (API-keys-only UI). CLI tunnel process
  kill code deleted; tunnel API methods replaced with no-op stubs. (Finding 4, GAP-5, GAP-6)
- **Removed default `"123456"` password fallback** — `INITIAL_PASSWORD` is now mandatory for
  first login. No password configured returns 500 with bootstrap guidance. Successful bootstrap
  login returns `mustChangePassword:true` + `mustChangeHint`, forcing a permanent password set.
  Login page no longer discloses the default password. `settings/route.js` first-time password
  gate tightened: requires `currentPassword`, validates against `INITIAL_PASSWORD`. Dead
  `reset-password` route and CLI surface deleted. All recovery strings aligned across API
  errors, lockout hint, and on-page help. (Finding 1, GAP-3)
- **Zero-trusted deployed `/v1*` surfaces** — removed the loopback bypass from
  `dashboardGuard.js` so `/v1`, `/v1beta`, `/api/v1`, `/api/v1beta`, and `/codex` no longer gain
  unauthenticated access from localhost-looking requests. `requireLogin` is now immutable to
  `true` in `src/app/api/settings/route.js`, so the dashboard/admin API cannot be opened by
  flipping the runtime toggle off. The current public-deployment auth contract is JWT for
  dashboard/admin, API key for `/v1*`. A dormant CLI-token path remains in tree for merge
  hygiene but is inaccessible in the current Docker deployment. (Finding 2)
- **Removed changelog remote-render XSS surface** — `src/shared/components/ChangelogModal.js`,
  `src/shared/constants/config.js` `changelogUrl`, and all imports were deleted instead of
  preserving a fetch-and-render path for remote markdown. (Finding 8)
- **Removed DB export/import web surface completely** — `src/app/api/settings/database/route.js`
  deleted, the `ALWAYS_PROTECTED` guard entry removed, and the profile-page export/import UI and
  `src/lib/localDb.js` re-exports stripped. Filesystem/SQLite access still contains the same
  secrets and is treated as deployment-level secret material. (Finding 1, Finding 6)
- **Restored request-log header masking** — `open-sse/utils/requestLogger.js` once again truncates
  `Authorization`, `x-api-key`, `cookie`, and token-like headers before writing request logs to
  disk. This removes provider-token leakage from request-log files, but request/response bodies
  remain plaintext when `ENABLE_REQUEST_LOGS=true`. (Operational note below.)
- **Deleted stale readmes** — `i18n/` (4 localized READMEs), `README.zh-CN.md`, `cli/README.md`,
  `skills/README.md` all carried upstream `9router.com`/`decolua` references and are not
  maintained for this fork. (GAP-12)
- **Pointed remaining URLs at this fork** — `.env.example` `CLOUD_URL`/`NEXT_PUBLIC_CLOUD_URL`
  changed to placeholder. `docker-compose.yml` image ref → `ghcr.io/mihado/9router:hardened`.
  All skill cross-references in `skills/*/SKILL.md` updated from
  `decolua/9router master` → `mihado/9router hardened`. `gitbook/` docs excluded from scrub
  (71 upstream user-facing files, merge-conflict surface). (GAP-4, GAP-11)
- **Skills and landing page links pointed at upstream** — `src/shared/constants/skills.js` `REPO`/`BRANCH`
  updated to `mihado/9router` / `hardened`; landing page component links updated. (Finding 11)
- **Free-provider toggle** — `mimo-free` (Xiaomi MiMo Code) and `opencode` carry `noAuth: true` in
  `open-sse/providers/registry/`, which previously caused `auth.js` to inject a synthetic
  `{id: "noauth", isActive: true, accessToken: "public"}` connection unconditionally — no settings
  check, no way to disable. The dashboard UI also gated the toggle on `stats.total > 0`, and because
  noAuth providers have no DB-stored connections that count is always 0, so no toggle was ever rendered.
  Fixed in three files:
  - `src/sse/services/auth.js` — before injecting the virtual connection, reads
    `settings.disabledFreeProviders` (new SQLite settings key, array of provider IDs); returns `null`
    immediately if the provider is listed, making the router treat it as unconfigured.
  - `src/app/(dashboard)/dashboard/providers/page.js` — added `disabledFreeProviders` state,
    fetches `/api/settings` on mount, renders a toggle for noAuth providers regardless of
    `stats.total`, and persists changes via `PATCH /api/settings`.
  - `src/shared/components/UsageStats.js` — the usage page was also hardcoding all noAuth free
    providers into the provider list regardless of disabled state; fixed to filter against
    `disabledFreeProviders` from `/api/settings`.
  No new API surface: `PATCH /api/settings` already existed and strips protected keys; the new
  `disabledFreeProviders` array is an ordinary settings payload.

- **Added security response headers** — `next.config.mjs` `headers()` now sets `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, and `Referrer-Policy: same-origin` repo-wide. The JWT-cookie
  dashboard previously shipped with no framing protection (clickjackable) and no MIME-sniffing
  protection; neither header affects the Bearer/API-key `/v1*`, `/v1beta*`, `/codex` routes since
  those are called via `fetch()`, not browser `<iframe>` embedding. A locked-down CSP was
  considered but deferred — Monaco, Recharts, and React Flow need browser verification before a
  strict `script-src`/`style-src` can be set without breaking the dashboard. (ship-ready review,
  2026-07-04)
- **Fixed stale `DOCKER.md`** — the fork's docker-compose.yml and README were repointed at
  `ghcr.io/mihado/9router:hardened` during the initial hardening pass, but `DOCKER.md` was missed
  and still told users to `docker pull decolua/9router:latest` (the unreviewed upstream image) and
  described the old tag-triggered Docker Hub publish flow. `scripts/upstream-recheck.sh` explicitly
  excludes `DOCKER.md` from its stale-reference scan (grouped with `README.md`/`AGENTS.md`, which
  intentionally keep one attribution reference), which is why the automated check never caught it.
  Rewrote `DOCKER.md` to match the current image, CI trigger (push to `hardened`, not git tags), and
  added a rollback section using the short-SHA / date-SHA tags CI already produces. (ship-ready
  review, 2026-07-04)
- **Removed Google Analytics** — `src/app/layout.js`; dropped `@next/third-parties` dependency. (Finding 3)
- **Build switched to pnpm with a committed `pnpm-lock.yaml`** and `--frozen-lockfile`, for reproducible,
  pinned builds (upstream used `npm install` with no lockfile). `node-linker=hoisted` (`.npmrc`) so the
  Dockerfile's per-package COPYs work. pnpm version pinned via `package.json` `packageManager`.
- **Base image pinned by digest** (`node:22-alpine@sha256:…`) in the `Dockerfile`.
- **CI publishes only to our GHCR, only from `hardened`** (`.github/workflows/docker-publish.yml`):
  dropped the upstream Docker Hub (`decolua/9router`) push and the tag trigger; added a hard guard that
  fails on any ref other than `refs/heads/hardened`.
- **Dependabot enabled** (`.github/dependabot.yml`) for npm + github-actions + docker, targeting `hardened`.
- **Removed cloudflared boot-time download** — `src/shared/services/initializeApp.js`; dropped the
  unconditional `ensureCloudflared()` call at startup. (Finding 4) The edge router's own Cloudflare
  tunnel (separate `cloudflared` service in the deployment repo) is unrelated to this.

- **Cursor auto-import SQL escaping** — sqlite3 CLI fallback in
  `src/app/api/oauth/cursor/auto-import/route.js` used string interpolation for SQL queries; switched to
  single-quote escaping (`key.replace(/'/g, "''")`). Keys are hardcoded so not exploitable, but now
  consistent with the parameterized primary path. (Finding 9)

Runtime hardening (strong `INITIAL_PASSWORD`, `REQUIRE_API_KEY=true`, `AUTH_COOKIE_SECURE=true`, unique
`JWT_SECRET`/`API_KEY_SECRET`/`MACHINE_ID_SALT`, loopback-bound port) is applied in the **deployment repo**
(`traefik-svc`), not here, so secrets never live in this source tree.

Additional regression tests in `tests/unit/auth-login.test.js` (10 cases) and
`tests/unit/settings-password.test.js` (7 cases) cover the bootstrap password flow,
`mustChangePassword` logic, rate limiting, and first-time/already-set password changes.

## Public deployment posture

The current supported public-deployment posture for this fork is:

- **JWT** for dashboard/admin routes
- **API key** for `/v1*` model/API routes
- loopback/Host-based trust removed from deployed `/v1*` access
- `requireLogin` locked to `true` for public deployments

There is one explicit compromise: CLI-token-gated local surfaces remain in tree to reduce
downstream merge burden, but they are **not** part of the supported public-exposure model.
In the current Docker deployment they are inaccessible because the machine-ID-derived token does
not match between host and container. See [`docs/PUBLIC-EXPOSURE-PLAN.md`](PUBLIC-EXPOSURE-PLAN.md)
for the tactical rationale and deferred follow-ups.

## Accepted residual risks

- **SSRF guard remains string-only** — no DNS resolution or IP-pinning yet. Accepted because the
  web-fetch tool is API-key-gated and the deployment is not exposed to untrusted multi-user
  traffic. Revisit before any broader public or shared deployment.
- **`/api/auth/status` leaks minor auth-state metadata** — `hasPassword`, `authMode`, and
  `oidcConfigured` remain public for login-page UX. Accepted as low-value recon in the current
  single-user deployment.
- **No server-side JWT invalidation** — logout clears the cookie only; rotating `JWT_SECRET`
  remains the kill switch.
- **Prompt/response data is still stored when observability/logging are enabled** — request-log
  header masking removes provider-token leakage, but `ENABLE_REQUEST_LOGS=true` still writes
  plaintext request/response bodies to `logs/`. Separately, SQLite observability stores full
  request history in `requestDetails` when `enableObservability` is enabled (default). Treat the
  container volume as secret material.
- **`pnpm audit --prod` (2026-07-04): 17 findings, 3 low / 14 moderate, none critical/high.** All in
  transitive deps: `dompurify` (bundled inside `monaco-editor`, used for its own hover-widget markdown
  rendering — not the app's XSS sanitizer) and `postcss` (build-time CSS stringification, not
  reachable at runtime). No fix available yet without bumping `monaco-editor`/`next` past what's
  pinned. Track and bump opportunistically with the `minimumReleaseAge` cooldown; not a release
  blocker for a single-admin-user deployment.
- **No correlation ID across the proxy request path** — `docker logs` output and the dashboard's
  `requestDetails` rows can't be joined by ID; matching a log line to a dashboard entry is manual
  (timestamp + model + provider). Several `.catch(() => {})` sites in the hot path
  (`open-sse/handlers/chatCore.js` and friends) also mean a request-log write failure is invisible.
  Logging throughout `open-sse/`/`src/sse/` is freeform `console.log` strings, not structured JSON.
  None of this is a vulnerability, but it means diagnosing a production issue currently means reading
  raw container logs and eyeballing the Usage page side by side. Worth a follow-up pass if incident
  frequency ever justifies it; not addressed in this review to keep the diff scoped to security.

## Test gate policy

The full upstream test suite has many pre-existing failures inherited from upstream master. This
fork does **not** gate CI on the entire suite.

Current policy:

- CI gates on a narrow security-relevant subset (currently 5 files / 68 tests)
- widen the gate file-by-file only when we adopt and maintain those tests in this fork
- treat broad-suite failures as upstream debt unless they reveal a real production bug we care
  about in this fork

Detailed failure categories, baseline numbers, and recommended triage order live in
[`docs/TEST-TRIAGE.md`](TEST-TRIAGE.md).

## Automated re-check

Run `scripts/upstream-recheck.sh` after every upstream sync — 15 structural + text checks
covering all checklist items and the new invariants:

```bash
./scripts/upstream-recheck.sh                 # full scan
./scripts/upstream-recheck.sh --diff <ref>    # show changed files + full scan
```

Requires: `ast-grep` (`sg`) and `ripgrep` (`rg`) on PATH (`brew install ast-grep ripgrep`).

## Upstream-sync re-check checklist

**Run this on every `git fetch upstream` / merge before building or publishing.** Diff against the
previously reviewed upstream commit and re-verify each item; update the "Reviewed at" version above.

1. **Third-party beacons** — `git grep -nE 'gtag|googletagmanager|google-analytics|@next/third-parties'`.
   Re-confirm GA stays removed; check for new analytics/telemetry SDKs.
2. **Boot-time downloads / exec** — inspect `src/shared/services/initializeApp.js` and `src/lib/**` for new
   `downloadFile`, `execSync`, `spawn`, `ensureCloudflared`, or fetch-then-run-binary paths at startup.
3. **Default-secret regressions** — `git grep -nE '123456|endpoint-proxy-(api-key-secret|salt)'` and confirm
   `INITIAL_PASSWORD`/`API_KEY_SECRET`/`MACHINE_ID_SALT`/`JWT_SECRET` defaults haven't weakened.
4. **SSRF guard** — `src/shared/utils/ssrfGuard.js`: did it gain DNS resolution + IP-pinning (good), or new
   user-controlled-URL fetch sites that skip it (`git grep -n assertPublicUrl`)?
5. **MITM defaults & privileged shell-outs** — confirm `mitmEnabled` is still default-off; scan `src/mitm/**`
   for new `child_process`/cert-install/`/etc/hosts` behavior.
6. **Egress to 9router.com / sync jobs** — `git grep -nE '9router\.com|/api/sync/cloud|CLOUD_URL'`; confirm
   no new job uploads tokens/settings/DB contents.
7. **Auth surface** — re-check `src/dashboardGuard.js` public allowlist and the "local request = trusted"
   logic for new unauthenticated routes.
8. **Skills** — `git diff [prev]..HEAD -- skills/` for new or modified skill markdown files. Skills are
   static documentation served to AI agents; check for new API instructions that expose endpoints or
   auth flows not previously documented, and confirm no skill file embeds executable content or external
   URLs beyond `localhost:20128`.
9. **Changelog surface** — confirm `src/shared/components/ChangelogModal.js` stays deleted and no new
   remote markdown fetch + `dangerouslySetInnerHTML` path was introduced in its place.
10. **Lockfile + build** — `pnpm install --frozen-lockfile` still clean; `docker build` succeeds; review any
    new/changed dependencies in the Dependabot/lockfile diff.
11. **Tunnel re-introduced** — confirm `src/lib/tunnel/` and `src/app/api/tunnel/` stay deleted; no new
    `ensureCloudflared`, `spawnQuickTunnel`, tailscale install, or binary download paths in `initializeApp.js`.
12. **Default password regressed** — `git grep -nE '"123456"|DEFAULT_PASSWORD' -- 'src/*'` and
    `sg run -p 'process.env.$KEY || "123456"' --lang js src/` must both be empty.
13. **Stale readmes re-introduced** — confirm `i18n/`, `README.zh-CN.md`, `cli/README.md`,
    `skills/README.md` stay deleted.
14. **`.env.example` / `docker-compose.yml`** — no upstream `9router.com` or `decolua` image refs.
15. **Request logging** — `open-sse/utils/requestLogger.js` still masks auth headers before writing logs;
    if upstream changes logging behavior, re-check that enabling `ENABLE_REQUEST_LOGS` does not leak
    provider tokens in plaintext headers.

## Upstream-sync re-check log

### 2026-07-03 — rebase onto upstream `0.5.15` → `0.5.18` (`0b3c794` → `7f436e2`)

Ran `./scripts/upstream-recheck.sh --diff 0b3c794`: all 10 automated checks passed. Manually
cleared the 3 checks the script can't automate:

- **SSRF guard (#4)** — `src/shared/utils/ssrfGuard.js` untouched by the upstream delta; still
  string-only, no new user-controlled-URL fetch site bypasses it.
- **Auth surface (#7)** — `src/dashboardGuard.js` untouched. New/changed routes in the delta
  (`GET` added to `codex-reset-credits`, new `clinepass` OAuth provider) all fall under existing
  `/api/*` and `/api/oauth/*` allowlist patterns; no new unauthenticated route.
- **Lockfile + build (#10)** — `pnpm install --frozen-lockfile` clean (no lockfile drift, no new
  dependencies — only version bumps in `package.json`/`cli/package.json`); `docker build .`
  succeeded end-to-end.

Also manually reviewed the upstream delta (`git diff <pre-rebase-hardened-tip>..HEAD`, 70 files)
for anything the script doesn't cover:

- `fix(mitm): generate root ca on server startup` (#2228) — `src/mitm/server.js` now
  auto-generates the Root CA (`src/mitm/cert/rootCA.js`) if missing, instead of exiting. Confined
  to the already-opt-in path: `initializeApp.js` only spawns `mitm/server.js` when
  `settings.mitmEnabled` is true, which stays default-off. Not a boot-time or default-on change.
- New `clinepass` provider (OAuth + API key) — static registry entry, no `noAuth`, no hardcoded
  secrets, routed through the existing OAuth flow (`randomBytes` state, standard token exchange).
  Same shape as existing providers.
- `providers/route.js` dropped the "one connection per compatible node" restriction — intentional
  product change (key-pool support), not an auth change; route is still behind the same auth gate.
- `connectionsRepo.js` cross-IdP dedup fix, `bypassHandler.js` usage-merge fix, `validate/route.js`
  added a fetch timeout — all bug fixes, no new egress or auth-relevant surface.
- `requestLogger.js` header masking and `.env.example`/`docker-compose.yml` fork pointers
  untouched by the delta — still correct.
- CI security-test subset (`unit/dashboard-guard`, `auth-login`, `settings-password`,
  `buildOutputFilter`, `free-provider-toggle`) run manually from `tests/`: 68/68 pass (doc
  previously said "5 files / 66 tests" — now 68; update test-count references opportunistically).

No source changes required. Updated "Reviewed at" version above.

### 2026-07-08 — rebase onto upstream `0.5.18` → `0.5.20` (`7f436e2` → `b10b807`), via `capabilities`

`capabilities` (a feature branch: model-capability metadata, combo aggregation, kimchi provider) was
rebased onto upstream `master` first; `hardened`'s 33 commits were then rebased onto `capabilities`.
Two conflicts, both resolved in favor of this fork's existing conventions:

- `CLAUDE.md` — upstream added its own full `CLAUDE.md` (`008de32`, codebase guidance: commands,
  architecture, conventions) after this fork had already reduced the file to `@AGENTS.md`. Resolved
  by keeping `@AGENTS.md` as the first line (fork rules take priority) with upstream's guidance
  content preserved below it — same pattern already used by the global `~/.claude/CLAUDE.md`.
- `README.md` — upstream's README grew substantially with marketing content (tutorial videos, star
  chart, forks list, `decolua/9router` Docker Hub instructions) between 0.5.18 and 0.5.20. Resolved
  by keeping this fork's condensed README throughout and discarding all upstream additions in
  conflicted hunks, consistent with Findings #11/#12 (don't reintroduce links/images pointing at
  upstream).

Ran `./scripts/upstream-recheck.sh --diff 7f436e2`: all 10 automated checks passed. Two informational
hits from the script, both confirmed benign: `skills/9router-web-fetch/SKILL.md` uses `9router.com` as
an example URL *value* in a web-fetch curl example (not a call the app makes); `src/app/layout.js`'s
`dangerouslySetInnerHTML` is a static, argument-free inline script toggling a CSS class on font load
(unrelated to the already-removed GA/changelog remote-render surfaces).

Manually cleared the 3 checks the script can't automate:

- **SSRF guard (#4)** — `src/shared/utils/ssrfGuard.js` diff is empty; unchanged, still string-only.
- **Auth surface (#7)** — `src/dashboardGuard.js` zero-trust posture intact (no `isLocalRequest`
  bypass reintroduced). New in this delta: a **Headroom token-saver** feature
  (`src/app/api/headroom/{start,stop,proxy}`) — `start` refuses non-loopback URLs outright;
  `proxy` forwards to an admin-configured `settings.headroomUrl` (not attacker-controlled input) and
  strips cookies/auth headers when the target isn't loopback; all three routes are gated in
  `LOCAL_ONLY_PATHS` (CLI-token only, same dormant-surface category as the existing accepted
  Finding #2 — inaccessible in the current Docker deployment). No new unauthenticated route.
- **Lockfile + build (#10)** — found and fixed real drift: `pnpm-lock.yaml` still listed a `fs`
  dependency that upstream had already dropped from `package.json` between 0.5.18 and 0.5.20;
  regenerated the lockfile (`pnpm install`), `--frozen-lockfile` now clean. `docker build .`
  succeeded end-to-end both before and after the lockfile fix.

Also reviewed the delta for anything the script doesn't cover:

- `.github/workflows/gitbook-pages.yml` — this file was **removed** by the upstream delta (was
  pushing to an external `9router.github.io` repo using a deploy-key secret on every push to
  `main`/`master`); a risk reduction, not a new surface.
- `.github/workflows/docker-publish.yml` — guard against publishing outside `hardened` and the
  GHCR-only push are untouched by the upstream delta (this fork's own file).
- CLI package changes (`cli/cli.js`, `client.js`, `settings.js`, `endpoint.js`) — all fork-internal
  cleanup carried through the rebase (dead tunnel-stub removal, `123456` reset-password flow
  removed from the CLI menu); no new external endpoints or telemetry.
- `open-sse/config/providerModels.js`, `open-sse/handlers/chatCore.js` — model-id normalization
  fixes only; no new fetch sites or hardcoded credentials.

**Test infra fix (unrelated to the security surface, done while verifying the build):** `tests/`
was an npm-managed package fully decoupled from the root pnpm install, and its committed `test`
script hardcoded a stale `/tmp/node_modules` path that doesn't work on a plain checkout. Converted
`tests` into a proper pnpm workspace member (`pnpm-workspace.yaml`); `pnpm install` from the root
now covers it, and `Dockerfile` copies `tests/package.json` alongside the root manifests before
`pnpm install --frozen-lockfile` so the production build can still resolve the workspace (`tests/`
itself is never copied into the runtime image). `.github/workflows/docker-publish.yml`'s test step
no longer needs its own `npm install`. `cli/` deliberately stays **outside** this workspace — it's
published to npm independently and manages its own native-module postinstall isolation.

Ran the CI security-test subset (`unit/dashboard-guard`, `auth-login`, `settings-password`,
`buildOutputFilter`, `free-provider-toggle`): 68/68 pass. Ran the full suite for comparison: 48
failing tests (1242 total, up from 1160 at the last re-check — `capabilities` added real tests for
new features). Verified on an unmodified `capabilities` worktree that all 48 fail identically there
— pre-existing upstream/feature-branch debt, not introduced by this rebase or the pnpm-workspace
change. One category worth naming: `golden-url-header.test.js` is data-driven over the provider
registry, so every new provider needs a matching snapshot commit — upstream's `clinepass` PR
(`b08751c`) didn't include one (confirmed absent on upstream `master` itself, not just here), the
same gap this repo already hit once for `kimchi` (`dbb9589`). Running the suite locally
auto-generates the missing snapshot and passes, so it never shows up in a failure count — deliberately
**not** patched in this fork; it's an upstream PR-process gap (missing `vitest -u` before merge), not
something worth carrying fork-side maintenance for. `docs/TEST-TRIAGE.md`'s baseline count is stale
(25 known-fails from the 0.5.15-era triage);
noted but not re-triaged here, consistent with the test gate policy below.

No source changes required beyond the lockfile regeneration and the tests-workspace fix above.
Updated "Reviewed at" version above.
