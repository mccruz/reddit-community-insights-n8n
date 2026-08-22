import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PolicyError } from './policy.mjs';

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 12_000;
export const MAX_IMAGE_PIXELS = 40_000_000;

const ALLOWED_IMAGE_HOSTS = new Set(['i.redd.it', 'preview.redd.it']);
const MIME_TYPES = new Map([
  ['image/jpeg', { type: 'jpeg', extension: 'jpg' }],
  ['image/png', { type: 'png', extension: 'png' }],
  ['image/webp', { type: 'webp', extension: 'webp' }],
]);

export function normalizeRedditImageUrl(value, field = 'media.url') {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_000) {
    throw new PolicyError('invalid_request', `${field} must be a bounded URL string`);
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new PolicyError('invalid_request', `${field} must be a valid URL`);
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new PolicyError('invalid_request', `${field} must use an allowlisted Reddit image host`);
  }
  if (parsed.username || parsed.password || parsed.port) {
    throw new PolicyError('invalid_request', `${field} must not contain credentials or a custom port`);
  }
  parsed.hash = '';
  return parsed.toString();
}

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return null;
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

function webpDimensions(buffer) {
  if (buffer.length < 30) return null;
  const kind = buffer.toString('ascii', 12, 16);
  if (kind === 'VP8X') {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (kind === 'VP8L' && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >>> 14) & 0x3fff),
    };
  }
  if (kind === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

export function inspectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) {
    throw new PolicyError('media_invalid', 'Reddit image payload was invalid', 422);
  }
  let type;
  let dimensions;
  if (
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && buffer.toString('ascii', 12, 16) === 'IHDR'
  ) {
    type = 'png';
    dimensions = { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } else if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    type = 'jpeg';
    dimensions = jpegDimensions(buffer);
  } else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    type = 'webp';
    dimensions = webpDimensions(buffer);
  }
  if (!type || !dimensions || dimensions.width < 1 || dimensions.height < 1) {
    throw new PolicyError('media_invalid', 'Reddit image format was unsupported or malformed', 422);
  }
  if (
    dimensions.width > MAX_IMAGE_DIMENSION
    || dimensions.height > MAX_IMAGE_DIMENSION
    || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
  ) {
    throw new PolicyError('media_invalid', 'Reddit image dimensions exceeded policy', 422);
  }
  return { type, ...dimensions };
}

async function readBoundedBody(response) {
  const declared = Number.parseInt(response.headers.get('content-length') ?? '0', 10);
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new PolicyError('media_invalid', 'Reddit image exceeded the size limit', 422);
  }
  if (!response.body) throw new PolicyError('media_unavailable', 'Reddit image body was unavailable', 503);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) {
      throw new PolicyError('media_invalid', 'Reddit image exceeded the size limit', 422);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function fetchRedditImage(url, { fetchImpl = fetch } = {}) {
  const safeUrl = normalizeRedditImageUrl(url);
  let response;
  try {
    response = await fetchImpl(safeUrl, {
      headers: {
        accept: 'image/jpeg,image/png,image/webp',
        'user-agent': 'linux:n8n-reddit-community-digest:v1.2 (portfolio automation)',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new PolicyError('media_unavailable', 'Reddit image was unavailable', 503);
  }
  if (!response.ok || response.status >= 300) {
    throw new PolicyError('media_unavailable', 'Reddit image was unavailable', 503);
  }
  const mime = String(response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const expected = MIME_TYPES.get(mime);
  if (!expected) throw new PolicyError('media_invalid', 'Reddit image content type was unsupported', 422);
  const buffer = await readBoundedBody(response);
  const inspected = inspectImage(buffer);
  if (inspected.type !== expected.type) {
    throw new PolicyError('media_invalid', 'Reddit image type did not match its content', 422);
  }
  return { buffer, extension: expected.extension, ...inspected };
}

export async function materializePostImages(input, { fetchImpl = fetch, tempRoot = tmpdir() } = {}) {
  let directory = null;
  const imagePaths = [];
  const posts = [];
  for (const post of input.posts) {
    const normalizedPost = { ...post, comments: [...post.comments] };
    if (!post.media) {
      normalizedPost.media = { status: 'not_present' };
      posts.push(normalizedPost);
      continue;
    }
    try {
      const image = await fetchRedditImage(post.media.url, { fetchImpl });
      directory ??= await mkdtemp(path.join(tempRoot, 'reddit-media-'));
      const imagePath = path.join(directory, `${imagePaths.length + 1}-${post.id}.${image.extension}`);
      await writeFile(imagePath, image.buffer, { mode: 0o600, flag: 'wx' });
      imagePaths.push(imagePath);
      normalizedPost.media = {
        status: 'available',
        attachmentIndex: imagePaths.length,
        width: image.width,
        height: image.height,
      };
    } catch (error) {
      if (!(error instanceof PolicyError) || !['media_unavailable', 'media_invalid'].includes(error.code)) {
        throw error;
      }
      normalizedPost.media = { status: 'unavailable' };
    }
    posts.push(normalizedPost);
  }
  return {
    input: { ...input, posts },
    imagePaths,
    cleanup: async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}
