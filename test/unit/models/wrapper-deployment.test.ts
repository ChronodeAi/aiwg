import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL_WRAPPER_DEFINITIONS } from '../../../src/models/wrapper-definitions.js';
import { verifyModelWrapperDeployment } from '../../../src/models/wrapper-deployment.js';

const roots: string[] = [];
const models = {
  reasoning: 'reasoning-current',
  coding: 'coding-current',
  efficiency: 'efficiency-current',
};

afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'aiwg-wrapper-deploy-'));
  roots.push(value);
  return value;
}

function codex(wrapper: string, model: string, effort: string): string {
  return [
    `name = "${wrapper}"`,
    'developer_instructions = "WorkerClaims: criterion evidence verdict. Stop rules"',
    'sandbox_mode = "read-only"',
    `model = "${model}"`,
    `model_reasoning_effort = "${effort}"`,
    '',
  ].join('\n');
}

describe('model wrapper deployment verification', () => {
  it('validates all five current Codex wrapper artifacts', async () => {
    const target = await root();
    await mkdir(join(target, 'nested'), { recursive: true });
    await Promise.all([
      writeFile(join(target, 'aiwg-model-reasoning-worker.toml'), codex('aiwg-model-reasoning-worker', models.reasoning, 'high')),
      writeFile(join(target, 'aiwg-model-coding-worker.toml'), codex('aiwg-model-coding-worker', models.coding, 'medium')),
      writeFile(join(target, 'nested', 'aiwg-model-efficiency-worker.toml'), codex('aiwg-model-efficiency-worker', models.efficiency, 'low')),
    ]);
    await Promise.all(MODEL_WRAPPER_DEFINITIONS.filter(item => item.readOnly).map(item =>
      writeFile(join(target, `${item.name}.toml`), codex(item.name, models[item.role], item.effort))));
    const result = await verifyModelWrapperDeployment(target, { provider: 'codex', models });
    expect(result.valid).toBe(true);
    expect(result.found).toHaveLength(5);
    expect(result.missing).toEqual([]);
    expect(result.mismatches).toEqual([]);
  });

  it('rejects empty and stale Codex wrappers by field', async () => {
    const target = await root();
    await Promise.all([
      writeFile(join(target, 'aiwg-model-reasoning-worker.toml'), codex('aiwg-model-reasoning-worker', 'reasoning-stale', 'high')),
      writeFile(join(target, 'aiwg-model-coding-worker.toml'), ''),
      writeFile(join(target, 'aiwg-model-efficiency-worker.toml'), codex('aiwg-model-efficiency-worker', models.efficiency, 'low')),
    ]);
    await Promise.all(MODEL_WRAPPER_DEFINITIONS.filter(item => item.readOnly).map(item =>
      writeFile(join(target, `${item.name}.toml`), codex(item.name, models[item.role], item.effort))));
    const result = await verifyModelWrapperDeployment(target, { provider: 'codex', models });
    expect(result.valid).toBe(false);
    expect(result.mismatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ wrapper: 'aiwg-model-reasoning-worker', field: 'model', expected: models.reasoning, actual: 'reasoning-stale' }),
      expect.objectContaining({ wrapper: 'aiwg-model-coding-worker', field: 'content' }),
    ]));
  });

  it('validates Claude semantic aliases and canonical role metadata', async () => {
    const target = await root();
    await Promise.all(MODEL_WRAPPER_DEFINITIONS.map(({name: wrapper, role, tier}) => {
      const model = { reasoning: 'opus', coding: 'sonnet', efficiency: 'haiku' }[role];
      return writeFile(join(target, `${wrapper}.md`), [
        '---', `name: ${wrapper}`, `model: ${model}`, `model-role: ${role}`, `model-tier: ${tier}`, 'tools: [Read, Grep, Glob, Bash]', '---', '# Wrapper', 'WorkerClaims: criterion evidence verdict. Stop rules', '',
      ].join('\n'));
    }));
    const result = await verifyModelWrapperDeployment(target, { provider: 'claude', models });
    expect(result.valid).toBe(true);
  });

  it('finds Copilot wrappers deployed with the .agent.md suffix', async () => {
    const target = await root();
    await Promise.all(MODEL_WRAPPER_DEFINITIONS.map(({name: wrapper, role}) => {
      return writeFile(join(target, `${wrapper}.agent.md`), [
        '---', `name: ${wrapper}`, `description: AIWG ${role} worker`, 'tools: [search/codebase, terminal]', '---', '# Wrapper', 'WorkerClaims: criterion evidence verdict. Stop rules', '',
      ].join('\n'));
    }));
    const result = await verifyModelWrapperDeployment(target, { provider: 'copilot', models });
    expect(result.missing).toEqual([]);
    expect(result.found).toHaveLength(5);
    expect(result.mismatches).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it.each(['Write', 'Edit', 'Task', 'Agent', 'apply_patch', 'write_to_file', 'replace_file_content'])
  ('rejects a mutating or delegating read-only tool: %s', async tool => {
    const target = await root();
    await writeFile(join(target, 'aiwg-model-explorer.md'), [
      '---', 'name: aiwg-model-explorer', 'model: haiku', 'model-role: efficiency',
      'model-tier: economy', `tools: [Read, ${tool}]`, '---',
      'WorkerClaims: criterion evidence verdict. Stop rules', '',
    ].join('\n'));
    const result = await verifyModelWrapperDeployment(target, { provider: 'claude', models });
    expect(result.mismatches).toContainEqual(expect.objectContaining({
      wrapper: 'aiwg-model-explorer', field: 'tools', reason: 'read-only wrapper exposes mutation or delegation tools',
    }));
  });

  it.each([
    ['sandbox_mode = "workspace-write"', 'sandbox_mode'],
    ['model = "gpt-6-astra"', 'model'],
    ['developer_instructions = "No return contract"', 'return-contract'],
  ])('rejects an unsafe or incomplete Codex explorer: %s', async (replacement, field) => {
    const target = await root();
    const key = replacement.split(' = ')[0];
    const content = codex('aiwg-model-explorer', models.efficiency, 'low')
      .replace(new RegExp(`^${key} = .*$`, 'm'), replacement);
    await writeFile(join(target, 'aiwg-model-explorer.toml'), content);
    const result = await verifyModelWrapperDeployment(target, { provider: 'codex', models });
    expect(result.mismatches).toContainEqual(expect.objectContaining({ wrapper: 'aiwg-model-explorer', field }));
  });

  it('reports an agent-less provider as unsupported without false pinning', async () => {
    const result = await verifyModelWrapperDeployment(null);
    expect(result.supported).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.missing).toHaveLength(5);
  });
});
