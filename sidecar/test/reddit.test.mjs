import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchRedditComments,
  normalizeRedditFeedRequest,
  parseRedditCommentFeed,
} from '../src/reddit.mjs';

test('allowlists subreddit comment-feed requests', () => {
  assert.deepEqual(
    normalizeRedditFeedRequest({ subreddit: 'r/AI_Agents', postIds: ['abc123'] }),
    { subreddit: 'AI_Agents', postIds: ['abc123'] },
  );
  assert.throws(() => normalizeRedditFeedRequest({ subreddit: 'all', postIds: ['abc123'] }), /not allowlisted/);
  assert.throws(() => normalizeRedditFeedRequest({ subreddit: 'codex', postIds: [] }), /between 1 and 3/);
});

test('fetches exact post feeds sequentially and verifies subreddit/post identity', async () => {
  const requested = [];
  const delays = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const postId = url.match(/comments\/([^/]+)\//)[1];
    const xml = `<?xml version="1.0"?><feed><entry><id>t1_${postId}</id>
      <author><name>u/example</name></author>
      <link href="https://www.reddit.com/r/codex/comments/${postId}/example/comment/"/>
      <content>A response for ${postId}.</content></entry></feed>`;
    return new Response(xml, { status: 200, headers: { 'x-ratelimit-reset': '1' } });
  };
  const result = await fetchRedditComments(
    { subreddit: 'codex', postIds: ['abc123', 'def456'] },
    { fetchImpl, sleepImpl: async (milliseconds) => delays.push(milliseconds) },
  );
  assert.equal(requested.length, 2);
  assert.equal(delays.length, 1);
  assert.deepEqual(result.posts.map((post) => post.postId), ['abc123', 'def456']);
  assert.deepEqual(result.posts.map((post) => post.commentsStatus), ['available', 'available']);
  assert.deepEqual(result.posts.flatMap((post) => post.comments).map((comment) => comment.postId), ['abc123', 'def456']);
});

test('marks a rate-limited post unavailable and continues collecting later posts', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const postId = url.match(/comments\/([^/]+)\//)[1];
    if (postId === 'limited789') return new Response('', { status: 429, headers: { 'x-ratelimit-reset': '1' } });
    const xml = `<?xml version="1.0"?><feed><entry><id>t1_${postId}</id>
      <author><name>u/example</name></author>
      <link href="https://www.reddit.com/r/codex/comments/${postId}/example/comment/"/>
      <content>A later response.</content></entry></feed>`;
    return new Response(xml, { status: 200, headers: { 'x-ratelimit-reset': '1' } });
  };
  const result = await fetchRedditComments(
    { subreddit: 'codex', postIds: ['limited789', 'later789'] },
    { fetchImpl, sleepImpl: async () => {} },
  );
  assert.equal(requested.length, 3);
  assert.deepEqual(result.posts.map(({ postId, commentsStatus }) => ({ postId, commentsStatus })), [
    { postId: 'limited789', commentsStatus: 'unavailable' },
    { postId: 'later789', commentsStatus: 'available' },
  ]);
});

test('marks a network failure unavailable instead of returning an empty successful sample', async () => {
  const result = await fetchRedditComments(
    { subreddit: 'codex', postIds: ['networkfail789'] },
    { fetchImpl: async () => { throw new Error('socket failed'); }, sleepImpl: async () => {} },
  );
  assert.deepEqual(result.posts, [{ postId: 'networkfail789', commentsStatus: 'unavailable', comments: [] }]);
});

test('parses only bounded public t1 comment entries and their post IDs', () => {
  const xml = `<?xml version="1.0"?><feed>
    <entry><id>t3_post</id><content>Original post</content></entry>
    <entry><id>t1_comment</id><author><name>u/example</name></author>
      <link href="https://www.reddit.com/r/codex/comments/abc123/example/comment/"/>
      <content type="html">&lt;p&gt;A public response about the post.&lt;/p&gt;</content>
    </entry>
  </feed>`;
  assert.deepEqual(parseRedditCommentFeed(xml), [{
    postId: 'abc123',
    author: 'u/example',
    body: 'A public response about the post.',
    score: null,
  }]);
});
