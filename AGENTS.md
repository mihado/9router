# AGENTS.md — hardened downstream fork of 9router

This repository is a **security-hardened downstream fork** of
[`decolua/9router`](https://github.com/decolua/9router). We self-build and publish our own container
image and run it with access to real provider credentials (Claude Code, Codex, Copilot, Cursor, …).
Treat every change through a security lens.

## Read this first

- **`docs/SECURITY-REVIEW.md`** — the security review that justified this fork: findings (CRIT/HIGH/MED),
  what we patched, what we accepted, and the **upstream-sync re-check checklist**. This is the source of
  truth; keep it updated.

## What this fork changes vs. upstream

- **Removed Google Analytics** (`src/app/layout.js`; dropped `@next/third-parties`) — upstream loads a
  hardcoded GA beacon on every dashboard page with no toggle.
- **Build uses pnpm** with a committed `pnpm-lock.yaml` + `--frozen-lockfile` (upstream used `npm install`
  with no lockfile). pnpm version is pinned via `package.json` `packageManager`; `.npmrc` sets
  `node-linker=hoisted` so the Dockerfile's per-package COPYs work.
- **Base image pinned by digest** in the `Dockerfile`.
- **CI publishes only to our GHCR, only from the `hardened` branch** (`.github/workflows/docker-publish.yml`),
  with a hard guard that fails on any other ref. The upstream Docker Hub push was removed.
- **Removed the cloudflared boot-time binary download** (`src/shared/services/initializeApp.js`) — upstream
  fetched+executed the cloudflared binary from GitHub at every startup. The default-off tunnel feature is
  otherwise untouched (fetches on-demand if enabled).

Runtime secrets and hardening (`INITIAL_PASSWORD`, `REQUIRE_API_KEY`, `AUTH_COOKIE_SECURE`, unique
`JWT_SECRET`/`API_KEY_SECRET`/`MACHINE_ID_SALT`, loopback-bound port) live in the **deployment repo**, not
here — never commit secrets to this source tree.

## Rules for agents

1. **Branch:** `hardened` is the **default branch** — all work, the canonical CI workflow, and the
   Dependabot config live here, and it is the only branch that builds/publishes. There is no separate
   `upstream` remote; pull upstream changes ad-hoc (e.g. GitHub's "Sync fork" or a temporary remote) when
   syncing, then run the re-check checklist below before building.
2. **On any upstream sync (`git fetch upstream` / merge): run the re-check checklist in
   `docs/SECURITY-REVIEW.md` before building or publishing.** Re-verify GA stays removed, no new boot-time
   downloads/exec, no default-secret regressions, SSRF guard intact, MITM still default-off, no new
   egress to `9router.com`. Update the "Reviewed at" version in that doc.
3. **Dependencies:** keep the lockfile frozen and reproducible. Regenerate `pnpm-lock.yaml` only with the
   pinned pnpm version; respect the `minimumReleaseAge` supply-chain cooldown. Review new deps in the
   Dependabot/lockfile diff.
4. **Don't reintroduce** removed beacons/telemetry or weaken auth defaults. Flag anything that adds
   outbound egress, privileged shell-outs, or unauthenticated routes.
