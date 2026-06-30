# 9Router (hardened fork)

OpenAI/Claude-compatible router that connects AI coding tools (Claude Code, Codex, Cursor,
Cline, OpenClaw, Copilot, …) to 40+ AI providers and 100+ models. Adds token saving (RTK),
format translation, quota tracking, multi-account support, and automatic tier fallback.

> **Hardened downstream fork** of [`decolua/9router`](https://github.com/decolua/9router).
> Security review, the changes made, and the upstream-sync re-check checklist live in
> [`docs/SECURITY-REVIEW.md`](docs/SECURITY-REVIEW.md); fork/agent rules in [`AGENTS.md`](AGENTS.md).
> Built and published **only from the `hardened` branch** to `ghcr.io/mihado/9router`.

---

## This fork

Security-hardening changes for this downstream fork. Full review, findings table, and the upstream-sync re-check checklist live in [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md).

**Egress & beacons removed**
- Remove hardcoded Google Analytics beacon (`src/app/layout.js`; drop `@next/third-parties`) — loaded on every dashboard page with no opt-out.
- Remove unconditional cloudflared binary download at startup (`initializeApp.js`); the default-off tunnel feature still fetches on-demand if ever enabled.
- Remove donate button and its egress to `9router.com/api/donate` (`Header.js`, `DonateModal.js`).
- Point `changelogUrl` at this fork's `hardened` branch instead of upstream master; strip `<script>` tags and inline handlers before `dangerouslySetInnerHTML` render (`ChangelogModal.js`).
- Remove in-app update/shutdown action that would install `decolua/9router` from npm; replace with an informational banner linking to this fork for manual sync.
- Point skills dashboard URLs and landing page links at `mihado/9router hardened` instead of upstream.

**Code fixes**
- `noAuth` free providers (mimo-free, opencode) were permanently active — `auth.js` injected a virtual connection unconditionally and the UI never rendered a toggle. Added `disabledFreeProviders` to the settings blob; `auth.js` returns `null` when listed; dashboard now renders a proper toggle; usage page filters them consistently.
- Escape single quotes in the sqlite3 CLI fallback queries in the Cursor auto-import route (primary `better-sqlite3` path already uses `?` placeholders).

**Build & supply chain**
- Switch to pnpm 11: frozen lockfile, hoisted `node-linker` (`.npmrc`), `packageManager` pin, build-script allowlist (`pnpm-workspace.yaml`).
- Pin base image by digest in `Dockerfile`.
- CI publishes only to GHCR, only from `hardened`, with a hard guard against any other ref; drop upstream Docker Hub push.
- Enable Dependabot for npm / github-actions / docker, targeting `hardened`.

**Documentation**
- `docs/SECURITY-REVIEW.md` — findings table (CRIT→LOW), what was fixed vs. accepted, upstream-sync re-check checklist.
- `AGENTS.md` / `CLAUDE.md` — fork rules and context for agents working in this repo.
- Reviewed at upstream `v0.5.15` (commit `0b3c794`); clean checklist pass.

---

## How it works

```
Your CLI tool ──http://localhost:20128/v1──► 9Router ──► provider
                                              • RTK token saver (compress tool_result)
                                              • format translation (OpenAI ↔ Claude ↔ Gemini ↔ …)
                                              • quota tracking + auto token refresh
                                              • 3-tier fallback: subscription → cheap → free
```

Dashboard: `http://localhost:20128/dashboard` · OpenAI-compatible API: `http://localhost:20128/v1`

## Run from source

```bash
cp .env.example .env
pnpm install
pnpm build
PORT=20128 HOSTNAME=0.0.0.0 NODE_ENV=production pnpm start
```

Dev: `pnpm dev` (Next dev server). The build uses pnpm with a frozen lockfile; pnpm version is
pinned via `package.json` `packageManager`, build-script allowlist in `pnpm-workspace.yaml`.

## Docker

```bash
# Run the published hardened image
docker run -d --name 9router \
  -p 127.0.0.1:20128:20128 \
  -v 9router-data:/app/data \
  --env-file .env \
  ghcr.io/mihado/9router:hardened

# Build from source (Dockerfile at repo root)
docker build -t ghcr.io/mihado/9router:hardened .
```

Data persists at `9router-data:/app/data` (SQLite). `.env` is not baked into the image
(`.dockerignore`); inject config with `--env-file` or `-e`.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | auto-generated (`$DATA_DIR/jwt-secret`, mode 0600) | JWT signing secret for the dashboard auth cookie. Set explicitly to share across instances / survive volume resets. |
| `INITIAL_PASSWORD` | `123456` | First-login password when no saved hash exists. **Always override.** |
| `DATA_DIR` | `~/.9router` | App data location (SQLite at `$DATA_DIR/db/data.sqlite`). |
| `PORT` | framework default | Service port (`20128` in examples). |
| `HOSTNAME` | framework default | Bind host (Docker defaults to `0.0.0.0`). |
| `NODE_ENV` | runtime default | Set `production` for deploy. |
| `API_KEY_SECRET` | `endpoint-proxy-api-key-secret` | HMAC secret for generated API keys. Set a unique value. |
| `MACHINE_ID_SALT` | `endpoint-proxy-salt` | Salt for stable machine ID hashing. Set a unique value. |
| `REQUIRE_API_KEY` | `false` | Enforce Bearer API key on `/v1/*` (recommended for any exposed deploy). |
| `AUTH_COOKIE_SECURE` | `false` | Force `Secure` auth cookie (set `true` behind an HTTPS reverse proxy). |
| `ENABLE_REQUEST_LOGS` | `false` | Write request/response logs under `logs/` (plaintext — keep off). |
| `BASE_URL` / `CLOUD_URL` | `http://localhost:20128` / `https://9router.com` | Server-side base + cloud-sync URLs (cloud sync is opt-in, off by default). |
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` | empty | Optional outbound proxy for upstream provider calls (lowercase variants supported). |

Runtime files: SQLite at `${DATA_DIR}/db/data.sqlite`, auto-backups under `${DATA_DIR}/db/backups/`,
optional logs under `logs/` when `ENABLE_REQUEST_LOGS=true`.

## Providers

- **OAuth / subscription:** Claude Code, Codex, GitHub Copilot, Cursor, Antigravity
- **Free:** Kiro AI, OpenCode Free, Vertex AI
- **Cheap / API key (40+):** GLM, MiniMax, Kimi, OpenAI, Anthropic, Gemini, DeepSeek, Groq, xAI,
  Mistral, OpenRouter, Together, Fireworks, Cerebras, and more — plus custom OpenAI/Anthropic-compatible endpoints.

Connect and manage providers, combos, and API keys from the dashboard.

## CLI integration

Point any OpenAI-compatible tool at the proxy:

```
Base URL: http://localhost:20128/v1
API Key:  <from dashboard>
Model:    cc/claude-opus-4-7   (or a combo name)
```

Claude Code — `~/.claude/config.json`:

```json
{
  "anthropic_api_base": "http://localhost:20128/v1",
  "anthropic_api_key": "<your-9router-api-key>"
}
```

Codex — `export OPENAI_BASE_URL="http://localhost:20128"` and `OPENAI_API_KEY="<key>"`.
OpenClaw — use `127.0.0.1` (not `localhost`) to avoid IPv6 resolution issues.

## API reference

```bash
# Chat completions
POST http://localhost:20128/v1/chat/completions
Authorization: Bearer <api-key>
{ "model": "cc/claude-opus-4-6", "messages": [...], "stream": true }

# List models + combos (OpenAI format)
GET http://localhost:20128/v1/models
Authorization: Bearer <api-key>
```

## Tech stack

Node.js 20+ · Next.js 16 · React 19 + Tailwind 4 · SQLite (better-sqlite3 / sql.js fallback) ·
SSE streaming · OAuth 2.0 (PKCE) + JWT + API keys.

## Acknowledgments

Built on upstream [`decolua/9router`](https://github.com/decolua/9router) (MIT), which adapts
[RTK](https://github.com/rtk-ai/rtk), [Caveman](https://github.com/JuliusBrussee/caveman),
and [Ponytail](https://github.com/DietrichGebert/ponytail) for its token-saving features.

## License

MIT — see [LICENSE](LICENSE).
