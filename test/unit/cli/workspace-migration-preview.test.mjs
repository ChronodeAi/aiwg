import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../../bin/aiwg.mjs', import.meta.url));

function snapshot(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(dir, entry.name);
    const relative = path.relative(root, file);
    return entry.isDirectory() ? [[relative, 'directory'], ...snapshot(root, file)] : [[relative, readFileSync(file).toString('base64')]];
  });
}

describe('workspace migration CLI', () => {
  for (const dryRun of [true, false]) {
    it(dryRun ? 'previews a legacy workspace without stdin or writes' : 'asks before live migration and respects a refusal', () => {
      const root = mkdtempSync(path.join(tmpdir(), 'aiwg-migration-preview-'));
      try {
        const project = path.join(root, 'project');
        const home = path.join(root, 'home');
        mkdirSync(path.join(project, '.aiwg', 'requirements'), { recursive: true });
        mkdirSync(home);
        writeFileSync(path.join(project, '.aiwg', 'requirements', 'sample.md'), 'operator artifact\n');
        const before = snapshot(project);
        const result = spawnSync(process.execPath, [cli, 'migrate-workspace', ...(dryRun ? ['--dry-run'] : [])], {
          cwd: project, input: dryRun ? '' : 'n\n', encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
          env: { ...process.env, HOME: home, NO_UPDATE_NOTIFIER: '1', AIWG_NO_UPDATE_CHECK: '1', AIWG_DECISION_ENABLED: '0' },
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('Found legacy workspace');
        if (dryRun) {
          expect(result.stdout).toContain('Dry-run complete (no changes made)');
          expect(result.stdout).not.toContain('Proceed with migration?');
        } else {
          expect(result.stdout).toContain('Proceed with migration?');
          expect(result.stdout).toContain('Migration cancelled by user.');
        }
        expect(snapshot(project)).toEqual(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
