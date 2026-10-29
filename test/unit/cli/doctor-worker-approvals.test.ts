// Public offline approval management and synthetic qualification pruning regressions.
import { readFile, writeFile, rm, stat, access } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorWorkerCliFixture } from '../../helpers/doctor-worker-cli.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const f = await doctorWorkerCliFixture(); roots.push(f.root);
  const store = path.join(f.config, 'worker-installations.json');
  return { ...f, store };
}
const qualify = ['doctor', '--probe-workers', '--qualify', '--yes', '--json'];
const manage = ['doctor', '--probe-workers'];

describe('doctor worker approvals', () => {
  it('prunes deleted workspaces on qualification before applying the cap', async () => {
    const f = await fixture();
    const initial = await f.run(qualify);
    expect(initial.code, initial.stdout + initial.stderr).toBe(0);
    const stored = JSON.parse(await readFile(f.store, 'utf8'));
    const record = stored.registrations[0];
    const live = { ...record, cli: 'retained-live' };
    stored.registrations = [live, ...Array.from({ length: 127 }, (_, i) => ({ ...record,
      installation: { ...record.installation, cwd: path.join(f.root, `deleted-${i}`) } }))];
    await writeFile(f.store, JSON.stringify(stored));
    const result = await f.run(qualify);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const updated = JSON.parse(await readFile(f.store, 'utf8')).registrations;
    expect(updated).toHaveLength(2);
    expect(updated[0]).toEqual(live);
    expect(updated[1].cli).toBe('codex');
    expect((await stat(f.store)).mode & 0o777).toBe(0o600);
  });

  it('retains all 128 live approvals, allows replacement, and names the removal command when full', async () => {
    const f = await fixture();
    const initial = await f.run(qualify);
    expect(initial.code, initial.stdout + initial.stderr).toBe(0);
    const stored = JSON.parse(await readFile(f.store, 'utf8'));
    const record = stored.registrations[0];
    stored.registrations = [record, ...Array.from({ length: 127 }, (_, i) => ({ ...record, cli: `live-${i}` }))];
    await writeFile(f.store, JSON.stringify(stored));
    const replacement = await f.run(qualify);
    expect(replacement.code, replacement.stdout + replacement.stderr).toBe(0);
    expect(JSON.parse(await readFile(f.store, 'utf8')).registrations).toHaveLength(128);
    stored.registrations[0].cli = 'live-127';
    const bytes = JSON.stringify(stored);
    await writeFile(f.store, bytes);
    const full = await f.run(qualify);
    expect(full.code).toBe(1);
    expect(full.stdout + full.stderr).toContain('store is full');
    expect(full.stdout + full.stderr).toContain('aiwg doctor --probe-workers --forget-approval');
    expect(await readFile(f.store, 'utf8')).toBe(bytes);
  });

  it.each([false, true])('lists and removes offline with exact filtering (direct=%s)', async direct => {
    const f = await fixture();
    const records = [{ cli: 'codex', installation: { cwd: f.project } },
      { cli: 'muse', installation: { cwd: f.project } }];
    await writeFile(f.store, JSON.stringify({ version: 1, registrations: records }), { mode: 0o600 });
    await rm(path.join(f.project, '.aiwg'), { recursive: true });
    const listed = await f.run([...manage, '--list-approvals', '--json'], direct);
    expect(listed.code, listed.stdout + listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).approvals).toHaveLength(2);
    const text = await f.run([...manage, '--list-approvals', '--cli=codex'], direct);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain(`codex ${f.project}`);
    expect(text.stdout).not.toContain('muse');
    const unconfirmed = await f.run([...manage, '--forget-approval', f.project], direct);
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.stdout + unconfirmed.stderr).toContain('requires --yes');
    const removed = await f.run([...manage, `--forget-approval=${f.project}`, '--cli', 'codex', '--yes', '--json'], direct);
    expect(removed.code, removed.stdout + removed.stderr).toBe(0);
    expect(JSON.parse(removed.stdout).removed).toEqual([{ cli: 'codex', workspace: f.project }]);
    expect(JSON.parse(await readFile(f.store, 'utf8')).registrations).toEqual([records[1]]);
    const missing = await f.run([...manage, '--forget-approval', f.project, '--cli', 'codex', '--yes'], direct);
    expect(missing.code).toBe(1);
    expect(missing.stdout + missing.stderr).toContain('No worker approval found');
    const all = await f.run([...manage, '--forget-approval', f.project, '--yes'], direct);
    expect(all.code, all.stdout + all.stderr).toBe(0);
    expect(all.stdout).toContain(`Removed worker approval: muse ${f.project}`);
    expect((await stat(f.store)).mode & 0o777).toBe(0o600);
    await expect(access(`${f.store}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])('rejects missing values and incompatible management modes (direct=%s)', async direct => {
    const f = await fixture();
    for (const args of [
      ['doctor', '--list-approvals'], [...manage, '--forget-approval'],
      [...manage, '--list-approvals', '--qualify', '--yes'],
      [...manage, '--list-approvals', '--forget-approval', f.project, '--yes'],
      [...manage, '--list-approvals', '--dry-run'],
      [...manage, '--list-approvals', '--deployment'],
    ]) {
      const result = await f.run(args, direct);
      expect(result.code, result.stdout + result.stderr).toBe(2);
    }
    await expect(access(f.store)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
