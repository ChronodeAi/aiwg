import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAdapter } from '../../../src/skills/adapters/local.js';
import { resolveAgentSkillCollision } from '../../../src/skills/agent-skills.js';
import { discoverLocalSkillOwners, selectSkillOwners } from '../../../src/skills/collision-discovery.js';
import { deployImportedAgentSkill, inspectImportedAgentSkillProjection } from '../../../src/skills/deployer.js';
import { importAgentSkill } from '../../../src/skills/importer.js';
import { getAllAdapters, getSkillInfo, listSkills, searchSkills } from '../../../src/skills/registry.js';
import { main as skillsMain } from '../../../src/skills/cli.js';
import { buildAgentSkillsDoctorSection } from '../../../src/skills/doctor.js';

let root: string;
let projectDir: string;
let homeDir: string;
let packagedRoot: string;
const name = 'collision-fixture';

function writeSkill(directory: string, description: string): string {
  fs.mkdirSync(directory, { recursive: true });
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n# Fixture\n\n${description}\n`;
  fs.writeFileSync(path.join(directory, 'SKILL.md'), content);
  return content;
}

function synced(): string {
  return path.join(homeDir, '.claude', 'skills', 'synced', name);
}

function adapter(): LocalAdapter {
  return new LocalAdapter({ projectDir, homeDir }, packagedRoot);
}

async function importActive(): Promise<void> {
  const source = path.join(root, 'source', name);
  writeSkill(source, 'Imported source');
  await importAgentSkill({ kind: 'directory', path: source }, {
    projectDir, trust: true, activate: true,
  });
}

