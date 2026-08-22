import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import {
  MAX_REQUEST_BYTES,
  PolicyError,
  buildOutputSchema,
  buildPrompt,
  normalizeRequest,
  tokensEqual,
  validateModelResponse,
} from './policy.mjs';
import {
  fetchRedditComments,
  normalizeRedditFeedRequest,
} from './reddit.mjs';
import { materializePostImages } from './media.mjs';

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);
const CODEX_HOME = process.env.CODEX_HOME ?? '/var/lib/codex';
const WORKING_DIRECTORY = process.env.WORKING_DIRECTORY ?? '/work';
const MODEL = process.env.CODEX_MODEL ?? 'gpt-5.4-mini';
const REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT ?? 'medium';
const TURN_TIMEOUT_MS = Number.parseInt(process.env.TURN_TIMEOUT_MS ?? '180000', 10);
const SERVICE_TOKEN_FILE = process.env.SERVICE_TOKEN_FILE ?? '/run/secrets/service_token';

function loadServiceToken() {
  const value = readFileSync(SERVICE_TOKEN_FILE, 'utf8').trim();
  if (value.length < 32) throw new Error('service token is missing or too short');
  return value;
}

function childEnvironment() {
  const env = {
    CODEX_HOME,
    HOME: CODEX_HOME,
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NODE_ENV: 'production',
  };
  if (existsSync('/etc/ssl/certs/ca-certificates.crt')) {
    env.SSL_CERT_FILE = '/etc/ssl/certs/ca-certificates.crt';
  }
  return env;
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(payload);
}

async function readJson(request) {
  const declared = Number.parseInt(request.headers['content-length'] ?? '0', 10);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw new PolicyError('request_too_large', 'request body is too large', 413);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new PolicyError('request_too_large', 'request body is too large', 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new PolicyError('invalid_json', 'request body must be valid JSON');
  }
}

export async function runCodexSummary(input, {
  canarySecret = process.env.SIDECAR_CANARY_SECRET ?? '',
  materializeImages = materializePostImages,
} = {}) {
  const { Codex } = await import('@openai/codex-sdk');
  const codex = new Codex({
    env: childEnvironment(),
    config: {
      web_search: 'disabled',
      sandbox_workspace_write: { network_access: false },
    },
  });
  const materialized = await materializeImages(input);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const thread = codex.startThread({
        model: MODEL,
        sandboxMode: 'read-only',
        workingDirectory: WORKING_DIRECTORY,
        skipGitRepoCheck: true,
        modelReasoningEffort: REASONING_EFFORT,
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
        approvalPolicy: 'never',
        additionalDirectories: [],
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
      try {
        const modelInput = [
          { type: 'text', text: buildPrompt(materialized.input) },
          ...materialized.imagePaths.map((imagePath) => ({ type: 'local_image', path: imagePath })),
        ];
        const result = await thread.run(modelInput, {
          outputSchema: buildOutputSchema(input.posts.map((post) => post.id)),
          signal: controller.signal,
        });
        return validateModelResponse(result, input, canarySecret);
      } catch (error) {
        const retryableOutput = error instanceof PolicyError
          && ['invalid_model_output', 'model_failure'].includes(error.code);
        if (attempt === 0 && retryableOutput) continue;
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new PolicyError('model_failure', 'model returned no valid result', 502);
  } finally {
    await materialized.cleanup();
  }
}

export function createSidecarServer({
  serviceToken,
  summarize = runCodexSummary,
  fetchComments = fetchRedditComments,
} = {}) {
  if (!serviceToken) throw new Error('service token is required');
  let busy = false;
  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        return sendJson(response, 200, { status: 'ok' });
      }
      if (request.method === 'GET' && request.url === '/readyz') {
        const ready = existsSync(`${CODEX_HOME}/auth.json`);
        return sendJson(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' });
      }
      const isSummary = request.method === 'POST' && request.url === '/v1/summarize';
      const isRedditFeed = request.method === 'POST' && request.url === '/v1/reddit-comments';
      if (!isSummary && !isRedditFeed) {
        return sendJson(response, 404, { error: 'not_found', requestId });
      }
      const authorization = request.headers.authorization ?? '';
      const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!tokensEqual(provided, serviceToken)) {
        return sendJson(response, 401, { error: 'unauthorized', requestId });
      }
      if (busy) {
        return sendJson(response, 429, { error: 'busy', requestId });
      }
      if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        throw new PolicyError('unsupported_media_type', 'content type must be application/json', 415);
      }
      const body = await readJson(request);
      const input = isSummary ? normalizeRequest(body) : normalizeRedditFeedRequest(body);
      busy = true;
      try {
        const result = isSummary ? await summarize(input) : await fetchComments(input);
        return sendJson(response, 200, result);
      } finally {
        busy = false;
      }
    } catch (error) {
      if (error instanceof PolicyError) {
        return sendJson(response, error.status, { error: error.code, requestId });
      }
      console.error(JSON.stringify({ level: 'error', event: 'request_failed', requestId }));
      return sendJson(response, 500, { error: 'internal_error', requestId });
    }
  });
  server.requestTimeout = (TURN_TIMEOUT_MS * 2) + 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

function main() {
  const serviceToken = loadServiceToken();
  const server = createSidecarServer({ serviceToken });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(JSON.stringify({ level: 'info', event: 'listening', port: PORT }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
