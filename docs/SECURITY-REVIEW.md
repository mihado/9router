# 9router Security Review (hardened fork)

This is a **hardened downstream fork** of [`decolua/9router`](https://github.com/decolua/9router).
We self-build and publish our own image (`ghcr.io/mihado/9router:hardened`) from the `hardened` branch
and run it internally behind Traefik. This document records the security review that justified the fork,
the changes we made, the risks we accepted, and — most importantly — the **checklist to re-run every time
we sync from upstream**.

> Review date: 2026-06-28 · Reviewed at upstream version `0.5.12` (commit `cce47dd`).

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
| 1 | 🔴 CRIT | Dashboard password defaults to `123456` when `INITIAL_PASSWORD` unset; the DB-export endpoint (`/api/settings/database`) re-checks the *same* password and returns **all provider tokens in cleartext**, with no rate limit on the export password header. (`src/app/api/auth/login/route.js`, `src/lib/auth/dashboardSession.js:75-82`, `src/app/api/settings/database/route.js:16`) | Mitigated by **deploy config**: set strong `INITIAL_PASSWORD`, change in-dashboard on first run. |
| 2 | 🟠 HIGH | Any caller reaching `127.0.0.1:20128` is treated as "local" and gets **unauthenticated** full proxy access to all provider credentials (`src/dashboardGuard.js:136`). Remote callers via Traefik correctly require an API key. | Mitigated by **deploy config**: loopback-bind the port (only Traefik reaches it) + `REQUIRE_API_KEY=true`. |
| 3 | 🟠 HIGH | Hardcoded Google Analytics (`G-LC959F603F`) loaded on every dashboard page, no env toggle (`src/app/layout.js`). | **Fixed in source** — GA import + element removed; `@next/third-parties` dropped from deps. |
| 4 | 🟠 HIGH | cloudflared binary auto-downloaded from GitHub at boot, unconditionally (even with tunnels disabled), no checksum/signature verify (`src/shared/services/initializeApp.js:79` → `src/lib/tunnel/cloudflare/cloudflared.js`). | **Fixed in source** — removed the unconditional `ensureCloudflared()` boot call. The (default-off) tunnel feature still fetches the binary on-demand if ever enabled; nothing is fetched/executed at startup. |
| 5 | 🟠 HIGH | SSRF guard is string-only — no DNS resolution / IP-pinning, so DNS-rebinding, 302-redirects, decimal-IP (`2130706433`), and some IPv6 forms bypass it (`src/shared/utils/ssrfGuard.js`). Applies to the auth-gated web-fetch tool (`src/sse/handlers/fetch.js`). | **Accepted / mitigated by config** — gated behind `REQUIRE_API_KEY=true` + don't expose the proxy to untrusted clients + egress-filter the router. No source fix yet. |
| 6 | 🟡 MED | Provider access/refresh tokens + API keys stored **plaintext** in SQLite `providerConnections.data`; DB export returns them in clear (`src/lib/db/repos/connectionsRepo.js`). | **Accepted** — treat the `9router-data` volume and any DB export as secret material (disk encryption / restrictive perms). No app-level at-rest encryption exists. |
| 7 | 🟡 MED | `API_KEY_SECRET` / `MACHINE_ID_SALT` ship as known default strings in `.env.example`. (Not directly forgeable — keys are validated by DB lookup, not CRC — but should be unique.) | Mitigated by **deploy config**: set unique values. |

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

## Changes applied in this fork

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

Runtime hardening (strong `INITIAL_PASSWORD`, `REQUIRE_API_KEY=true`, `AUTH_COOKIE_SECURE=true`, unique
`JWT_SECRET`/`API_KEY_SECRET`/`MACHINE_ID_SALT`, loopback-bound port) is applied in the **deployment repo**
(`traefik-svc`), not here, so secrets never live in this source tree.

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
8. **Lockfile + build** — `pnpm install --frozen-lockfile` still clean; `docker build` succeeds; review any
   new/changed dependencies in the Dependabot/lockfile diff.
