import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = relative => fs.readFile(new URL(relative, root), 'utf8');
const [html, css, client, server, operations] = await Promise.all([
  read('dashboard/public/index.html'),
  read('dashboard/public/styles.css'),
  read('dashboard/public/app.mjs'),
  read('dashboard/server.mjs'),
  read('dashboard/operations.mjs'),
]);

function verifyCapabilities(sources) {
  const checks = [
    [sources.html, /id="live"/, 'live monitor'],
    [sources.html, /class="mobile-dock"/, 'mobile navigation dock'],
    [sources.html, /id="refreshDashboard"/, 'manual refresh'],
    [sources.html, /data-filter="error"/, 'execution status filters'],
    [sources.html, /id="cronInput"/, 'schedule editor'],
    [sources.html, /id="videos"/, 'released video shelf'],
    [sources.client, /LIVE_POLL_MS\s*=\s*2500/, 'active-run polling interval'],
    [sources.client, /node\.state === 'active'/, 'active node presentation'],
    [sources.client, /pipeline-node/, 'node state rail'],
    [sources.client, /Failure at/, 'actionable failure context'],
    [sources.client, /visibilitychange/, 'background polling suspension'],
    [sources.server, /includeData=true/, 'n8n execution detail retrieval'],
    [sources.server, /workflowNodes/, 'workflow topology API payload'],
    [sources.operations, /state === 'running'|execution\.status === 'running'/, 'running execution mapping'],
    [sources.operations, /state = active\.has\(node\.name\) \? 'active'/, 'per-node runtime states'],
    [sources.css, /@media \(max-width: 720px\)/, 'mobile breakpoint'],
    [sources.css, /prefers-reduced-motion: reduce/, 'reduced motion support'],
    [sources.css, /\.dock-run[^}]*width:\s*50px[^}]*height:\s*50px/s, 'mobile primary touch target'],
  ];
  for (const [source, pattern, capability] of checks) assert.match(source, pattern, `Missing ${capability}`);
}

const sources = {html, css, client, server, operations};
verifyCapabilities(sources);

// Positive-control the negative oracle: removing the live monitor must make the same verifier fail.
assert.throws(
  () => verifyCapabilities({...sources, html:html.replace('id="live"', 'id="removed-live"')}),
  /Missing live monitor/,
);

console.log('dashboard capability verification passed');
