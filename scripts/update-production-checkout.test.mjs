import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const script = new URL('./update-production-checkout.sh', import.meta.url).pathname;

function git(cwd, ...args) {
  const result = spawnSync('git', args, {cwd, encoding: 'utf8'});
  assert.equal(result.status, 0, `git ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

async function setupDivergedCheckout() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reel-deploy-sync-'));
  const remote = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const production = path.join(root, 'production');
  const backupRoot = path.join(root, 'backups');
  await mkdir(remote);
  git(remote, 'init', '--bare', '--initial-branch=main');
  await mkdir(seed);
  git(seed, 'init', '--initial-branch=main');
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'user.name', 'Test');
  await writeFile(path.join(seed, 'app.txt'), 'base\n');
  git(seed, 'add', 'app.txt');
  git(seed, 'commit', '-m', 'base');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-u', 'origin', 'main');
  git(root, 'clone', remote, production);
  git(production, 'config', 'user.email', 'test@example.com');
  git(production, 'config', 'user.name', 'Test');
  await writeFile(path.join(production, 'local.txt'), 'local commit\n');
  await writeFile(path.join(production, '.env.prod'), 'SECRET=preserved\n');
  git(production, 'add', 'local.txt', '.env.prod');
  git(production, 'commit', '-m', 'local-only');
  await writeFile(path.join(production, 'app.txt'), 'dirty tracked edit\n');
  await writeFile(path.join(seed, 'remote.txt'), 'remote commit\n');
  git(seed, 'add', 'remote.txt');
  git(seed, 'commit', '-m', 'remote-only');
  git(seed, 'push', 'origin', 'main');
  return {root, remote, seed, production, backupRoot};
}

test('deployment sync backs up a dirty diverged checkout before aligning it to origin/main', async () => {
  const {production, backupRoot} = await setupDivergedCheckout();
  const result = spawnSync('sh', [script, production, 'main'], {
    encoding: 'utf8',
    env: {...process.env, DEPLOY_BACKUP_ROOT: backupRoot},
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(git(production, 'rev-parse', 'HEAD'), git(production, 'rev-parse', 'origin/main'));
  assert.equal(await readFile(path.join(production, 'app.txt'), 'utf8'), 'base\n');
  assert.equal(await readFile(path.join(production, '.env.prod'), 'utf8'), 'SECRET=preserved\n');
  const backups = await readdir(backupRoot);
  assert.equal(backups.length, 1);
  const backup = path.join(backupRoot, backups[0]);
  assert.equal(await stat(path.join(backup, 'local-commits.bundle')).then(() => true), true);
  assert.match(await readFile(path.join(backup, 'tracked-changes.patch'), 'utf8'), /dirty tracked edit/);
  const recovered = path.join(path.dirname(production), 'recovered');
  git(path.dirname(production), 'clone', path.join(backup, 'local-commits.bundle'), recovered);
  assert.equal(await readFile(path.join(recovered, 'local.txt'), 'utf8'), 'local commit\n');
});

test('deployment sync backs up a detached dirty checkout before changing branches', async () => {
  const {production, backupRoot} = await setupDivergedCheckout();
  const localHead = git(production, 'rev-parse', 'HEAD');
  git(production, 'checkout', '--detach', localHead);
  await writeFile(path.join(production, 'app.txt'), 'detached dirty edit\n');

  const result = spawnSync('sh', [script, production, 'main'], {
    encoding: 'utf8',
    env: {...process.env, DEPLOY_BACKUP_ROOT: backupRoot},
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(git(production, 'rev-parse', 'HEAD'), git(production, 'rev-parse', 'origin/main'));
  const backups = await readdir(backupRoot);
  assert.equal(backups.length, 1);
  assert.match(await readFile(path.join(backupRoot, backups[0], 'status.txt'), 'utf8'), /HEAD \(no branch\)/);
  assert.match(await readFile(path.join(backupRoot, backups[0], 'tracked-changes.patch'), 'utf8'), /detached dirty edit/);
});

test('deployment sync refuses a remote commit that tracks the production env file', async () => {
  const {seed, production, backupRoot} = await setupDivergedCheckout();
  await writeFile(path.join(seed, '.env.prod'), 'SECRET=remote-value\n');
  git(seed, 'add', '.env.prod');
  git(seed, 'commit', '-m', 'unsafe tracked env');
  git(seed, 'push', 'origin', 'main');
  const originalHead = git(production, 'rev-parse', 'HEAD');

  const result = spawnSync('sh', [script, production, 'main'], {
    encoding: 'utf8',
    env: {...process.env, DEPLOY_BACKUP_ROOT: backupRoot},
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tracks \.env\.prod/);
  assert.equal(git(production, 'rev-parse', 'HEAD'), originalHead);
  assert.equal(await readFile(path.join(production, '.env.prod'), 'utf8'), 'SECRET=preserved\n');
});

test('deployment sync refuses to place recovery backups inside the production checkout', async () => {
  const {production} = await setupDivergedCheckout();
  const originalHead = git(production, 'rev-parse', 'HEAD');
  const result = spawnSync('sh', [script, production, 'main'], {
    encoding: 'utf8',
    env: {...process.env, DEPLOY_BACKUP_ROOT: path.join(production, 'backups')},
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be outside/);
  assert.equal(git(production, 'rev-parse', 'HEAD'), originalHead);
});
