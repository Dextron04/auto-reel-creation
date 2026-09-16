import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

function composeConfig() {
  return JSON.parse(execFileSync('docker', ['compose', 'config', '--format', 'json'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  }));
}

test('the containerized dashboard reaches n8n over the Compose service network', () => {
  const config = composeConfig();

  assert.equal(config.services.dashboard.environment.N8N_BASE_URL, 'http://n8n:5678');
});

function runStatusCheck(status) {
  const url = `data:application/json,${encodeURIComponent(JSON.stringify(status))}`;
  return spawnSync(process.execPath, ['scripts/check-dashboard-status.mjs', url], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
}

test('deployment status check accepts a dashboard with live n8n workflow data', () => {
  const result = runStatusCheck({
    renderer: { ok: true },
    n8n: { ok: true, workflow: { active: true, nodeCount: 43 }, error: null },
  });

  assert.equal(result.status, 0, result.stderr);
});

test('deployment status check rejects a dashboard whose n8n dependency is offline', () => {
  const result = runStatusCheck({
    renderer: { ok: true },
    n8n: { ok: false, workflow: null, error: 'fetch failed' },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /n8n.*fetch failed/i);
});
