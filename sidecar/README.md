# Isolated summarization sidecar

This service gives the n8n Reddit digest two narrow authenticated endpoints:

- `POST /v1/reddit-comments` fetches exact, allowlisted Reddit thread RSS feeds.
- `POST /v1/summarize` validates optional Reddit-hosted images, attaches them
  locally to an offline Codex turn, and returns one validated 3–4 sentence
  summary per post.

Public `GET /healthz` reports process health. `GET /readyz` returns success only
when the isolated Codex volume contains device-auth state.

The service does not expose a general Codex session, arbitrary URL fetcher,
tools, files, environment variables, thread continuation, logs, or OAuth data.
Image fetching is restricted to exact Reddit CDN hosts and bounded by redirect,
MIME, signature, byte-size, dimension, timeout, and temporary-file controls.
See the repository [`SECURITY.md`](../SECURITY.md) for the full threat model.

## Local checks

```bash
npm ci --ignore-scripts
npm test
npm audit --omit=dev
docker compose --env-file ../.env.example config --quiet
docker build --no-cache -t local/reddit-community-summary-sidecar:0.2.0 .
```

Do not run `test/live-canary.mjs` unless a locally reachable, authenticated
sidecar is available. The canary never prints a credential value.
