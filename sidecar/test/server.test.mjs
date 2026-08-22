import test from 'node:test';
import assert from 'node:assert/strict';

import { createSidecarServer } from '../src/server.mjs';

const token = 'test-token-that-is-at-least-32-characters';
const body = {
  subreddit: 'AI_Agents',
  posts: [{
    id: 'post_1',
    title: 'Agent reliability',
    url: 'https://www.reddit.com/r/AI_Agents/comments/post_1/example/',
    body: 'The author describes a reliability experiment.',
    comments: [],
    commentsStatus: 'empty',
  }],
};

async function withServer(summarize, callback) {
  const server = createSidecarServer({ serviceToken: token, summarize });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('health is public but summaries require bearer authentication', async () => {
  await withServer(async () => ({ summaries: [] }), async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/summarize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })).status, 401);
  });
});

test('returns only the validated summarizer payload', async () => {
  const expected = { summaries: [{ postId: 'post_1', summary: 'A. B. C.' }] };
  await withServer(async () => expected, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/summarize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
  });
});

test('does not expose internal exception text', async () => {
  await withServer(async () => { throw new Error('secret internal detail'); }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/summarize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error, 'internal_error');
  });
});

test('exposes per-post comment status from the allowlisted Reddit fetcher', async () => {
  const comments = [{ postId: 'post_1', author: 'reader', body: 'A response.', score: null }];
  const posts = [{ postId: 'post_1', commentsStatus: 'available', comments }];
  const server = createSidecarServer({
    serviceToken: token,
    summarize: async () => ({ summaries: [] }),
    fetchComments: async (input) => {
      assert.deepEqual(input, { subreddit: 'codex', postIds: ['post_1'] });
      return { posts };
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/reddit-comments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subreddit: 'codex', postIds: ['post_1'] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { posts });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
