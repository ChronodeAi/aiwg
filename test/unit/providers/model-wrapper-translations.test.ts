// Provider goldens exercise real translators and temp-only deployment of all five wrappers.
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { load } from 'js-yaml';
import { MODEL_WRAPPER_DEFINITIONS } from '../../../src/models/wrapper-definitions.js';
import { loadProviderModelCatalog } from '../../../src/models/catalog-policy.js';
import { verifyModelWrapperDeployment } from '../../../src/models/wrapper-deployment.js';
import { isFlagshipModel } from '../../../src/models/tiers.js';

const providers = ['claude', 'codex', 'copilot', 'cursor', 'factory', 'opencode', 'omp',
  'antigravity', 'grok-build', 'openclaw', 'warp', 'windsurf'];
const roots: string[] = [];
const catalog = loadProviderModelCatalog();
const source = (name: string) => join(process.cwd(), 'agentic/code/addons/aiwg-utils/agents', `${name}.md`);
const metadata = (text: string) => load(text.match(/^---\n([\s\S]*?)\n---/)![1]) as Record<string, any>;
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function translator(provider: string) {
  const adapter = await import(`../../../tools/agents/providers/${provider}.mjs`);
  return { adapter, translate: provider === 'grok-build' ? adapter.compileGrokAgent : adapter.transformAgent };
}

