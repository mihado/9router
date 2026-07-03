# Public Internet Exposure — Plan

This fork was hardened for LAN + loopback-bound Traefik. Going public internet means
every request is untrusted. This plan is the confirmed scope for the first-phase
surface lockdown.

> **Deployment context:** single user, Docker container, Traefik ingress.
> **Target auth model for deployed surfaces:** JWT for dashboard/admin, API key
> for `/v1*`. A dormant CLI-token path remains in tree as a tactical compromise
> for merge hygiene — it is dead in this container deployment (machine-ID
> mismatch) but is not removed in phase 1.
> **Constraint:** minimal diff — don't touch code that's dead or inaccessible.

---

## Phase 1 — ships tomorrow

### 1. Zero-trust the guard — remove loopback bypass

`src/dashboardGuard.js`

Remove `isLocalRequest(request)` from `canAccessPublicLlmApi` (line 127) and
`canAccessLocalOnlyRoute` (lines 134-136). After this, `/v1*` callers need
either an API key or a CLI token (the latter is dead in container — no one
outside can produce a valid machine-ID hash). Local-only routes rely on CLI
token only, which is equally dead.

**Enforcement layer note:** phase 1 enforces API-key requirement at the
middleware guard (`canAccessPublicLlmApi` rejects keyless callers before they
reach the handler). The `/v1*` route handlers may also contain their own
`settings.requireApiKey` checks — implementation agent should verify whether
any handler-level mutable auth-off path exists and record the finding back
to this plan. If found, source-level cleanup is deferred to a follow-up
commit; the guard is the unconditional enforcement layer regardless.

### 2. Lock `requireLogin` immutably to `true`

`src/app/api/settings/route.js` — reject attempts to set `requireLogin` to
anything other than `true`. Dashboard auth is always on for public deployments.
No runtime toggle, no `requireLogin: false` bypass.

### 3. Delete changelog

- `src/shared/components/ChangelogModal.js` — component and its `dangerouslySetInnerHTML`
- `src/shared/constants/config.js` — `changelogUrl` entry
- All ChangelogModal imports (Header, Sidebar, etc.)
- `scripts/upstream-recheck.sh` — update the changelog URL check

Removes a `dangerouslySetInnerHTML` site that fetches from GitHub and renders
markdown as HTML — a supply-chain XSS vector for session hijack. Review
changelog on GitHub directly instead.

### 4. Strip DB export dead code

Route already deleted (`src/app/api/settings/database/route.js`). Clean up:

- `src/dashboardGuard.js` — `"/api/settings/database"` from `ALWAYS_PROTECTED`
- `src/app/(dashboard)/dashboard/profile/page.js` — `handleExportDatabase`,
  `handleImportDatabase`, `runImportDatabase`, `handleDbAuthConfirm`, DB modal,
  and state variables (`dbLoading`, `dbStatus`, `dbAuth`, etc.)
- `src/lib/localDb.js` — `exportDb`, `importDb` re-exports

Closes the session-hijack → one-request-credential-dump path. Backups via
filesystem (`${DATA_DIR}/db/backups/`) or direct SQLite access from the host.

### 5. Fix request-log header masking + deploy config verification

