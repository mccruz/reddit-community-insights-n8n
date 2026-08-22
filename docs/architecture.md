# Architecture and design decisions

## Components

| Component | Responsibility | Trust level |
| --- | --- | --- |
| n8n schedule/manual triggers | Start one subreddit lane | Trusted configuration |
| Reddit RSS and image CDN | Provide public posts, images, and comments | Untrusted data |
| n8n Code nodes | Normalize, bound, correlate, and format | Trusted application logic |
| Sidecar Reddit fetcher | Construct exact comment-feed URLs and fetch allowlisted Reddit images | Trusted network boundary |
| Isolated Codex process | Summarize only supplied evidence | Constrained, non-authoritative |
| Slack node | Deliver the validated digest | Trusted credentialed sink |

## Why two independent lanes?

Separate schedules make failures observable per community and avoid a Reddit
burst. They also produce the requested one-message-per-subreddit experience. A
manual n8n execution starts only its selected trigger; this is expected and does
not affect the independent schedules.

## Why a sidecar instead of a general community node?

The workflow initially needed richer summaries but should not give untrusted
untrusted Reddit evidence access to a general agent. The sidecar exposes only
two fixed operations: collect comments for allowlisted post IDs and summarize a
bounded evidence object. Its own network client can reach only constructed
Reddit comment URLs and validated Reddit image URLs; the model remains offline.
The service does not expose a working directory selector, arbitrary network
destinations, skills, thread continuation, or tool output.

## Why exact thread feeds?

A subreddit-wide recent-comments feed can miss active comments on a displayed
top post. The sidecar instead requests each selected post's own RSS feed and
verifies that Reddit returned the expected subreddit and post identity before
using the comments.

## Why local image attachments?

Image-only submissions have no meaningful body text in RSS. n8n extracts an
image candidate from the feed, but the sidecar accepts only exact Reddit image
hosts and refuses redirects, unsupported MIME types, signature mismatches,
files larger than 4 MiB, and excessive dimensions. It stores a validated image
in the container's bounded temporary filesystem, attaches it to the isolated
Codex turn, and removes it after the request. Text visible inside an image is
still treated as untrusted evidence and receives no tools or network access.

## Failure behavior

- Invalid input fails before model execution.
- Reddit 429 responses receive one bounded retry based on the reset header.
- A failed comment request is reported per post as `unavailable`; it is never
  converted to an empty successful sample, and other post requests continue.
- Successful comment results are cached briefly to reduce duplicate Reddit
  traffic during retries and manual testing.
- Unsupported or mismatched feeds and invalid images are excluded with a
  generic availability state.
- Forbidden model activity or malformed output fails closed; n8n does not send
  an unvalidated AI response to Slack.
- Internal errors return only a request ID and generic error code.