describe('model wrapper provider translations', () => {
  it('OpenHuman harness wrappers use semantic hints and native read-only isolation', async () => {
    const { deployOpenHumanHarnessAgents } = await import('../../../src/cli/handlers/use.js');
    const root = await mkdtemp(join(tmpdir(), 'aiwg-openhuman-wrapper-')); roots.push(root);
    vi.stubEnv('OPENHUMAN_HOME', join(root, 'home'));
    const result = await deployOpenHumanHarnessAgents({ frameworkRoot: process.cwd(), target: root,
      selectors: MODEL_WRAPPER_DEFINITIONS.map(wrapper => wrapper.name), scope: 'user' });
    expect(result.emitted).toBe(5);
    for (const wrapper of MODEL_WRAPPER_DEFINITIONS) {
      const text = await readFile(join(root, 'home/agents', `aiwg_${wrapper.name.replaceAll('-', '_')}.toml`), 'utf8');
      expect(text).toContain(`hint = "${wrapper.role}"`);
      expect(text).toContain('WorkerClaims');
      expect(text).toContain('Stop rules');
      if (wrapper.readOnly) {
        expect(text).toContain('sandbox_mode = "read_only"');
        expect(text).toContain('max_turn_output_tokens = 1000');
        expect(text).toContain('never silently inherit flagship');
      }
    }
  });

  it.each(providers)('%s golden: all wrappers retain contract, role tier and safe capabilities', async provider => {
    const { adapter, translate } = await translator(provider);
    const outputs: Record<string, unknown> = {};
    for (const wrapper of MODEL_WRAPPER_DEFINITIONS) {
      const text = await readFile(source(wrapper.name), 'utf8');
      const output = translate(source(wrapper.name), text, { modelCatalog: catalog, quiet: true });
      expect(output).toContain('WorkerClaims');
      expect(output).toContain('Stop rules');
      const fields = provider === 'codex' ? Object.fromEntries(output.split('\n').flatMap(line => {
        const match = line.match(/^(name|model|model_reasoning_effort|sandbox_mode) = (.*)$/);
        return match ? [[match[1], JSON.parse(match[2])]] : [];
      }))
        : provider === 'windsurf' ? { capabilities: output.match(/<capabilities>([\s\S]*?)<\/capabilities>/)?.[1] }
        : metadata(output);
      if (wrapper.readOnly) {
        if (provider === 'codex') expect(fields.sandbox_mode).toBe('read-only');
        else if (provider === 'opencode') expect(fields.permission).toEqual({ '*': 'deny', read: 'allow',
          grep: 'allow', glob: 'allow', bash: 'ask', edit: 'deny', task: 'deny' });
        else if (provider === 'cursor') expect(fields.readonly).toBe(true);
        if (fields.tools) expect(String(fields.tools)).not.toMatch(/(?:^|,)(?:Write|Edit|Create|Task|Agent|write|edit|task)(?:,|$)/);
        if (provider === 'antigravity') expect(fields.tools).toEqual(['view_file', 'grep_search', 'run_command']);
        if (provider === 'copilot') expect(fields.tools).toEqual(['search/codebase', 'terminal']);
        if (provider === 'omp') expect(fields.tools).toEqual(['read', 'grep', 'glob', 'bash']);
        if (provider === 'factory') expect(fields.tools).toEqual(['Execute', 'Glob', 'Grep', 'Read']);
        if (provider === 'windsurf') expect(fields.capabilities).toBe('\n- Read\n- Grep\n- Glob\n- Bash\n');
      }
      if (fields.model) {
        expect(isFlagshipModel(String(fields.model))).toBe(false);
        expect(fields.model).not.toBe('auto');
      } else expect(output).toContain('stop unless the conductor confirms the required non-flagship session');
      outputs[wrapper.name] = { ...fields, contract: 'WorkerClaims: criterion + evidence + verdict; stop rules' };
    }
    await expect(JSON.stringify(outputs, null, 2) + '\n').toMatchFileSnapshot(`../../fixtures/model-wrappers/${provider}.golden.json`);
    // Warp uses aggregate context only. All other adapters deploy discrete mirrors or native agents.
    if (typeof adapter.deployAgents !== 'function' || provider === 'warp') return;
    const root = await mkdtemp(join(tmpdir(), 'aiwg-wrapper-matrix-')); roots.push(root);
    adapter.deployAgents(MODEL_WRAPPER_DEFINITIONS.map(item => source(item.name)), root,
      { provider, modelCatalog: catalog, quiet: true, dryRun: false, force: true });
    const destination = join(root, adapter.paths.agents);
    const files = await readdir(destination);
    expect(files.filter(file => /\.(?:md|toml)$/.test(file))).toHaveLength(5);
    const result = await verifyModelWrapperDeployment(destination, { provider,
      models: Object.fromEntries(Object.entries(catalog.providers[provider].roles).map(([role, model]) => [role, model.id])) });
    expect(result.missing).toEqual([]);
    expect(result.mismatches).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it.each(providers)('%s refuses a flagship role override without election', async provider => {
    const { translate } = await translator(provider);
    for (const wrapper of MODEL_WRAPPER_DEFINITIONS) {
      expect(() => translate(source(wrapper.name), requireSource(wrapper.name), {
        modelCatalog: catalog, [`${wrapper.role}Model`]: 'gpt-6-astra', quiet: true,
      })).toThrow(/user-elected only/);
    }
  });

  it('refuses a catalog flagship disguised behind an economy tier', async () => {
    const { translate } = await translator('codex');
    const poisoned = structuredClone(catalog);
    poisoned.providers.codex.tiers!.economy = { id: 'synthetic-elected', status: 'active', selection: 'user-elected' };
    expect(() => translate(source('aiwg-model-explorer'), requireSource('aiwg-model-explorer'), {
      modelCatalog: poisoned,
    })).toThrow(/user-elected only/);
  });

  it('uses the standard catalog pin when Cursor economy would select auto', async () => {
    const { translate } = await translator('cursor');
    const output = translate(source('aiwg-model-explorer'), requireSource('aiwg-model-explorer'), { modelCatalog: catalog });
    const fields = metadata(output);
    expect(fields.model).toBe(catalog.providers.cursor.tiers?.standard.id ?? catalog.providers.cursor.roles.coding.id);
    expect(fields['model-tier']).toBe('standard');
  });
});

import { readFileSync } from 'node:fs';
function requireSource(name: string) { return readFileSync(source(name), 'utf8'); }
