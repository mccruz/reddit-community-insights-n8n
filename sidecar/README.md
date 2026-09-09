# Summarization service setup

For a no-install review, start with the [synthetic digest](../examples/sample-digest.md)
and [architecture](../docs/architecture.md). The instructions below are for an
operator deploying the service, not prerequisites for a recruiter to inspect it.

## Prerequisites

- A disposable or explicitly approved self-hosted n8n 2.x installation.
- Docker Engine/Desktop and Docker Compose v2; Python 3 for local file setup.
- An account authorized to use the repository's configured Codex model, with
  device-code login available; a Slack app credential and chosen channel.
- Permission to fetch Reddit feeds, make authenticated model requests, and send
  the two test messages before running the manual workflows.

The repository pins the CLI and SDK in `package-lock.json`. Building downloads
those packages. Authentication and workflow execution require network access;
“network disabled” refers to the model's tool sandbox, not the transport needed
to contact the model provider or retrieve the allowlisted Reddit evidence.

Run these commands from the repository root on macOS/Linux (Windows users can
use WSL):

```bash
git clone https://github.com/mccruz/reddit-community-insights-n8n.git
cd reddit-community-insights-n8n
docker version
docker compose version
```

## 1. Prepare private configuration

The public workflow remains inactive. Generate separate random values for the
service bearer token and the output-disclosure canary. This command refuses to
overwrite an existing configuration:

```bash
python3 - <<'PY'
from pathlib import Path
import os
import secrets

folder = Path('sidecar/secrets')
folder.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(folder, 0o700)
env_file = Path('.env')
token_file = folder / 'service_token'
if env_file.exists() or token_file.exists():
    raise SystemExit('Configuration already exists; reuse it or choose a fresh checkout.')
for path, text, mode in (
    (env_file, 'SIDECAR_CANARY_SECRET=' + secrets.token_hex(32) + '\n', 0o600),
    (token_file, secrets.token_hex(32) + '\n', 0o444),
):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, 'w') as output:
        output.write(text)
        os.fchmod(output.fileno(), mode)
print('Private configuration created; no secret values printed.')
PY
```

The token file is readable by the container's non-root user through its Docker
secret mount. The containing host directory is owner-only. Keep that directory,
`.env`, and the authentication volume private and out of Git.

## 2. Connect to the n8n network and build

The default external network is `n8n_default`:

```bash
docker network inspect n8n_default
```

If you are creating a new dedicated network, create it with
`docker network create n8n_default` and attach your n8n service through its Compose
configuration. Creating the network alone does not attach n8n. If your existing
n8n network has another name, add `N8N_NETWORK=your_network_name` to `.env`.
Confirm that n8n is attached before continuing; do not alter unrelated networks.

Use a fixed Compose project name so all commands share the same authentication
volume:

```bash
docker compose -p reddit-digest -f sidecar/compose.yaml --env-file .env config --quiet
docker compose -p reddit-digest -f sidecar/compose.yaml --env-file .env build summary-sidecar
```

No host port is published. n8n reaches the service at
`http://summary-sidecar:8787` over the shared Docker network.

## 3. Authenticate the dedicated volume

Run the pinned CLI inside a one-off container. Its configured `CODEX_HOME` is
`/var/lib/codex`, backed by the dedicated `codex_auth` volume:

```bash
docker compose -p reddit-digest -f sidecar/compose.yaml --env-file .env run --rm \
  --entrypoint /app/node_modules/.bin/codex summary-sidecar \
  -c 'cli_auth_credentials_store="file"' login --device-auth
```

Complete the displayed device-code flow yourself in your browser. If device
login is unavailable, check account/workspace settings and the
[official headless authentication guide](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).
Do not copy a personal Codex home directory into this service. The dedicated
volume must not contain unrelated tools, configuration, or session history.

Check the login without printing the authentication file:

```bash
docker compose -p reddit-digest -f sidecar/compose.yaml --env-file .env run --rm \
  --entrypoint /app/node_modules/.bin/codex summary-sidecar login status
```

The provider's account permissions and usage limits still apply. Login state
alone does not establish that the selected model can complete a request.

## 4. Start and check readiness

```bash
docker compose -p reddit-digest -f sidecar/compose.yaml --env-file .env up -d --wait --wait-timeout 60 summary-sidecar
docker compose -p reddit-digest -f sidecar/compose.yaml --env-file .env exec -T summary-sidecar \
  node --input-type=module -e 'for (const p of ["healthz", "readyz"]) { const r = await fetch(`http://127.0.0.1:8787/${p}`); console.log(p, r.status, await r.text()); if (!r.ok) process.exitCode = 1; }'
```

Compose waits up to 60 seconds for the container healthcheck before the next
command. If it times out, inspect the private service logs and correct startup
before retrying. See the [Compose wait options](https://docs.docker.com/reference/cli/docker/compose/up/).

Expected responses are `healthz 200 {"status":"ok"}` and
`readyz 200 {"status":"ready"}`. A `503 not_ready` means the service cannot find
`auth.json` in the volume. Readiness checks presence, not token validity; a real
summary request is a separate authenticated check.

## 5. Bind the imported n8n workflow

1. Import `workflow/reddit-community-digest.json` and leave it inactive.
2. Create an n8n **Header Auth** credential with header name `Authorization`
   and value `Bearer <your service token>`. Enter the value privately from the
   local secret file; never paste it into a workflow Code node or export.
3. Select that credential in both **Fetch … Recent Comments** nodes and both
   **Summarize … via Isolated Codex** nodes (four nodes in total).
4. Bind the Slack credential to the two **Slack - Send … Digest** nodes. Replace
   `YOUR_SLACK_CHANNEL_ID` with the intended channel ID and invite the Slack app
   to the channel if required by your workspace.
5. Once model usage and both message destinations are approved, run
   **Manual - r-codex** and **Manual - r-AI_Agents** separately. Each successful
   lane sends a message. Confirm the channel, source links, evidence labels,
   and absence of invented information.
6. Activate schedules only after that verification: 08:00 and 08:20 in
   `Asia/Manila`. Exported production credentials and identifiers stay private.

A `401` indicates service-token binding; `429 busy` means another request is
running. DNS errors usually mean n8n and the sidecar do not share the network.
A summary failure with ready status can indicate expired authentication,
provider access/limits, invalid model output, or unavailable source evidence.
Inspect private execution logs; do not share credentials or raw auth files.

## Checks without authentication

```bash
node scripts/validate-workflow.mjs workflow/reddit-community-digest.json
cd sidecar
npm ci --ignore-scripts
npm test
npm audit --omit=dev
```

The tests inject fixtures/mocks. They do not establish live model or Slack
success. `test/live-canary.mjs` requires separate authorization and a running
authenticated service; do not include it in routine offline checks.

## Stop and clean up

```bash
docker compose -p reddit-digest -f sidecar/compose.yaml --env-file .env down
```

This preserves the authentication volume for reuse and leaves the external n8n
network intact. To retire this deployment, sign out with the same one-off CLI
command ending in `logout`, then run the Compose `down` command with `--volumes`
to remove this project's authentication volume. Remove the local `.env` and
`sidecar/secrets/service_token` only after confirming they belong to this
retired deployment. Do not remove a shared n8n network or its volumes.

See [SECURITY.md](../SECURITY.md) for the request, image, sandbox, and output
controls and their residual risks.
