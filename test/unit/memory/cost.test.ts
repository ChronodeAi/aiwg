import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { auditMemory } from '../../../src/memory/audit.js';
import {
  costMemory,
  formatMemoryCost,
  MemoryCostSchema,
  TOKEN_ESTIMATOR_2936,
  TOKEN_ESTIMATOR_2938,
} from '../../../src/memory/cost.js';
import { main, parseMemoryCostOptions } from '../../../src/memory/cli.js';

// Worker process.env is virtualized; libuv's homedir may still see the parent
// environment. Route every resolver through this synthetic home in these tests.
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => process.env.HOME!;
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => process.env.HOME!;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

let temp: string;
let workspace: string;
let home: string;
function write(relative: string, content: string, base = workspace): string {
  const file = path.join(base, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
function snapshot(directory: string): unknown[] {
  return fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    return [name, stat.mode, stat.mtimeMs, stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('base64')];
  });
}
function seedWorkspace(): void {
  write('CLAUDE.md', '@WORKSPACE.md\n@AIWG.md\n');
  write('WORKSPACE.md', 'Shared workspace instructions');
  write('AIWG.md', 'Project instructions');
  write('.claude/rules/policy.md', 'Policy rule body');
  write('.claude/rules/duplicate-a.md', 'Same resident bytes');
  write('.claude/rules/duplicate-b.md', 'Same resident bytes');
  write('.claude/agents/reviewer.md', 'Reviewer role');
  write('.claude/skills/review/SKILL.md', 'Review skill');
  write('.claude/skills/review/.aiwg-managed', '');
  write('.claude/commands/review.md', 'Review prompt');
  write('.mcp.json', JSON.stringify({
    tools: [{ name: 'synthetic_lookup', description: 'x'.repeat(40) }],
    mcpServers: { synthetic: { command: 'never-executed' } },
  }));
  write('.aiwg/kb/page.md', 'Stored knowledge');
  write('.aiwg/projects/manifest.json', '{"version":1,"projects":[]}', home);
}
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-memory-cost-'));
  workspace = path.join(temp, 'workspace');
  home = path.join(temp, 'home');
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('AIWG_PROJECT_MEMORY_HOME', path.join(home, '.aiwg/projects'));
  for (const env of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) vi.stubEnv(env, '');
  // An empty override is rejected by the inline-budget guard; delete it instead.
  vi.stubEnv('AIWG_RULES_INLINE_BUDGET_TOKENS', undefined);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
  vi.stubEnv('HERMES_HOME', path.join(home, '.hermes'));
  vi.spyOn(process, 'cwd').mockReturnValue(workspace);
  seedWorkspace();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('resident cost attribution', () => {
  it('attributes every item with the shared estimator name and a confidence', async () => {
    const cost = costMemory(await auditMemory({ provider: 'claude' }));
    expect(cost.items.length).toBeGreaterThan(0);
    for (const item of cost.items) {
      expect(item.estimator).toBe(TOKEN_ESTIMATOR_2936);
      expect(['measured', 'inferred', 'unknown']).toContain(item.confidence);
      if (item.bytes === null) {
        expect(item.tokens).toBeNull();
        expect(item.confidence).toBe('unknown');
      } else {
        expect(item.tokens).toBe(Math.ceil(item.bytes / 4));
      }
    }
    expect(cost.summary.byClass.rule.items).toBeGreaterThan(0);
    expect(cost.summary.byClass.role.items).toBeGreaterThan(0);
    expect(cost.summary.byClass.skill.items).toBeGreaterThan(0);
    expect(cost.summary.byClass['tool-schema'].items).toBeGreaterThan(0);
    expect(cost.summary.byClass.instruction.items).toBeGreaterThan(0);
  });

  it('keeps unmeasurable layers unknown instead of guessing numbers', async () => {
    const cost = costMemory(await auditMemory({ provider: 'claude' }));
    const hidden = cost.items.find(i => i.sourcePath === 'provider:claude:system')!;
    expect(hidden.bytes).toBeNull();
    expect(hidden.tokens).toBeNull();
    expect(hidden.confidence).toBe('unknown');
    for (const layer of [cost.summary.layers.perTask, cost.summary.layers.overhead,
      cost.summary.layers.usageBilling, cost.summary.layers.cacheDiscounts]) {
      expect(layer.tokens).toBeNull();
      expect(layer.confidence).toBe('unknown');
      expect(layer.basis.length).toBeGreaterThan(0);
    }
    expect(cost.startupMeasurement.status).toBe('unknown');
  });

  it('counts imported bodies at full startup cost, never zero', async () => {
    const cost = costMemory(await auditMemory({ provider: 'claude' }));
    const shared = cost.items.find(i => i.sourcePath === 'WORKSPACE.md')!;
    expect(shared.imported).toBe(true);
    expect(shared.layer).toBe('startup');
    expect(shared.tokens).toBe(Math.ceil(Buffer.byteLength('Shared workspace instructions') / 4));
    expect(shared.tokens).toBeGreaterThan(0);
    expect(cost.summary.imported.items).toBeGreaterThan(0);
    expect(cost.summary.imported.tokens).toBeGreaterThan(0);
    const duplicates = cost.items.filter(i => i.sourcePath.endsWith('duplicate-a.md') || i.sourcePath.endsWith('duplicate-b.md'));
    expect(duplicates).toHaveLength(2);
    expect(duplicates[0].duplicateGroup).toBe(duplicates[1].duplicateGroup);
    expect(cost.summary.duplicated.items).toBe(2);
  });

  it('previews demotion before/after cost with retrieval anchors', async () => {
    const report = await auditMemory({ provider: 'claude' });
    const cost = costMemory(report, { demote: ['.claude/rules/policy.md', 'WORKSPACE.md'] });
    const rule = cost.demotionPreview!.targets.find(t => t.sourcePath === '.claude/rules/policy.md')!;
    expect(rule.before.tokens).toBeGreaterThan(0);
    expect(rule.after.residentTokens).toBe(0);
    expect(rule.reachable).toBe(true);
    expect(rule.anchors.length).toBeGreaterThan(0);
    expect(rule.anchors.map(a => a.kind)).toContain('indexed-record');
    expect(rule.anchors.every(a => a.tokens >= 1)).toBe(true);
    const imported = cost.demotionPreview!.targets.find(t => t.sourcePath === 'WORKSPACE.md')!;
    expect(imported.anchors.map(a => a.kind)).toContain('include-stub');
    expect(imported.warnings.join(' ')).toMatch(/splitting files is not demotion/);
    expect(cost.demotionPreview!.totals.afterAnchorTokens).toBeGreaterThan(0);
    expect(formatMemoryCost(cost)).toMatch(/Demotion preview/);
  });

  it('marks demotion unreachable when no retrieval anchor exists', async () => {
    const report = await auditMemory({ provider: 'claude' });
    const cost = costMemory(report, { demote: ['provider:claude:system'] });
    const target = cost.demotionPreview!.targets[0];
    expect(target.reachable).toBe(false);
    expect(target.anchors).toHaveLength(0);
    expect(target.warnings.join(' ')).toMatch(/unreachable/);
  });

  it('rejects demotion targets outside the costed inventory', async () => {
    const report = await auditMemory({ provider: 'claude' });
    expect(() => costMemory(report, { demote: ['no-such-item.md'] })).toThrow(/not a costed audit item/);
  });
});

