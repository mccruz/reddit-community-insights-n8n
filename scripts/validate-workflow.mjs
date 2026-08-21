import { readFile } from 'node:fs/promises';

const [workflowPath] = process.argv.slice(2);
if (!workflowPath) {
  throw new Error('usage: node scripts/validate-workflow.mjs <workflow.json>');
}

const raw = await readFile(workflowPath, 'utf8');
const workflow = JSON.parse(raw);
const nodes = workflow.nodes ?? [];
const byName = new Map(nodes.map((node) => [node.name, node]));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(workflow.name === 'Portfolio - Daily Reddit Community Digest to Slack', 'unexpected workflow name');
assert(nodes.length === 27, `expected 27 nodes, found ${nodes.length}`);
assert(workflow.settings?.timezone === 'Asia/Manila', 'timezone must be Asia/Manila');
assert(!nodes.some((node) => node.credentials), 'public workflow must not contain credential references');
assert(!/(?:access_token|refresh_token|id_token)\s*[=:]/i.test(raw), 'workflow contains token-like material');
assert(!/D0[A-Z0-9]{8,}/.test(raw), 'workflow contains a real-looking Slack destination ID');

const slackNodes = nodes.filter((node) => node.type === 'n8n-nodes-base.slack');
assert(slackNodes.length === 2, 'expected two Slack nodes');
assert(
  slackNodes.every((node) => node.parameters?.channelId?.value === 'YOUR_SLACK_CHANNEL_ID'),
  'Slack nodes must use the public placeholder',
);

const expectedTriggers = [
  'Manual - r-codex',
  'Schedule - r-codex at 08:00 Manila',
  'Manual - r-AI_Agents',
  'Schedule - r-AI_Agents at 08:20 Manila',
];
for (const name of expectedTriggers) assert(byName.has(name), `missing trigger: ${name}`);

for (const [source, groups] of Object.entries(workflow.connections ?? {})) {
  assert(byName.has(source), `connection source does not exist: ${source}`);
  for (const group of Object.values(groups)) {
    for (const output of group) {
      for (const edge of output) assert(byName.has(edge.node), `connection target does not exist: ${edge.node}`);
    }
  }
}

function reachable(start, target) {
  const queue = [start];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const groups = workflow.connections?.[current] ?? {};
    for (const group of Object.values(groups)) {
      for (const output of group) {
        for (const edge of output) queue.push(edge.node);
      }
    }
  }
  return false;
}

for (const lane of ['r-codex', 'r-AI_Agents']) {
  const target = `Slack - Send ${lane} Digest`;
  const laneTriggers = expectedTriggers.filter((name) => name.includes(lane));
  for (const trigger of laneTriggers) {
    assert(reachable(trigger, target), `${trigger} does not reach ${target}`);
  }
}

const allowedRemoteUrls = new Set([
  'https://www.reddit.com/r/codex/top/.rss?t=day&limit=10',
  'https://www.reddit.com/r/AI_Agents/top/.rss?t=day&limit=10',
  'http://summary-sidecar:8787/v1/reddit-comments',
  'http://summary-sidecar:8787/v1/summarize',
]);
for (const node of nodes) {
  const url = node.parameters?.url;
  if (url) assert(allowedRemoteUrls.has(url), `unexpected remote URL in ${node.name}: ${url}`);
}

console.log(JSON.stringify({
  status: 'passed',
  nodes: nodes.length,
  lanes: 2,
  credentialReferences: 0,
}));
