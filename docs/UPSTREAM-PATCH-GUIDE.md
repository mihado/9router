# Upstream Patch Guide — Combo Capabilities & Model Metadata

This doc covers the capability metadata work done in the `hardened` fork and
what is worth submitting upstream to `decolua/9router`.

---

## What Was Done (this fork, `hardened` branch)

### 1. Capability metadata on `/v1/models` (`ac12ef1`, `5955221`)

`/v1/models` now returns a `capabilities` object for every model entry:

```json
{
  "id": "openai/gpt-4o",
  "object": "model",
  "owned_by": "openai",
  "capabilities": {
    "vision": true,
    "pdf": false,
    "audioInput": false,
    "search": true,
    "tools": true,
    "reasoning": false,
    "contextWindow": 128000,
    "maxOutput": 16384
  }
}
```

For combo entries, capabilities are **aggregated across all member models**:
union for vision/pdf/audioInput/etc, intersection for tools, primary model
drives reasoning fields, min contextWindow, max maxOutput.

### 2. `aggregateComboCapabilities` — nested combo resolution (`d649d9e`, `f1b3d0e`)

Originally in `route.js`; moved to `open-sse/providers/capabilities.js` and
exported so it can be tested and imported client-side.

`f1b3d0e` adds an optional `comboLookup` parameter (map of combo name →
models array). When a member of a combo is itself a combo name (bare string
without a `/`), the function recurses into its members instead of
pattern-matching on the combo name. Depth guard at 6 prevents cycles.

**Why this matters for downstream tools:** Claude Code, Cursor, and any
OpenAI-compatible client querying `/v1/models` would otherwise see a combo
like `moa` advertise `vision: false` and `contextWindow: 1000000` even though
its member `mimo-v2.5` has vision and its nested combo `deepseek-v4-pro-fusion`
has a correct 1M context — because the pattern `*deepseek-v4*` matched the
name of the nested combo and missed the actual member model caps.

Server-side fix: `5955221` — `route.js` builds `comboByName` and passes it.

### 3. Combo card UI — ctx/max metadata line + nested chip icons (`2047ae1`, `d3e18ae`)

`2047ae1`: switched combo list page from a manual `/api/models` fetch to the
`useModelCaps` hook (which has a client-side fallback calling
`getCapabilitiesForModel` for any model not in the static list).

`d3e18ae`: adds a `ctx Xk · max Yk` metadata line per combo card showing the
aggregated context window and max output. Nested-combo chips now resolve
through `comboByName` so their icons reflect actual member model capabilities
rather than a name pattern match.

### 4. Provider registry updates (`5274876`, `7ce90e7`, `e8e298c`)

- **commandcode**: synced to current catalog (MiniMax M2.5/M2.7/M3, Kimi
  K2.5/K2.6/K2.7, GLM 5.x, MiMo v2.5/v2.5-pro, Qwen 3.6/3.7, StepFun,
  Nemotron); fixed mimo vendor prefix to `xiaomi/`
- **openai**: added `gpt-5.5`
- **opencode-go**: fixed typo in subscription notice text

### 5. Git SHA in sidebar version (`9cb95fa`)

Bakes the build-time git SHA into `NEXT_PUBLIC_GIT_SHA` via Dockerfile ARG →
ENV → `next.config.mjs env:` block. Sidebar shows `v0.5.15 · abc1234`.

### 6. Tests (`d649d9e`, `eb0e9d8`)

`tests/unit/capabilities.test.js` — 21 tests covering the 4-tier resolver:
provider overrides, exact model IDs, glob patterns, defaults; mimo reasoning,
qwen vision, minimax, deepseek-v4.

`tests/unit/combo-capabilities.test.js` — 18 tests covering: null/empty,
single model passthrough, vision/audioInput/search union, tools intersection,
reasoning from primary model, contextWindow min, maxOutput max; plus 5 tests
for the new nested lookup: vision union through a nested combo, contextWindow
min across leaves, cycle safety, backwards-compat without lookup.

---

## Upstream PR Strategy

### What is safe to upstream

| Change | Safe to upstream? | Notes |
|--------|------------------|-------|
| `aggregateComboCapabilities` — nested lookup | Yes | Pure utility, backwards-compat, well-tested |
| `/v1/models` capability metadata | Yes | Additive; upstream may want schema alignment |
| Combo card ctx/max metadata line | Yes | UI enhancement only |
| Combo card nested chip icon fix | Yes | Depends on `aggregateComboCapabilities` change |
| Provider registry updates | Yes (independently) | Each provider as its own PR/commit |
| `useModelCaps` hook on combo page | Yes | Removes redundant manual fetch |
| Git SHA in sidebar | Probably not | Fork-specific ops concern |

### Why cherry-pick is not clean

The capability and provider changes (commits `d649d9e` through `f1b3d0e`) were
layered on top of security hardening commits (`fd47dc3` and earlier) that
touch overlapping files (`route.js`, `capabilities.js`). A direct cherry-pick
onto upstream `master` would conflict on:

- `route.js` — security hardening added egress filtering, input validation, and
  SQL escaping that upstream doesn't have; capability wiring sits in the same
  function body
- `capabilities.js` — no security changes here; this one can likely be
  cherry-picked cleanly

### Recommended approach for upstream PR

1. **Branch from upstream `master`** (not from `hardened`).

2. **Port `capabilities.js` changes directly** — the file has no security
   overlay. Copy the updated `aggregateComboCapabilities` (with `comboLookup`
   param + depth guard) and any new pattern/model entries from `hardened`.
   Bring `tests/unit/capabilities.test.js` and `tests/unit/combo-capabilities.test.js`.

3. **Re-implement the route change minimally** — in upstream `route.js`, just
   add the two lines:
   ```js
   const comboByName = Object.fromEntries(combos.map((c) => [c.name, c.models]));
   // ... then pass comboByName as second arg to aggregateComboCapabilities
   ```
   Don't carry over the security-hardening surrounding lines.

4. **Port the combo page changes** — `combos/page.js` changes are UI-only and
   should apply with minimal conflict. The `useModelCaps` switch, `fmtK`
   helper, metadata line, and chip fix are all self-contained.

5. **Provider registry commits** — these are clean and can be PRed
   independently or together. Each provider is already its own commit in
   `hardened`.

### Files to port (read from `hardened`, write to upstream branch)

```
open-sse/providers/capabilities.js          # clean copy
open-sse/providers/registry/commandcode.js  # clean copy
open-sse/providers/registry/openai.js       # clean copy
open-sse/providers/registry/opencode-go.js  # clean copy
src/app/(dashboard)/dashboard/combos/page.js # needs review vs upstream
src/app/api/v1/models/route.js              # manual 2-line port only
src/shared/hooks/useModelCaps.js            # check if upstream has this
tests/unit/capabilities.test.js             # clean copy
tests/unit/combo-capabilities.test.js       # clean copy
```
