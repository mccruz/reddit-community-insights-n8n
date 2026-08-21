import { readFile, writeFile } from 'node:fs/promises';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error('usage: node scripts/sanitize-workflow.mjs <input.json> <output.json>');
}

const workflow = JSON.parse(await readFile(inputPath, 'utf8'));

for (const node of workflow.nodes ?? []) {
  delete node.credentials;

  if (typeof node.parameters?.url === 'string') {
    node.parameters.url = node.parameters.url.replace(
      'http://prodex-summary:8787',
      'http://summary-sidecar:8787',
    );
  }

  if (node.type === 'n8n-nodes-base.slack' && node.parameters?.channelId) {
    node.parameters.channelId = {
      __rl: true,
      mode: 'id',
      value: 'YOUR_SLACK_CHANNEL_ID',
    };
  }
}

const serialized = `${JSON.stringify(workflow, null, 2)}\n`;
const forbidden = [
  /D0[A-Z0-9]{8,}/,
  /redditDigestSlackV1/,
  /redditDigestSummarySidecarV1/,
  /Reddit Community Digest - Slack Bot/,
  /Reddit Digest - Isolated Summary Sidecar/,
  /prodex-summary/,
];

for (const pattern of forbidden) {
  if (pattern.test(serialized)) {
    throw new Error(`sanitization failed: matched ${pattern}`);
  }
}

await writeFile(outputPath, serialized, 'utf8');
