import fs from 'node:fs/promises';
import path from 'node:path';
export async function writeEditorialRecord({runId, artifact, mediaDir = process.env.MEDIA_ROOT ?? '/media'} = {}) {
  if (!runId || !artifact) throw new Error('EDITORIAL_RECORD_REQUIRED');
  const dir = path.join(mediaDir, 'editorial'); await fs.mkdir(dir, {recursive:true});
  const target = path.join(dir, `${runId}.json`); const temp = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temp, JSON.stringify({...artifact, run_id:runId, stored_at:new Date().toISOString()}, null, 2)); await fs.rename(temp, target); return target;
}
export async function readEditorialRecord(runId, mediaDir = process.env.MEDIA_ROOT ?? '/media') { return JSON.parse(await fs.readFile(path.join(mediaDir, 'editorial', `${runId}.json`), 'utf8')); }