describe('#2938 inline budget integration', () => {
  it('reuses the guard over static resident rule candidates', async () => {
    const cost = costMemory(await auditMemory({ provider: 'claude' }));
    expect(cost.inlineBudget.estimator).toBe(TOKEN_ESTIMATOR_2938);
    expect(cost.inlineBudget.limit).toBe(64000);
    expect(cost.inlineBudget.configSource).toBe('default');
    const claude = cost.inlineBudget.providers.find(p => p.provider === 'claude')!;
    expect(claude.contributors.map(c => c.path)).toContain('.claude/rules/policy.md');
    expect(claude.exceeded).toBe(false);
    expect(claude.scopeNote.length).toBeGreaterThan(0);
  });

  it('honors the budget override and reports over-budget residents', async () => {
    vi.stubEnv('AIWG_RULES_INLINE_BUDGET_TOKENS', '1');
    const cost = costMemory(await auditMemory({ provider: 'claude' }));
    expect(cost.inlineBudget.limit).toBe(1);
    expect(cost.inlineBudget.configSource).toBe('AIWG_RULES_INLINE_BUDGET_TOKENS');
    expect(cost.inlineBudget.providers.find(p => p.provider === 'claude')!.exceeded).toBe(true);
  });

  it('accepts an inline budget config without duplicating guard logic', async () => {
    const cost = costMemory(await auditMemory({ provider: 'claude' }), {
      inlineBudgetConfig: { rules: { inline_budget_tokens: 0 } },
    });
    expect(cost.inlineBudget.limit).toBe(0);
    expect(cost.inlineBudget.providers.find(p => p.provider === 'claude')!.exceeded).toBe(false);
  });
});

describe('#2936 startup measurement integration', () => {
  const measurement = {
    version: 1,
    token_estimate: 'sum(ceil(UTF-8 bytes per file / 4)); not a tokenizer',
    providers: { claude: { startup: { bytes: 100, estimated_tokens: 25 } } },
  };
  it('cross-references a supplied measurement report side by side', async () => {
    const cost = costMemory(await auditMemory({ provider: 'claude' }), { startupMeasurement: measurement });
    expect(cost.startupMeasurement.status).toBe('matched');
    expect(cost.startupMeasurement.estimator).toBe(measurement.token_estimate);
    const claude = cost.startupMeasurement.providers.find(p => p.provider === 'claude')!;
    expect(claude.measuredStartupBytes).toBe(100);
    expect(claude.measuredStartupTokens).toBe(25);
    expect(claude.staticResidentBytes).toBeGreaterThan(0);
    expect(claude.note.length).toBeGreaterThan(0);
  });

  it('rejects a malformed measurement report instead of guessing', async () => {
    const report = await auditMemory({ provider: 'claude' });
    expect(() => costMemory(report, { startupMeasurement: { providers: { claude: {} } } })).toThrow();
  });
});

