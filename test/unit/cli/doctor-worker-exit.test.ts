// Verify worker qualification process status through the shipped CLI, without provider access.
import { access, chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorWorkerCliFixture } from '../../helpers/doctor-worker-cli.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const f = await doctorWorkerCliFixture();
  roots.push(f.root);
  return f;
}

describe('explicit doctor qualification exit status (#3690)', () => {
  it.each([true, false])('fails for writable installed code (JSON: %s)', async json => {
    const f = await fixture();
    const manifest = path.join(f.installed, 'package.json');
    await chmod(manifest, 0o664);
    const result = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', ...(json ? ['--json'] : [])]);
    expect(result.stdout).toContain('Installed module path is group/other-writable');
    const report = json ? JSON.parse(result.stdout) : JSON.parse(result.stdout.split('Worker qualification: ')[1].split('\n')[0]);
    const qualification = json ? report.qualification : report;
    expect(qualification).toMatchObject({ status: 'failed', results: [{ cli: 'codex', status: 'failed',
      message: expect.stringContaining(manifest) }] });
    if (json) expect(report.workers[0]).toMatchObject({ ready: true, inRange: true, reason: 'WORKER_DIRECT_READY' });
    else expect(result.stdout).toContain('Direct Worker codex: WORKER_DIRECT_READY');
    expect(result.code, result.stdout + result.stderr).toBe(1);
    expect((await stat(manifest)).mode & 0o777).toBe(0o664);
    await expect(access(path.join(f.config, 'worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const resolved = await f.resolve();
    expect(resolved.code).not.toBe(0);
    expect(resolved.stdout).toContain('OG_ADAPTER_UNQUALIFIED');
  }, 120_000);

  it.each([true, false])('returns zero for successful qualification (JSON: %s)', async json => {
    const f = await fixture();
    const result = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', ...(json ? ['--json'] : [])]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const report = json ? JSON.parse(result.stdout).qualification
      : JSON.parse(result.stdout.split('Worker qualification: ')[1].split('\n')[0]);
    expect(report.status).toBe('recorded');
    expect((await f.resolve()).code).toBe(0);
  }, 120_000);

  it('fails partial qualification when configured model observations are missing', async () => {
    const f = await fixture();
    const configFile = path.join(f.project, '.aiwg/aiwg.config');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    config.parallelism.groups.workers.members[0].model = 'missing-synthetic-model';
    await writeFile(configFile, JSON.stringify(config));
    const result = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(result.code, result.stdout + result.stderr).toBe(1);
    expect(JSON.parse(result.stdout).qualification.status).toBe('partial');
    expect(JSON.parse(result.stdout).workers[0].ready).toBe(true);
  }, 120_000);

  it('keeps installation probes advisory without qualification', async () => {
    const f = await fixture();
    await chmod(path.join(f.installed, 'package.json'), 0o664);
    const result = await f.run(['doctor', '--probe-workers', '--json']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ workers: [{ ready: true }] });
    expect(JSON.parse(result.stdout).qualification).toBeUndefined();
  }, 120_000);
  it('keeps plain doctor warnings advisory without qualification', async () => {
    const f = await fixture();
    await chmod(path.join(f.installed, 'package.json'), 0o664);
    const result = await f.run(['doctor']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('WARN');
    expect(result.stdout).not.toContain('Worker qualification:');
    await expect(access(path.join(f.config, 'worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it('documents explicit qualification status in public help', async () => {
    const f = await fixture();
    const result = await f.run(['doctor', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('failed or partial explicit worker qualification');
    expect(result.stdout).toContain('ordinary doctor warnings are advisory');
    expect(result.stdout).toContain('same exit status in text and JSON');
  }, 120_000);

});
