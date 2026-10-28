import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = 'tools/mission-protocol/inventory.mjs';

describe('Mission protocol inventory', () => {
  it('is reproducible and rejects newly unclassified consumers', () => {
    expect(execFileSync(process.execPath, [script], { timeout: 60_000, cwd: process.cwd(), encoding: 'utf8' })).toMatch(/Mission inventory: OK/);
    const inventory = JSON.parse(readFileSync('schemas/mission-protocol/inventory-v1.json', 'utf8'));
    const generated = inventory.entries.filter((entry: { canonicalSource?: string }) => entry.canonicalSource);
    expect(generated.length).toBeGreaterThan(0);
    for (const entry of generated) expect(existsSync(entry.canonicalSource), entry.path).toBe(true);
  });

  it('classifies every canonical module and mission-v1 fixture regardless of text markers', () => {
    const inventory = JSON.parse(readFileSync('schemas/mission-protocol/inventory-v1.json', 'utf8'));
    const paths = new Set(inventory.entries.map((entry: { path: string }) => entry.path));
    for (const file of readdirSync('src/mission-protocol').filter(file => file.endsWith('.ts'))) {
      expect(paths.has(`src/mission-protocol/${file}`), file).toBe(true);
    }
    expect(paths.has('test/conformance/mission-v1/fixtures/worker-contracts/delegation-vectors.json')).toBe(true);
  });

  it('falls back to the Git index when ripgrep is unavailable', () => {
    const output = execFileSync(process.execPath, [script], { timeout: 60_000,
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, AIWG_RG_BIN: 'aiwg-rg-is-intentionally-absent' },
    });
    expect(output).toMatch(/Mission inventory: OK/);
  });

  it('discovers only bounded version counts without exposing persisted mission content', async () => {
    const fixtureRoot = path.join(process.cwd(), `test-temp-mission-inventory-${process.pid}`);
    const sessions = path.join(fixtureRoot, '.aiwg/ralph-external/mc/sessions/fixture');
    await mkdir(sessions, { recursive: true });
    await writeFile(path.join(sessions, 'session.json'), JSON.stringify({ schemaVersion: 'mission-control/v1', objective: 'must never appear in report' }));
    try {
      const result = JSON.parse(execFileSync(process.execPath, [script, '--persisted-summary', '--root', fixtureRoot], { timeout: 60_000, cwd: process.cwd(), encoding: 'utf8' }));
      expect(result).toEqual({ root: path.basename(fixtureRoot), recordCount: 1, versions: [{ version: 'mission-control/v1', records: 1 }] });
      expect(JSON.stringify(result)).not.toContain('must never appear');
    } finally { await rm(fixtureRoot, { recursive: true, force: true }); }
  });

  it('fails closed for persisted-state roots outside the workspace', () => {
    const result = spawnSync(process.execPath, [script, '--persisted-summary', '--root', '/tmp'], { timeout: 60_000, cwd: process.cwd(), encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/outside the approved workspace/);
  });
});
