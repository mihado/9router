# Docker

Run this hardened fork in a container. Published image:
[`ghcr.io/mihado/9router:hardened`](https://github.com/mihado/9router/pkgs/container/9router) —
built and published **only from the `hardened` branch** (`linux/amd64`). See
[AGENTS.md](AGENTS.md) / [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md) before pulling upstream
`decolua/9router` images — they have not been through this fork's review.

---

# 👤 For Users

## Quick start

```bash
docker run -d \
  --name 9router \
  -p 127.0.0.1:20128:20128 \
  -v 9router-data:/app/data \
  --env-file .env \
  ghcr.io/mihado/9router:hardened
```

`INITIAL_PASSWORD` and `JWT_SECRET` must be set in `.env` before the dashboard is reachable — see
`.env.example` and the environment variable table in [README.md](README.md). App listens on port
`20128`: http://localhost:20128

## Manage container

```bash
docker logs -f 9router        # view logs
docker stop 9router           # stop
docker start 9router          # start again
docker rm -f 9router          # remove
```

## Data persistence

```bash
-v 9router-data:/app/data
```

Data layout under `/app/data/`:

```text
/app/data/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
└── ...                   # certs, logs, runtime configs
```

Container path: `/app/data/db/data.sqlite`. Treat this volume as secret material — it contains
plaintext provider OAuth tokens and API keys (see `docs/SECURITY-REVIEW.md`, Finding 6).

## Optional Headroom sidecar

`docker-compose.yml` at the repo root already wires this up. To run it manually:

```yaml
services:
  9router:
    image: ghcr.io/mihado/9router:hardened
    ports:
      - "127.0.0.1:20128:20128"
    volumes:
      - 9router-data:/app/data
    env_file:
      - .env
    environment:
      HEADROOM_URL: http://headroom:8787
    depends_on:
      - headroom

  headroom:
    image: ghcr.io/chopratejas/headroom:latest
    ports:
      - "8787:8787"

volumes:
  9router-data:
```

In the dashboard, open `Endpoint` → `Token Saver` → `Headroom`, confirm the URL is
`http://headroom:8787`, recheck status, then enable Headroom.

If Headroom runs on the Docker host instead of as a sidecar, use `http://host.docker.internal:8787`
on macOS/Windows. On Linux, add `--add-host=host.docker.internal:host-gateway` or the equivalent
compose `extra_hosts` entry.

## Update to latest

```bash
docker compose pull 9router
docker compose up -d 9router
```

Or without compose:

```bash
docker pull ghcr.io/mihado/9router:hardened
docker rm -f 9router
# re-run the quick start command
```

## Rollback

Every image build is pushed under three tags: the moving `hardened` tag, a short-SHA tag
(`ghcr.io/mihado/9router:<short-sha>`), and a date-SHA tag (`ghcr.io/mihado/9router:YYYYMMDD-<sha>`).
Find the last known-good build in the
[package versions list](https://github.com/mihado/9router/pkgs/container/9router/versions) or
`git log --oneline hardened`, then pin to it:

```bash
docker pull ghcr.io/mihado/9router:<short-sha>
docker compose stop 9router
# edit docker-compose.yml (or your deploy config) to pin image: ghcr.io/mihado/9router:<short-sha>
docker compose up -d 9router
```

No database migration rollback is provided — SQLite schema changes in this project are additive.
If a bad build wrote data in an incompatible shape, restore from `${DATA_DIR}/db/backups/` instead
of only rolling back the image.

---

# 🛠 For Developers

## Build image locally (test)

```bash
docker build -t 9router .

docker run --rm -p 20128:20128 \
  -v 9router-data:/app/data \
  -e DATA_DIR=/app/data \
  9router
```

## Publish (automatic via CI)

Every push to the `hardened` branch triggers `.github/workflows/docker-publish.yml`, which runs the
security-relevant unit test subset, then builds and pushes to `ghcr.io/mihado/9router` only. There is
no tag-triggered release flow and no Docker Hub push — the workflow hard-fails on any ref other than
`refs/heads/hardened`. See `docs/SECURITY-REVIEW.md` for the upstream-sync re-check that must be run
before merging any upstream changes into `hardened`.
