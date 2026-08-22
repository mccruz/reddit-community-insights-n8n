import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  MAX_IMAGE_BYTES,
  fetchRedditImage,
  inspectImage,
  materializePostImages,
  normalizeRedditImageUrl,
} from '../src/media.mjs';

function png(width = 640, height = 480) {
  const buffer = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test('accepts only HTTPS Reddit image hosts without credentials or ports', () => {
  assert.equal(normalizeRedditImageUrl('https://i.redd.it/example.png'), 'https://i.redd.it/example.png');
  assert.throws(() => normalizeRedditImageUrl('https://example.com/example.png'), /allowlisted/);
  assert.throws(() => normalizeRedditImageUrl('https://i.redd.it:8443/example.png'), /custom port/);
  assert.throws(() => normalizeRedditImageUrl('http://i.redd.it/example.png'), /allowlisted/);
});

test('validates image signatures and bounded dimensions', () => {
  assert.deepEqual(inspectImage(png()), { type: 'png', width: 640, height: 480 });
  assert.throws(() => inspectImage(Buffer.from('<svg><script>bad</script></svg>')), /unsupported or malformed/);
  assert.throws(() => inspectImage(png(12_001, 1)), /dimensions exceeded/);
});

test('rejects redirects, MIME mismatches, and oversized responses', async () => {
  await assert.rejects(
    fetchRedditImage('https://i.redd.it/example.png', {
      fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://example.com' } }),
    }),
    /unavailable/,
  );
  await assert.rejects(
    fetchRedditImage('https://i.redd.it/example.png', {
      fetchImpl: async () => new Response(png(), { status: 200, headers: { 'content-type': 'text/html' } }),
    }),
    /content type was unsupported/,
  );
  await assert.rejects(
    fetchRedditImage('https://i.redd.it/example.png', {
      fetchImpl: async () => new Response(png(), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(MAX_IMAGE_BYTES + 1) },
      }),
    }),
    /size limit/,
  );
});

test('materializes valid images with private permissions and removes temporary files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'reddit-media-test-'));
  try {
    const input = {
      subreddit: 'codex',
      posts: [{
        id: 'image_post',
        title: 'Screenshot post',
        url: 'https://www.reddit.com/r/codex/comments/image_post/example/',
        body: '',
        comments: [],
        commentsStatus: 'empty',
        media: { type: 'image', url: 'https://i.redd.it/example.png' },
      }],
    };
    const result = await materializePostImages(input, {
      tempRoot: root,
      fetchImpl: async () => new Response(png(), { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    assert.equal(result.imagePaths.length, 1);
    assert.deepEqual(result.input.posts[0].media, {
      status: 'available', attachmentIndex: 1, width: 640, height: 480,
    });
    await access(result.imagePaths[0]);
    assert.equal((await stat(result.imagePaths[0])).mode & 0o777, 0o600);
    await result.cleanup();
    await assert.rejects(access(result.imagePaths[0]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('degrades failed image retrieval without inventing visual evidence', async () => {
  const input = {
    subreddit: 'codex',
    posts: [{
      id: 'missing_image', title: 'Screenshot post', url: 'https://www.reddit.com/r/codex/comments/missing_image/example/',
      body: '', comments: [], commentsStatus: 'empty', media: { type: 'image', url: 'https://i.redd.it/missing.png' },
    }],
  };
  const result = await materializePostImages(input, {
    fetchImpl: async () => new Response('', { status: 404 }),
  });
  assert.deepEqual(result.input.posts[0].media, { status: 'unavailable' });
  assert.deepEqual(result.imagePaths, []);
  await result.cleanup();
});
