import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PolicyError,
  buildPrompt,
  containsSensitiveMaterial,
  hasForbiddenAgentActivity,
  normalizeRequest,
  sentenceCount,
  tokensEqual,
  validateModelResponse,
} from '../src/policy.mjs';

const validInput = {
  subreddit: 'codex',
  posts: [
    {
      id: 'abc123',
      title: 'Usage limits discussion',
      url: 'https://www.reddit.com/r/codex/comments/abc123/example/',
      body: 'The author asks whether weekly usage limits changed.',
      comments: [
        { author: 'reader', body: 'Several people say limits feel tighter.', score: 12 },
      ],
    },
  ],
};

test('normalizes only allowlisted Reddit evidence', () => {
  const result = normalizeRequest(validInput);
  assert.equal(result.subreddit, 'codex');
  assert.equal(result.posts.length, 1);
  assert.throws(
    () => normalizeRequest({ ...validInput, subreddit: 'secrets' }),
    (error) => error instanceof PolicyError && error.code === 'invalid_request',
  );
  assert.throws(
    () => normalizeRequest({ ...validInput, posts: [{ ...validInput.posts[0], url: 'https://example.com' }] }),
    PolicyError,
  );
});

test('labels Reddit text as untrusted evidence', () => {
  const prompt = buildPrompt(normalizeRequest(validInput));
  assert.match(prompt, /untrusted quoted data/);
  assert.match(prompt, /Do not call tools/);
  assert.match(prompt, /<reddit_evidence>/);
});

test('detects forbidden agent activity and sensitive output', () => {
  assert.equal(hasForbiddenAgentActivity([{ type: 'command_execution' }]), true);
  assert.equal(hasForbiddenAgentActivity([{ type: 'agent_message' }, { type: 'reasoning' }]), false);
  assert.equal(containsSensitiveMaterial('safe summary', 'CANARY-123'), false);
  assert.equal(containsSensitiveMaterial('leaked CANARY-123', 'CANARY-123'), true);
  assert.equal(containsSensitiveMaterial('refresh_token=secret'), true);
});

test('requires exactly three or four sentences', () => {
  assert.equal(sentenceCount('One. Two. Three.'), 3);
  assert.equal(sentenceCount('One. Two. Three. Four.'), 4);
  assert.equal(sentenceCount('One. Two.'), 2);
});

test('accepts only complete, schema-shaped, tool-free summaries', () => {
  const input = normalizeRequest(validInput);
  const result = validateModelResponse(
    {
      items: [{ type: 'reasoning' }, { type: 'agent_message' }],
      finalResponse: JSON.stringify({
        summaries: [{
          postId: 'abc123',
          summary: 'The post asks whether Codex weekly usage limits have become tighter. The supplied commenters report that their allowances also feel smaller. Some are comparing model versions and considering switching models. The evidence reflects user impressions rather than a confirmed policy change.',
        }],
      }),
    },
    input,
  );
  assert.equal(result.summaries[0].postId, 'abc123');

  assert.throws(
    () => validateModelResponse({ items: [{ type: 'command_execution' }], finalResponse: '{}' }, input),
    (error) => error.code === 'agent_tool_use_blocked',
  );
});

test('compares service tokens without accepting length mismatches', () => {
  assert.equal(tokensEqual('a'.repeat(32), 'a'.repeat(32)), true);
  assert.equal(tokensEqual('a'.repeat(31), 'a'.repeat(32)), false);
});
