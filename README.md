# Reddit Community Insights with n8n

An n8n workflow that turns daily discussions from two Reddit communities
into separate Slack reading briefs. It helps a team choose which original
threads deserve attention. A restricted LLM summarizes the supplied evidence.

## Example result

**Illustrative synthetic digest excerpt:** “A team describes adding approval
checks to its agent workflow. The sampled discussion asks how failures are
recorded. Comment coverage is limited, so follow the original thread before
making a decision.”

A digest also identifies its community, links the original posts, and labels
unavailable image or comment evidence. See the
[complete illustrative sample](examples/sample-digest.md). It is not a live
Reddit extract or a measured model-quality result.

## My contribution

I built the independent n8n collection lanes, bounded Reddit evidence fetchers,
restricted summarization service, output validation, and Slack formatting. The
LLM writes summaries; fixed code controls sources, limits, and delivery format.

![Workflow architecture](assets/architecture.svg)

<a id="review-this-project-in-3-minutes"></a>

## Explore the project

Start with the example above, then follow the diagram and the
[engineering evidence](#engineering-evidence). Setup is optional for review.

## How it works

Each subreddit runs separately:

1. The workflow starts on schedule or manually for testing.
2. It collects the top three daily Reddit posts.
3. It gathers up to ten comments per post and reviews supported Reddit images.
4. An isolated AI service summarizes each post, image, and sampled discussion
   in 3–4 sentences.
5. n8n checks and formats the summaries.
6. Each subreddit receives a separate Slack digest with links to the original
   posts.

The schedules are staggered so the two communities do not request public Reddit
feeds at the same time:

| Community | Schedule | Manual test |
| --- | --- | --- |
| `r/codex` | Daily at 08:00 | `Manual - r-codex` |
| `r/AI_Agents` | Daily at 08:20 | `Manual - r-AI_Agents` |

The workflow uses the `Asia/Manila` timezone. Because the two manual triggers
are independent, n8n's canvas-level **Execute workflow** button starts only the
selected manual lane.

## Engineering evidence

| Capability | Implementation | Check |
| --- | --- | --- |
| Restrict input and output | [Policy](sidecar/src/policy.mjs) | [Policy tests](sidecar/test/policy.test.mjs) |
| Authenticate and isolate requests | [Server](sidecar/src/server.mjs) | [Server tests](sidecar/test/server.test.mjs) |
| Bound comment and image evidence | [Comments](sidecar/src/reddit.mjs), [images](sidecar/src/media.mjs) | [Comment tests](sidecar/test/reddit.test.mjs), [image tests](sidecar/test/media.test.mjs) |

## What “top” means

“Top discussions” is not an AI ranking. It means the first three valid posts
returned by Reddit's public `Top/day` RSS feed when the workflow runs. Comments
come from each post's exact RSS feed and are limited to ten entries, so the
digest does not claim to represent the entire community.

## Optional setup

The repository contains a sanitized workflow and an isolated summarization
service. A self-hosted deployment needs:

- n8n 2.x and Docker Compose;
- a Slack credential for the chosen destination;
- an authenticated Codex CLI volume for the summarization service; and
- a private service token between n8n and the sidecar.

The setup sequence is:

1. Import [`workflow/reddit-community-digest.json`](workflow/reddit-community-digest.json).
2. Build and authenticate the service using the
   [sidecar guide](sidecar/README.md).
3. Bind the private service and Slack credentials inside n8n.
4. Run each manual trigger, verify both Slack messages, and then activate the
   schedules.

The public export is deliberately inactive and contains no credential values,
private hostnames, or real Slack destination IDs. Do not commit an edited
production export after credentials have been bound.

## Safety and limits

Reddit posts, images, and comments are untrusted input. The workflow therefore:

- accepts posts and comments only from the two configured communities;
- accepts images only from approved Reddit image hosts and checks their type,
  size, and dimensions;
- limits the amount of text, comments, image data, and generated output;
- runs each summary in a fresh, read-only process without tools or network
  access;
- validates the response structure and rejects tool activity or secret-like
  output; and
- removes temporary images after the request finishes.

Public Reddit feeds can be delayed, incomplete, or rate-limited. The digest
labels unavailable evidence rather than inventing content. It does not include
comment scores, measure sentiment, or claim community consensus. Delivery also
depends on the operator's Slack permissions and self-hosted n8n reliability.

See the full [security model](SECURITY.md) and
[architecture notes](docs/architecture.md) for implementation detail.

## Verification

The repository includes checks for workflow structure, request validation,
authentication, Reddit feed parsing, image handling, output policy, and error
redaction. Run them with:

```bash
node scripts/validate-workflow.mjs workflow/reddit-community-digest.json
cd sidecar
npm ci --ignore-scripts
npm test
npm audit --omit=dev
```

The live canary is kept outside CI because it requires a running authenticated
service. CI and the importable workflow remain credential-free.

## Project guide

- [Architecture](docs/architecture.md)
- [Security model](SECURITY.md)
- [Sidecar setup](sidecar/README.md)
- [Importable workflow](workflow/reddit-community-digest.json)
- [Public reference review](docs/public-reference-review.md)

## License

[MIT](LICENSE)
