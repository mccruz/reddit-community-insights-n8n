import { PolicyError, normalizeSubreddit } from './policy.mjs';

const MAX_FEED_BYTES = 2 * 1024 * 1024;

function decodeEntities(value) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    '#39': "'", '#x27': "'", '#x2f': '/',
  };
  return String(value ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, key) => {
    const normalized = key.toLowerCase();
    if (named[normalized] !== undefined) return named[normalized];
    if (normalized.startsWith('#x')) return String.fromCodePoint(parseInt(normalized.slice(2), 16));
    if (normalized.startsWith('#')) return String.fromCodePoint(parseInt(normalized.slice(1), 10));
    return match;
  });
}

function plain(value, limit) {
  const text = decodeEntities(decodeEntities(value))
    .replace(/<a\b[^>]*>(.*?)<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function tagValue(block, tag) {
  const match = String(block).match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? match[1] : '';
}

export function normalizeRedditFeedRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PolicyError('invalid_request', 'request body must be an object');
  }
  if (!Array.isArray(value.postIds) || value.postIds.length < 1 || value.postIds.length > 3) {
    throw new PolicyError('invalid_request', 'postIds must contain between 1 and 3 items');
  }
  const postIds = value.postIds.map((postId, index) => {
    const normalized = String(postId ?? '').trim();
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(normalized)) {
      throw new PolicyError('invalid_request', `postIds[${index}] is invalid`);
    }
    return normalized;
  });
  if (new Set(postIds).size !== postIds.length) {
    throw new PolicyError('invalid_request', 'postIds must be unique');
  }
  return { subreddit: normalizeSubreddit(value.subreddit), postIds };
}

export function parseRedditCommentFeed(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > MAX_FEED_BYTES) {
    throw new PolicyError('reddit_unavailable', 'Reddit returned an invalid feed', 503);
  }
  const entries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  return entries
    .map((entry) => ({
      id: plain(tagValue(entry, 'id'), 100),
      postId: String(entry.match(/<link\b[^>]*href=["'][^"']*\/comments\/([A-Za-z0-9_-]+)\//i)?.[1] ?? ''),
      author: plain(tagValue(entry, 'author'), 80),
      body: plain(tagValue(entry, 'content'), 1500),
      score: null,
    }))
    .filter((comment) => /^t1_/i.test(comment.id) && comment.postId && comment.body)
    .slice(0, 100)
    .map(({ postId, author, body, score }) => ({ postId, author, body, score }));
}

function resetDelayMs(response) {
  const seconds = Number.parseFloat(response.headers.get('x-ratelimit-reset') ?? '60');
  const bounded = Number.isFinite(seconds) ? Math.min(Math.max(seconds + 1, 2), 65) : 60;
  return bounded * 1000;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchPostFeed(subreddit, postId, { fetchImpl, sleepImpl }) {
  const url = `https://www.reddit.com/comments/${postId}/.rss?sort=top&limit=10`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/atom+xml,text/xml;q=0.9,*/*;q=0.5',
        'user-agent': 'linux:n8n-reddit-community-digest:v1.1 (portfolio automation)',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) {
      const xml = await response.text();
      const expectedPath = new RegExp(`/r/${subreddit}/comments/${postId}/`, 'i');
      if (!expectedPath.test(xml)) {
        throw new PolicyError('reddit_unavailable', 'Reddit returned a mismatched comment feed', 503);
      }
      return { response, comments: parseRedditCommentFeed(xml) };
    }
    if (response.status === 429 && attempt === 0) {
      await sleepImpl(resetDelayMs(response));
      continue;
    }
    throw new PolicyError('reddit_unavailable', 'Reddit comment feed was unavailable', 503);
  }
  throw new PolicyError('reddit_unavailable', 'Reddit comment feed was unavailable', 503);
}

export async function fetchRedditComments(input, { fetchImpl = fetch, sleepImpl = sleep } = {}) {
  const comments = [];
  for (let index = 0; index < input.postIds.length; index += 1) {
    const { response, comments: postComments } = await fetchPostFeed(
      input.subreddit,
      input.postIds[index],
      { fetchImpl, sleepImpl },
    );
    comments.push(...postComments.filter((comment) => comment.postId === input.postIds[index]).slice(0, 10));
    if (index < input.postIds.length - 1) await sleepImpl(resetDelayMs(response));
  }
  return { comments };
}
