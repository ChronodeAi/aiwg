/**
 * @source @tools/agents/providers/dsh.mjs
 *
 * A direct addon source (`aiwg use <addon>`, required addons) carries its skills
 * in <source>/skills/. The dsh deployer used to walk only $AIWG_ROOT layouts, so
 * it deployed none of them and support-asset reconciliation then failed with
 * "deployed skill '<name>' not found".
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deploy } from '../../../tools/agents/providers/dsh.mjs';

describe('dsh deploy from a direct addon source', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiwg-dsh-addon-'));
    const skillDir = join(root, 'addon', 'skills', 'session-explore');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: session-explore\ndescription: Explore provider sessions\n---\n\n# Session explore\n',
    );
    mkdirSync(join(root, 'project'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('places the addon skills on the standard tier when copying all', async () => {
    await deploy({
      srcRoot: join(root, 'addon'),
      target: join(root, 'project'),
      mode: 'all',
      deploySkills: true,
      copyStandardSkills: true,
      quiet: true,
    });
    expect(existsSync(join(root, 'project', '.dsh', '.aiwg', 'skills', 'session-explore', 'SKILL.md'))).toBe(true);
  });
});
