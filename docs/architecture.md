# Architecture and design decisions

## Components

| Component | Responsibility | Trust level |
| --- | --- | --- |
| n8n schedule/manual triggers | Start one subreddit lane | Trusted configuration |
| Reddit RSS | Provide public posts and comments | Untrusted data |
| n8n Code nodes | Normalize, bound, correlate, and format | Trusted application logic |
| Sidecar Reddit fetcher | Construct exact allowlisted comment-feed URLs | Trusted network boundary |
| Isolated Codex process | Summarize only supplied evidence | Constrained, non-authoritative |
| Slack node | Deliver the validated digest | Trusted credentialed sink |

## Why two independent lanes?

Separate schedules make failures observable per community and avoid a Reddit
burst. They also produce the requested one-message-per-subreddit experience. A
manual n8n execution starts only its selected trigger; this is expected and does
not affect the independent schedules.

## Why a sidecar instead of a general community node?

The workflow initially needed richer summaries but should not give untrusted
Reddit text access to a general agent. The sidecar exposes only two fixed
operations: collect comments for allowlisted post IDs and summarize a bounded
evidence object. It does not expose a working directory selector, arbitrary
network destinations, skills, thread continuation, or tool output.

## Why exact thread feeds?

A subreddit-wide recent-comments feed can miss active comments on a displayed
top post. The sidecar instead requests each selected post's own RSS feed and
verifies that Reddit returned the expected subreddit and post identity before
using the comments.

## Failure behavior

- Invalid input fails before model execution.
- Reddit 429 responses receive one bounded retry based on the reset header.
- Unsupported or mismatched feeds return a generic availability error.
- Forbidden model activity or malformed output fails closed; n8n does not send
  an unvalidated AI response to Slack.
- Internal errors return only a request ID and generic error code.
