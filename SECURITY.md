# Security policy

## Supported scope

This repository is a reference implementation for two allowlisted Reddit
communities. It intentionally does not expose a general-purpose agent endpoint,
arbitrary URLs, shell commands, files, tools, thread continuation, or OAuth data.

## Threat model

The primary hostile input is text controlled by Reddit authors and commenters.
That text may contain prompt-injection instructions, fake system messages,
encoded data, malicious links, or requests to reveal secrets. A caller may also
attempt oversized requests, unsupported subreddits, arbitrary post IDs,
unauthorized access, output-shape manipulation, or denial of service.

## Controls

### Before model execution

- Only `r/codex` and `r/AI_Agents` are accepted.
- The Reddit fetcher constructs fixed HTTPS Reddit paths itself; callers cannot
  choose a host.
- Post IDs, Reddit URLs, text lengths, post counts, comment counts, and total
  request bytes are validated and bounded.
- The endpoint requires a bearer token stored as a Docker secret and compares it
  with constant-time primitives after checking equal length.
- Only one expensive sidecar request runs at a time.

### During model execution

- Every request starts a new thread.
- The model runs read-only with network access, web search, approvals, and tool
  use disabled.
- The child receives a small environment allowlist rather than the sidecar or
  n8n environment.
- Reddit text is delimited and explicitly labeled untrusted quoted evidence.

### After model execution

- Command, file-change, MCP, and web-search events fail closed.
- Output must match a strict post-ID schema and contain exactly three or four
  sentences per post within a fixed character limit.
- Secret-like values and a deployment-specific canary marker are rejected.
- Internal exception text, model traces, thread IDs, and authentication material
  are never returned to n8n.

### Container boundary

- Non-root process, read-only root filesystem, no Linux capabilities, no-new-
  privileges, PID/CPU/memory limits, and a small hardened temporary filesystem.
- The service joins only n8n's internal Docker network; no host port is required.
- The OAuth volume is mounted only into the sidecar, never into n8n.

## Deployment requirements

- Generate a unique service token; never use the example text as a credential.
- Generate a deployment-specific canary marker in `.env`.
- Keep `sidecar/secrets/`, `.env`, n8n credential exports, OAuth files, and Slack
  IDs out of Git.
- Bind n8n credentials only after importing the sanitized workflow.
- Review dependency updates and rerun tests, `npm audit`, a container build, and
  the live injection canary before deployment.

## Residual risks

No prompt-injection defense is perfect. The security boundary therefore relies
on capability removal and output validation, not model obedience alone. A model
could still produce a misleading summary within the allowed schema, and public
RSS can return incomplete evidence. Human readers should follow the included
Reddit links when a decision depends on accuracy.

## Reporting

Please open a GitHub security advisory for suspected vulnerabilities. Do not put
tokens, OAuth files, private Slack messages, or exploit payloads containing real
credentials in a public issue.