describe('memory utility outcomes', () => {
  it('records retrieval, exposure, use and rejection independently with no new telemetry', async () => {
    const report = await auditMemory({ provider: 'claude' });
    const target = report.items.find(i => i.sourcePath === 'WORKSPACE.md')!;
    const other = report.items.find(i => i.sourcePath === 'AIWG.md')!;
    const cost = costMemory(report, { usage: {
      [target.id]: { used: true, evidence: 'synthetic-operator-note' },
      [other.id]: { retrieved: true, evidence: 'synthetic-operator-note' },
    } });
    const used = cost.items.find(i => i.id === target.id)!;
    expect(used.utility.exposures).toBeGreaterThan(0);
    expect(used.utility.used).toBe(true);
    expect(used.utility.retrieved).toBeNull();
    expect(used.utility.rejected).toBeNull();
    expect(used.utility.outcome).toBe('used');
    const retrieved = cost.items.find(i => i.id === other.id)!;
    expect(retrieved.utility.outcome).toBe('retrieved-unused');
    const untouched = cost.items.find(i => i.sourcePath === '.claude/rules/policy.md')!;
    expect(untouched.utility.outcome).toBe('unknown');
    expect(cost.telemetry.store).toMatch(/in-memory only/);
    expect(cost.telemetry.writesNewTelemetry).toBe(false);
    expect(cost.telemetry.retention).toMatch(/aiwg memory append-log/);
  });
});

describe('memory cost schema and read-only CLI', () => {
  function validator(): (value: unknown) => boolean {
    const require = createRequire(import.meta.url);
    const { default: Ajv2020 } = require('ajv/dist/2020.js');
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    require('ajv-formats')(ajv);
    ajv.addSchema(JSON.parse(fs.readFileSync(new URL('../../../schemas/memory/memory-cost.v1.schema.json', import.meta.url), 'utf8')));
    const validate = ajv.getSchema('https://aiwg.io/schemas/memory/memory-cost.v1.schema.json')!;
    return (value: unknown) => validate(JSON.parse(JSON.stringify(value)));
  }

  it('validates emitted JSON against the published schema', async () => {
    const report = await auditMemory({ provider: 'claude' });
    const validate = validator();
    const cost = costMemory(report, { demote: ['WORKSPACE.md'] });
    expect(validate(cost), JSON.stringify(cost).slice(0, 500)).toBe(true);
    expect(MemoryCostSchema.safeParse(cost).success).toBe(true);
    expect(validate({ ...cost, schemaVersion: 'aiwg.memory-cost.v99' })).toBe(false);
    const unknown = costMemory(report);
    expect(validate(unknown)).toBe(true);
  });

  it('serves audit --cost and the cost subcommand without mutating the tree', async () => {
    const before = snapshot(temp);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const report = await auditMemory({ provider: 'claude' });
      const target = report.items.find(i => i.sourcePath === '.claude/rules/policy.md')!;
      await main(['audit', '--provider', 'claude', '--cost', '--json']);
      expect(JSON.parse(log.mock.calls[0][0]).schemaVersion).toBe('aiwg.memory-cost.v1');
      await main(['cost', '--provider', 'claude']);
      expect(String(log.mock.calls[1][0])).toMatch(/Memory cost/);
      await main(['cost', '--provider', 'claude', '--json', '--demote', target.id]);
      const preview = JSON.parse(log.mock.calls[2][0]);
      expect(preview.demotionPreview.targets).toHaveLength(1);
      await main(['cost', '--help']);
      expect(String(log.mock.calls[3][0])).toMatch(/--demote/);
    } finally {
      log.mockRestore();
    }
    expect(snapshot(temp)).toEqual(before);
  });

  it('rejects invalid cost flags and unreadable inputs', async () => {
    expect(() => parseMemoryCostOptions(['--write'])).toThrow();
    expect(() => parseMemoryCostOptions(['--scope', 'workspace'])).toThrow();
    expect(() => parseMemoryCostOptions(['--scope', 'provider'])).toThrow();
    expect(() => parseMemoryCostOptions(['--json=true'])).toThrow();
    expect(() => parseMemoryCostOptions(['--provider', 'claude', '--provider', 'codex'])).toThrow();
    expect(parseMemoryCostOptions(['--scope=provider', '--provider=codex', '--demote=a', '--demote=b'])).toEqual({
      scope: 'provider', provider: 'codex', demote: ['a', 'b'],
    });
    await expect(main(['cost', '--provider', 'claude', '--startup-measurement', path.join(temp, 'missing.json')])).rejects.toThrow(/could not be read/);
    const bad = path.join(temp, 'bad.json');
    fs.writeFileSync(bad, 'not json');
    await expect(main(['cost', '--provider', 'claude', '--usage', bad])).rejects.toThrow(/not valid JSON/);
  });
});
