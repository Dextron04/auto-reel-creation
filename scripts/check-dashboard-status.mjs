const statusUrl = process.argv[2] ?? 'http://127.0.0.1:4000/api/status';

try {
  const response = await fetch(statusUrl);
  if (!response.ok) throw new Error(`dashboard status returned HTTP ${response.status}`);

  const status = await response.json();
  if (!status.renderer?.ok) throw new Error('renderer dependency is offline');
  if (!status.n8n?.ok) throw new Error(`n8n dependency is offline: ${status.n8n?.error ?? 'unknown error'}`);
  if (!status.n8n.workflow?.active || !Number.isInteger(status.n8n.workflow?.nodeCount) || status.n8n.workflow.nodeCount < 1) {
    throw new Error('n8n workflow metadata is unavailable or inactive');
  }

  console.log(`dashboard integration is healthy (${status.n8n.workflow.nodeCount} workflow nodes)`);
} catch (error) {
  console.error(`dashboard integration check failed: ${error.message}`);
  process.exitCode = 1;
}
