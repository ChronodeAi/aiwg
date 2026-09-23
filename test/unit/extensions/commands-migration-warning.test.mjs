/**
 * The duplicate-commands warning fired once per deployed framework/addon and
 * told the operator to `rm <command>.md` — a placeholder they had to expand
 * themselves, for files AIWG wrote.
 *
 * @issue #2541
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrateCommandsDirectory } from '../../../tools/agents/providers/base.mjs';

let root;
let warnings;
let warnSpy;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-cmd-migrate-'));
  warnings = [];
  warnSpy = vi.spyOn(console, 'warn').mockImplementation((v) => warnings.push(String(v)));
});

afterEach(async () => {
  warnSpy.mockRestore();
  await fs.rm(root, { recursive: true, force: true });
});

async function commandsDir(files) {
  // A unique directory per test: the dedupe cache is keyed by path and lives
  // for the process.
  const dir = path.join(root, `commands-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), body, 'utf8');
  }
  return dir;
}

const MANAGED = '<!-- aiwg:managed v1 -->\n\n# Managed command\n';
const OPERATOR = '# My own command\n';

describe('migrateCommandsDirectory skip warning (#2541)', () => {
  it('names the resolved files instead of a placeholder', async () => {
    const dir = await commandsDir({ 'flow-a.md': MANAGED, 'flow-b.md': MANAGED });
    migrateCommandsDirectory(dir, { skipCommandsMigration: true });

    const output = warnings.join('\n');
    expect(output).toContain('flow-a.md');
    expect(output).toContain('flow-b.md');
    expect(output).not.toContain('<command>.md');
    // The automated path is named, since AIWG wrote these files.
    expect(output).toContain('--skip-commands-migration');
  });

  it('warns once per directory, not once per deployed unit', async () => {
    const dir = await commandsDir({ 'flow-a.md': MANAGED });
    for (let i = 0; i < 7; i += 1) {
      migrateCommandsDirectory(dir, { skipCommandsMigration: true });
    }
    const headers = warnings.filter((line) => line.includes('commands migration skipped'));
    expect(headers).toHaveLength(1);
  });

  it('stays silent for a structural opt-out', async () => {
    const dir = await commandsDir({ 'flow-a.md': MANAGED });
    migrateCommandsDirectory(dir, { skipCommandsMigration: true, warnOnSkip: false });
    expect(warnings).toHaveLength(0);
  });

  it('stays silent when only operator-authored commands are present', async () => {
    const dir = await commandsDir({ 'mine.md': OPERATOR });
    migrateCommandsDirectory(dir, { skipCommandsMigration: true });
    expect(warnings).toHaveLength(0);
  });
});