**`ENABLE_REQUEST_LOGS` masking fix** — re-enable the disabled header masking
in `open-sse/utils/requestLogger.js:73-91`. Currently `maskSensitiveHeaders`
returns `{ ...headers }` unmasked (commented-out logic says "DISABLED - keep
full token for testing"). Uncomment the masking path so `Authorization`,
`x-api-key`, `cookie`, and `token` headers are truncated before writing to
disk.

~15 lines. Ships in phase 1.

**Deploy config env vars** to confirm (not in this source tree):

- `AUTH_COOKIE_SECURE=true` — JWT cookie must be `secure` behind HTTPS
- `REQUIRE_API_KEY=true` — defense-in-depth alongside the source-level guard change
- `ENABLE_REQUEST_LOGS` — if enabled, writes plaintext prompt/response bodies
  (not auth tokens) to `logs/` for an audit trail. Console output
  (routing/auth/usage metadata) is separate and always on regardless.

  The masking fix removes the provider-token leak risk. Prompt content on disk
  is an intentional tradeoff: you get a forensic trail at the cost of storing
  conversation history in a file. Acceptable if you trust container isolation
  and treat the volume as secret — same blast radius as the SQLite DB's own
  prompt storage (see SQLite observability deferred item).

### Commit

```
security: zero-trust auth model for public internet deployment

    - Remove isLocalRequest bypass from canAccessPublicLlmApi and canAccessLocalOnlyRoute
    - Lock requireLogin immutably to true in settings PATCH
    - Delete ChangelogModal (component, imports, changelogUrl config)
    - Strip DB export dead code (ALWAYS_PROTECTED entry, profile page UI, barrel re-exports)
    - Re-enable header masking in requestLogger (ENABLE_REQUEST_LOGS safe to enable)
    - Update upstream-recheck.sh for new invariants

    Auth model: JWT (dashboard/admin) or API key (/v1*) at the guard layer.
    No loopback trust, no mutable auth-off path for dashboard login,
    no GitHub-fetch→dangerouslySetInnerHTML path, no credential-dump route.
    A dormant CLI-token path remains in tree (dead in container) — see plan
    for rationale. Handler-level requireApiKey cleanup pending verification.
```

~50 lines, mostly deletion. Reviewable in one sitting.

---

## Explicitly left inaccessible (retained for merge hygiene)

These surfaces remain in tree but are intentionally unreachable in this deployment
model. The safety claim depends on the guard rejecting all callers, not on the
routes being absent from the product. They are present, wired into the app, and
part of the codebase — just inaccessible via guard configuration.

- **CLI token machinery** (`hasValidCliToken`, `getCliToken`, `x-9r-cli-token`) —
  machine-ID-derived, dead inside Docker container (host and container have
  different machine IDs). No one outside the container can produce a valid token.
  Retained as a dormant third auth path to minimize diff; not removed in phase 1.
- **Headroom/MCP routes** (`/api/headroom/*`, `/api/mcp/`, `/api/cli-tools/cowork-settings`,
  `/api/cli-tools/antigravity-mitm`) — present in the app tree and wired into
  dashboard components. After step 1, `canAccessLocalOnlyRoute` only accepts CLI
  token (dead in container), so these routes 403 for all callers. Inaccessible by
  guard configuration, not by deletion. Revisit if you deploy these features —
  at that point, reclassify to `PROTECTED_API_PATHS` (JWT-gated) or delete.
- **`LOCAL_ONLY_PATHS` category and `canAccessLocalOnlyRoute` function** — retained
  with a dead auth path. Not deleted to minimize diff. The routes it gates are
  inaccessible in this deployment model.

---

## Deferred — needs further assessment

### SSRF guard DNS pinning

`src/shared/utils/ssrfGuard.js` is string-only (no DNS resolution, no IP-pinning,
decimal-IP bypass, no redirect blocking). Used by web-fetch tool
(`src/sse/handlers/fetch.js`).

**Defer reason:** sole user, container-isolated, API-key-gated after step 1.
The remaining risk is authenticated-user network probing — that's you.
Revisit if multi-user or if the web-fetch tool is exposed to untrusted callers.

### `app/layout.js:35` dangerouslySetInnerHTML

Static font-loading script (FOUT prevention). Hardcoded string literal — no
dynamic content, no user input, no fetched data. Zero XSS risk. Not a security
fix; could be replaced with a plain `<script>` tag for code cleanliness later.

**Defer reason:** verified static. No risk to defer.

### `/api/auth/status` information disclosure

Returns `hasPassword`, `authMode`, `oidcConfigured` to unauthenticated callers.
Used by the login page for display only.

**Defer reason:** low impact for sole-user. You know your own deploy pattern.
Attacker learns whether `INITIAL_PASSWORD` is configured and whether OIDC is
available — minor recon vector.

### API key brute-force rate limiting

`/v1` API key validation has no rate limiter (login has 5-fail lockout).

**Defer reason:** keys are long random strings — brute-forcing is infeasible.
Repeated-attempt throttling is better handled at the Traefik layer (reverse
proxy rate limiting) than in the app.

### Filesystem auto-backups

`${DATA_DIR}/db/backups/` contains plaintext provider tokens. The DB export
web route was deleted; the filesystem still contains the same data.

**Defer reason:** not in this source tree. Treat the container volume as
secret material in the deployment repo.

### SQLite observability (full request history in DB)

`saveRequestDetail()` stores full request/response bodies (prompts, provider
requests, responses) to the SQLite `requestDetails` table. Powered by
`enableObservability: true` (default) — drives the dashboard Usage page.
Not gated by `ENABLE_REQUEST_LOGS`.

**Defer reason:** behind JWT-gated dashboard, not exposed to unauthenticated
callers. But the SQLite volume contains full prompt history — same sensitivity
as the filesystem backups. Treat the volume as secret material. If you want
to stop storing prompts in the DB, set `enableObservability: false` in deploy
config or source.

### JWT server-side invalidation

`/api/auth/logout` clears the cookie but does not invalidate the token.
A stolen token works for 24h. Kill switch = rotate `JWT_SECRET`.

**Defer reason:** sole-user makes session-hijack unlikely. If compromised,
rotating `JWT_SECRET` invalidates all sessions instantly.
