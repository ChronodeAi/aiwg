// Verify Claude extensions survive the portable boundary without leaking policy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_IDS } from '../../../src/providers/provider-definitions.js';
import {
  CLAUDE_SKILL_FIELDS, STANDARD_SKILL_FIELDS, createAgentSkillSidecar,
  projectStrictAgentSkill, restoreAgentSkillFromSidecar,
} from '../../../src/skills/agent-skills.js';
import { agentSkillDocument, claudeSkillExtensions } from '../../../src/skills/provider-extensions.js';
import {
  AGENT_SKILL_DEPLOYMENT_SIDECAR, deployImportedAgentSkill,
  inspectImportedAgentSkillProjection,
} from '../../../src/skills/deployer.js';
import { importAgentSkill } from '../../../src/skills/importer.js';
import { exportAgentSkillDirectory, AGENT_SKILL_EXPORT_SIDECAR } from '../../../src/skills/exporter.js';
import { validateAgentSkillContent } from '../../../src/skills/validator.js';

const source = path.resolve('test/fixtures/agent-skills/claude-native');
const native = fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8');
const provenance = {
  sourceKind: 'directory' as const, locator: 'synthetic-fixture',
  sourceDigest: 'a'.repeat(64), importedAt: '2026-10-27T00:00:00.000Z', aiwgVersion: 'test',
};
let root: string;
let projectDir: string;
let homeDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-claude-native-'));
  projectDir = path.join(root, 'project');
  homeDir = path.join(root, 'home');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(homeDir);
  vi.stubEnv('AIWG_GROKBOT_SKILLS_DIR', path.join(homeDir, 'grokbot-skills'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

async function importNative() {
  return importAgentSkill({ kind: 'directory', path: source }, {
    projectDir, profile: 'compatible', trust: true, activate: true,
    importedAt: provenance.importedAt, aiwgVersion: provenance.aiwgVersion,
  });
}
function document() {
  const parsed = validateAgentSkillContent(native, { profile: 'compatible' });
  expect(parsed.valid).toBe(true);
  return agentSkillDocument(parsed.frontmatter!, parsed.body);
}

describe('Claude-native Agent Skills D1/D2', () => {
  it('accepts every named Claude field in compatible but rejects it in strict', () => {
    const compatible = validateAgentSkillContent(native, { profile: 'compatible' });
    expect(compatible.valid).toBe(true);
    expect(Object.keys(document().providers!.claude!).sort()).toEqual([...CLAUDE_SKILL_FIELDS].sort());
    const strict = validateAgentSkillContent(native, { profile: 'strict' });
    expect(strict.valid).toBe(false);
    expect(strict.diagnostics.filter((d) => d.code === 'AS_FIELD_EXTENSION')
      .map((d) => d.yamlPath).sort()).toEqual(CLAUDE_SKILL_FIELDS.map((f) => `$.${f}`).sort());
  });

  it.each(['strict', 'compatible'] as const)('%s still rejects arbitrary fields', (profile) => {
    const result = validateAgentSkillContent(native.replace('context: fork', 'unexpected: fork'), { profile });
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'AS_FIELD_UNKNOWN', severity: 'error', yamlPath: '$.unexpected',
    }));
  });

  it('restores Claude values through the existing schema-checked sidecar', () => {
    const doc = document();
    const portable = projectStrictAgentSkill(doc);
    expect(Object.keys(portable).every((key) => (STANDARD_SKILL_FIELDS as readonly string[]).includes(key))).toBe(true);
    expect(validateAgentSkillContent(`---\n${stringify(portable)}---\n${doc.body}`, { profile: 'strict' }).valid).toBe(true);
    const sidecar = createAgentSkillSidecar(doc, provenance, 'compatible', { state: 'trusted', activation: 'active' });
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(fs.readFileSync(
      path.resolve('schemas/skills/agent-skill-sidecar.v1.schema.json'), 'utf8',
    )));
    expect(validate(sidecar), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...sidecar, providers: { claude: { unexpected: true } } })).toBe(false);
    expect(validate({ ...sidecar, providers: { unknown: {} } })).toBe(false);
    const restored = restoreAgentSkillFromSidecar(portable, doc.body, [], sidecar);
    expect(restored.providers).toEqual(doc.providers);
    sidecar.providers!.claude!.context = 'changed';
    expect(restored.providers!.claude!.context).toBe('fork');
    expect(doc.providers!.claude!.context).toBe('fork');
  });

  it('continues reading old sidecars with context and effort under aiwg', () => {
    const doc = document();
    delete doc.providers;
    doc.aiwg = { context: 'fork', effort: 3 };
    const sidecar = createAgentSkillSidecar(doc, provenance, 'compatible', { state: 'trusted', activation: 'active' });
    expect(sidecar).not.toHaveProperty('providers');
    expect(claudeSkillExtensions(restoreAgentSkillFromSidecar(doc.standard, doc.body, [], sidecar)))
      .toEqual({ context: 'fork', effort: 3 });
  });

  it('imports and deploys native Claude source byte-for-byte and remains idempotent', async () => {
    const imported = await importNative();
    const options = { projectDir, homeDir, target: 'claude' };
    const deployed = deployImportedAgentSkill('claude-native', options);
    expect(deployed).toMatchObject({ outcome: 'deployed', projectionStatus: 'native', warnings: [] });
    expect(fs.readFileSync(path.join(deployed.path, 'SKILL.md'), 'utf8')).toBe(native);
    expect(fs.readFileSync(path.join(imported.managedLocation, 'SKILL.md'), 'utf8')).toBe(native);
    const sidecar = JSON.parse(fs.readFileSync(path.join(deployed.path, AGENT_SKILL_DEPLOYMENT_SIDECAR), 'utf8'));
    expect(sidecar.portable.providers).toEqual(document().providers);
    expect(deployImportedAgentSkill('claude-native', options).outcome).toBe('unchanged');
    expect(inspectImportedAgentSkillProjection('claude-native', options)).toMatchObject({ matches: true, warnings: [] });
  });

  it('preserves native values while moving mixed AIWG controls to the sidecar', async () => {
    const mixed = path.join(root, 'claude-native');
    fs.mkdirSync(mixed);
    fs.writeFileSync(path.join(mixed, 'SKILL.md'), native.replace(
      'context: fork', 'context: fork\nnamespace: fixture\nplatforms: [all]',
    ));
    await importAgentSkill({ kind: 'directory', path: mixed }, {
      projectDir, profile: 'compatible', trust: true, activate: true,
    });
    const result = deployImportedAgentSkill('claude-native', { projectDir, homeDir, target: 'claude' });
    const projected = validateAgentSkillContent(fs.readFileSync(path.join(result.path, 'SKILL.md'), 'utf8'));
    expect(projected.valid).toBe(true);
    expect(projected.frontmatter).toEqual({ ...document().standard, ...document().providers!.claude });
    expect(projected.body).toBe(document().body);
    const sidecar = JSON.parse(fs.readFileSync(path.join(result.path, AGENT_SKILL_DEPLOYMENT_SIDECAR), 'utf8'));
    expect(sidecar.portable.aiwg).toMatchObject({ namespace: 'fixture', platforms: ['all'] });
    expect(sidecar.portable.providers).toEqual(document().providers);
  });

  it.each(PROVIDER_IDS.filter((id) => id !== 'claude'))('%s drops and warns for every Claude field', async (target) => {
    await importNative();
    const options = { projectDir, homeDir, target };
    const planned = deployImportedAgentSkill('claude-native', { ...options, dryRun: true });
    expect(planned).toMatchObject({ outcome: 'planned', projectionStatus: 'degraded' });
    expect(fs.existsSync(planned.path)).toBe(false);
    const result = deployImportedAgentSkill('claude-native', options);
    expect(result).toMatchObject({ outcome: 'deployed', projectionStatus: 'degraded' });
    expect(result.warnings).toHaveLength(CLAUDE_SKILL_FIELDS.length);
    for (const field of CLAUDE_SKILL_FIELDS) {
      expect(result.warnings).toContainEqual(expect.stringContaining(`field "${field}" is dropped for provider "${target}"`));
    }
    expect(result.warnings).toEqual(planned.warnings);
    const deployed = validateAgentSkillContent(fs.readFileSync(path.join(result.path, 'SKILL.md'), 'utf8'), { profile: 'strict' });
    expect(deployed.valid).toBe(true);
    for (const field of CLAUDE_SKILL_FIELDS) expect(deployed.frontmatter).not.toHaveProperty(field);
    expect(deployed.body).toBe(document().body);
    const sidecar = JSON.parse(fs.readFileSync(path.join(result.path, AGENT_SKILL_DEPLOYMENT_SIDECAR), 'utf8'));
    expect(sidecar.portable.providers).toEqual(document().providers);
    expect(sidecar.warnings).toEqual(result.warnings);
    expect(inspectImportedAgentSkillProjection('claude-native', options)).toMatchObject({ matches: true, warnings: result.warnings });
  });

  it('keeps portable export strict and records Claude values in its export sidecar', () => {
    const result = exportAgentSkillDirectory(source, { outDir: path.join(root, 'export') });
    const portable = fs.readFileSync(path.join(result.outputPath, 'SKILL.md'), 'utf8');
    expect(validateAgentSkillContent(portable, { profile: 'strict' }).valid).toBe(true);
    const sidecar = JSON.parse(fs.readFileSync(path.join(result.outputPath, AGENT_SKILL_EXPORT_SIDECAR), 'utf8'));
    expect(sidecar.providers).toEqual(document().providers);
    expect(portable).not.toContain('context:');
  });
});
