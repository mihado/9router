# AGENTS.md — hardened downstream fork of 9router

This repository is a **security-hardened downstream fork** of
[`decolua/9router`](https://github.com/decolua/9router). We self-build and publish our own container
image and run it with access to real provider credentials (Claude Code, Codex, Copilot, Cursor, …).
Treat every change through a security lens.

**[docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md)** is the source of truth — findings table, all source changes, and the upstream-sync re-check checklist. Keep it updated; do not duplicate its content here.

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
   egress to `9router.com`, no new or modified skill files that expose unexpected endpoints or embed
   external URLs. Update the "Reviewed at" version in that doc.
3. **Dependencies:** keep the lockfile frozen and reproducible. Regenerate `pnpm-lock.yaml` only with the
   pinned pnpm version; respect the `minimumReleaseAge` supply-chain cooldown. Review new deps in the
   Dependabot/lockfile diff.
4. **Don't reintroduce** removed beacons/telemetry or weaken auth defaults. Flag anything that adds
   outbound egress, privileged shell-outs, or unauthenticated routes.
