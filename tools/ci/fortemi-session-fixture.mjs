// Build a reproducible synthetic session shard through the shipped CLI.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { boundedSpawnSync } from '../../src/process/bounded-child-process.mjs';

export const fixtureClock = '2026-08-03T12:00:00.000Z';
export const sessionFixture = 'test/fixtures/sessions/claude/web-export.json';

export function buildSessionFixture(root) {
  const directory = mkdtempSync(join(tmpdir(), 'aiwg-fortemi-session-'));
  try {
    const home = join(directory, 'home');
    mkdirSync(home);
    const clock = join(directory, 'clock.mjs');
    // Clock injection is confined to synthetic CLI children; production APIs
    // continue using their normal clock. Stable timestamps make hashes useful.
    writeFileSync(clock, `const OriginalDate = Date;
globalThis.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [${JSON.stringify(fixtureClock)}])); }
  static now() { return new OriginalDate(${JSON.stringify(fixtureClock)}).getTime(); }
};\n`);
    writeFileSync(join(directory, 'web-export.json'), readFileSync(resolve(root, sessionFixture)));
    const execute = (args) => {
      const result = boundedSpawnSync(process.execPath, [
        '--import', clock, resolve(root, 'bin/aiwg.mjs'), 'sessions', ...args,
        '--db', join(directory, 'catalog.sqlite'), '--workspace', 'default', '--json',
      ], 'quick', {
        cwd: directory,
        env: {
          ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
          XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'),
          AIWG_ARTIFACT_ROOT: join(directory, 'artifacts'),
        },
        encoding: 'utf8',
      });
      if (result.error || result.status !== 0) {
        throw new Error(`Session fixture ${args[0]} failed: ${result.error?.message ?? result.stderr}`);
      }
      return JSON.parse(result.stdout).data;
    };
    execute(['import', 'web-export.json', '--provider', 'claude', '--source-id', 'fortemi-session-conformance']);
    const sessions = execute(['list']).items;
    if (sessions.length !== 2) throw new Error('Synthetic fixture must import two sessions');
    execute(['export', 'plan', '--session', sessions.map((session) => session.sessionId).join(','),
      '--out', join(directory, 'plan.json')]);
    const built = execute(['export', 'build', '--plan', join(directory, 'plan.json'), '--out', directory]);
    return {
      archive: readFileSync(built.shard),
      receipt: JSON.parse(readFileSync(built.receipt, 'utf8')),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
