import fs from 'node:fs/promises';
import path from 'node:path';

const SECRET_KEY = /authorization|api[-_]?key|token|secret|headers/i;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, nested] of Object.entries(value)) {
    copy[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redact(nested);
  }
  return copy;
}

function validateRunId(runId) {
  return typeof runId === 'string' && SAFE_RUN_ID.test(runId) && runId !== '.' && runId !== '..';
}

export async function writeResearchRecord({ runId, record, mediaDir = process.env.MEDIA_ROOT ?? '/media' } = {}) {
  if (runId === undefined || runId === null || !record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('RESEARCH_RECORD_REQUIRED');
  }
  if (!validateRunId(runId)) throw new Error('RESEARCH_RECORD_RUN_ID_INVALID');
  const dir = path.join(mediaDir, 'research-runs');
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${runId}.json`);
  const temp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const payload = {
    ...redact(record),
    run_id: runId,
    stored_at: new Date().toISOString(),
  };
  try {
    await fs.writeFile(temp, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return target;
}