function options(dryRun = false) {
  return { projectDir, homeDir, target: 'claude', dryRun };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-synced-collisions-'));
  projectDir = path.join(root, 'project');
  homeDir = path.join(root, 'home');
  packagedRoot = path.join(root, 'packaged');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(homeDir);
  vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
  writeSkill(path.join(packagedRoot, 'agentic', 'code', 'addons', 'fixture', 'skills', name), 'Packaged source');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('synced skill collision discovery and diagnostics', () => {
  it.each([
    ['aiwg-managed', 'synced'], ['project', 'project'], ['user', 'user'], ['imported', 'synced'],
  ] as const)('resolves synced against %s regardless of enumeration order', (other, winner) => {
    expect(resolveAgentSkillCollision(['synced', other])).toBe(winner);
    expect(resolveAgentSkillCollision([other, 'synced'])).toBe(winner);
  });

  it.each(['aiwg-managed', 'project', 'user'] as const)(
    'selects the documented owner and names both origins against %s', async (other) => {
      const syncedContent = writeSkill(synced(), 'Account synced');
      if (other !== 'aiwg-managed') {
        writeSkill(path.join(other === 'project' ? projectDir : homeDir, '.claude', 'skills', name), other);
      }
      const local = adapter();
      const expected = other === 'aiwg-managed' ? 'synced' : other;
      const listed = (await local.list()).filter(skill => skill.name === name);
      expect(listed).toHaveLength(1);
      expect(listed[0].origin).toBe(expected);
      const detail = await local.info(name);
      expect(detail?.origin).toBe(expected);
      expect(detail?.content).toContain(expected === 'synced' ? 'Account synced' : other);
      const diagnostics = detail!.diagnostics!.map(item => item.message).join('\n');
      expect(diagnostics).toContain('synced-owned');
      expect(diagnostics).toContain(`${other}-owned`);
      expect((await local.search('collision-fixture'))[0].origin).toBe(expected);
      expect(fs.readFileSync(path.join(synced(), 'SKILL.md'), 'utf8')).toBe(syncedContent);
      // list() must observe account refreshes even after the packaged catalog is cached.
      fs.rmSync(synced(), { recursive: true });
      expect((await local.info(name))?.origin).toBe(other);
    },
  );

  it('keeps project above user and synced and breaks same-origin ties by path', () => {
    writeSkill(synced(), 'Account synced');
    writeSkill(path.join(homeDir, '.claude', 'skills', name), 'Operator');
    writeSkill(path.join(projectDir, '.claude', 'skills', name), 'Project');
    writeSkill(path.join(projectDir, '.agents', 'skills', name), 'Shared project');
    const owners = discoverLocalSkillOwners({ projectDir, homeDir });
    const selected = selectSkillOwners(owners)[0];
    expect(selected.origin).toBe('project');
    expect(selected.path).toBe(path.join(projectDir, '.agents', 'skills', name, 'SKILL.md'));
    expect(selectSkillOwners([...owners].reverse())).toEqual(selectSkillOwners(owners));
  });

  it('keeps synced ownership even if the cache contains an AIWG marker', async () => {
    writeSkill(synced(), 'Account synced');
    fs.writeFileSync(path.join(synced(), '.aiwg-managed'), 'aiwg-agent-skill-v1\n');
    expect((await adapter().info(name))?.origin).toBe('synced');
  });

  it('uses the same winner for registry list, search and info ahead of imports', async () => {
    writeSkill(synced(), 'Account synced');
    const detail = (await adapter().info(name))!;
    for (const registry of getAllAdapters()) {
      vi.spyOn(registry, 'isAvailable').mockResolvedValue(['local', 'agentskills'].includes(registry.id));
      const fixture = registry.id === 'local' ? detail : {
        name, description: 'Imported source', source: 'agentskills', origin: 'imported' as const,
      };
      vi.spyOn(registry, 'list').mockResolvedValue([fixture]);
      vi.spyOn(registry, 'search').mockResolvedValue([fixture]);
      vi.spyOn(registry, 'info').mockResolvedValue(fixture);
    }
    expect((await listSkills())[0].origin).toBe('synced');
    expect((await searchSkills(name))[0].origin).toBe('synced');
    expect((await getSkillInfo(name))?.origin).toBe('synced');
    expect((await getSkillInfo(name))?.diagnostics?.map(item => item.message).join('\n'))
      .toContain('imported-owned');
    // A loser-only description must never resurface the shadowed import.
    expect(await searchSkills('Imported source')).toEqual([]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const command of [['list'], ['search', name], ['info', name]]) {
      await skillsMain(command);
      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('synced-owned');
      expect(output).toContain('aiwg-managed-owned');
      log.mockClear();
    }
  });
});

describe('synced collision deployment preservation', () => {
  it('deploys packaged bytes when there is no collision and preserves them on a repeat', async () => {
    const local = adapter();
    await local.install(name, { projectDir, target: 'claude' });
    const target = path.join(projectDir, '.claude', 'skills', name, 'SKILL.md');
    const content = fs.readFileSync(target, 'utf8');
    expect(content).toContain('Packaged source');
    await expect(local.install(name, { projectDir, target: 'claude' })).rejects.toThrow('project-owned');
    expect(fs.readFileSync(target, 'utf8')).toBe(content);
  });

  it.each(['synced', 'project', 'user'] as const)(
    'blocks imported deployment with %s winning and preserves all bytes', async (winner) => {
      await importActive();
      const cache = writeSkill(synced(), 'Account synced');
      let owned: string | undefined;
      let ownedContent: string | undefined;
      if (winner !== 'synced') {
        owned = path.join(winner === 'project' ? projectDir : homeDir, '.claude', 'skills', name);
        ownedContent = writeSkill(owned, 'Operator authored');
        fs.writeFileSync(path.join(owned, '.aiwg-managed'), 'aiwg-agent-skill-v1\n');
        fs.writeFileSync(path.join(owned, 'operator.txt'), 'Retain this resource\n');
      }
      for (const dryRun of [true, false]) {
        const deployed = deployImportedAgentSkill(name, options(dryRun));
        expect(deployed).toMatchObject({ outcome: 'blocked', projectionStatus: 'degraded' });
        expect(deployed.reasons.join('\n')).toContain(`${winner}-owned`);
        expect(deployed.reasons.join('\n')).toContain('imported-owned');
      }
      const inspection = inspectImportedAgentSkillProjection(name, options());
      expect(inspection.projectionStatus).toBe('degraded');
      expect(inspection.matches).toBe(false);
      expect(inspection.reasons.join('\n')).toContain(`${winner}-owned`);
      expect(fs.readFileSync(path.join(synced(), 'SKILL.md'), 'utf8')).toBe(cache);
      if (owned) {
        expect(fs.readFileSync(path.join(owned, 'SKILL.md'), 'utf8')).toBe(ownedContent);
        expect(fs.readFileSync(path.join(owned, 'operator.txt'), 'utf8')).toBe('Retain this resource\n');
      }
      else expect(fs.existsSync(path.join(projectDir, '.claude', 'skills', name))).toBe(false);
    },
  );

  it.each(['synced', 'project', 'user'] as const)(
    'blocks packaged deploy when %s wins over a synced collision', async (winner) => {
      const cache = writeSkill(synced(), 'Account synced');
      const owned = path.join(winner === 'project' ? projectDir : homeDir, '.claude', 'skills', name);
      if (winner !== 'synced') writeSkill(owned, 'Operator authored');
      await expect(adapter().install(name, { projectDir, target: 'claude' }))
        .rejects.toThrow(`${winner}-owned`);
      expect(fs.readFileSync(path.join(synced(), 'SKILL.md'), 'utf8')).toBe(cache);
      if (winner !== 'synced') expect(fs.readFileSync(path.join(owned, 'SKILL.md'), 'utf8')).toContain('Operator authored');
    },
  );

  it('blocks refresh of an existing managed projection when synced arrives', async () => {
    await importActive();
    const initial = deployImportedAgentSkill(name, options());
    expect(initial.outcome).toBe('deployed');
    const content = fs.readFileSync(path.join(initial.path, 'SKILL.md'), 'utf8');
    writeSkill(synced(), 'Account synced');
    expect(deployImportedAgentSkill(name, options()).outcome).toBe('blocked');
    expect(fs.readFileSync(path.join(initial.path, 'SKILL.md'), 'utf8')).toBe(content);
    const doctor = buildAgentSkillsDoctorSection(projectDir, { homeDir });
    expect(doctor.output).toContain('synced-owned');
    expect(doctor.output).toContain('imported-owned');
  });

  it('rejects importing a synced collision and names both origins', async () => {
    writeSkill(synced(), 'Account synced');
    const source = path.join(root, 'source', name);
    writeSkill(source, 'Imported source');
    await expect(importAgentSkill({ kind: 'directory', path: source }, { projectDir }))
      .rejects.toMatchObject({ code: 'AS_IMPORT_COLLISION', message: expect.stringMatching(/synced-owned.*imported-owned/) });
  });

  it.each([false, true])('preserves an operator target racing atomic promotion (update=%s)', async (update) => {
    await importActive();
    const target = path.join(projectDir, '.claude', 'skills', name);
    if (update) {
      deployImportedAgentSkill(name, options());
      fs.appendFileSync(path.join(target, 'SKILL.md'), '\nProjection drift\n');
    }
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).includes('.staging-')) writeSkill(target, 'Racing operator');
      rename(from, to);
    });
    expect(() => deployImportedAgentSkill(name, options())).toThrow();
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toContain('Racing operator');
    const leftovers = fs.readdirSync(path.dirname(target));
    expect(leftovers.some(file => file.includes('.staging-'))).toBe(false);
    expect(leftovers.filter(file => file.includes('.backup-'))).toHaveLength(update ? 1 : 0);
  });
});
