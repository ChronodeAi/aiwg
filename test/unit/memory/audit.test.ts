import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { auditMemory, formatMemoryAudit, MemoryAuditSchema } from '../../../src/memory/audit.js';
import { main, parseMemoryAuditOptions } from '../../../src/memory/cli.js';
import { memoryRecordId, type MemoryRecord } from '../../../src/memory/maintenance-record.js';
import { sha256 } from '../../../src/memory/context-pack.js';
import { listProviderMemoryAdapters } from '../../../src/memory/provider-memory-adapter.js';
import chain from '../../fixtures/memory-maintenance/import-chain.json';
import cycle from '../../fixtures/memory-maintenance/transitive-include-cycle.json';
import collision from '../../fixtures/memory-maintenance/alias-collision.json';
import external from '../../fixtures/memory-maintenance/external-root.json';
import pin from '../../fixtures/memory-maintenance/rare-obligation-pin.json';
import truncation from '../../fixtures/memory-maintenance/truncation.json';

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
function graphFiles(graph: Record<string, string[]>): void {
  for (const [file, targets] of Object.entries(graph)) {
    write(file, targets.map(target => `@${path.relative(path.dirname(file), target)}`).join('\n') || 'Synthetic obligation.');
  }
}
function ownerRecord(sourcePath = pin.sourcePath, content = pin.content): MemoryRecord {
  const digest = sha256(content);
  return {
    schemaVersion: 'aiwg.memory-record.v1', id: memoryRecordId(sourcePath, digest), sourcePath, digest,
    version: 1, aliases: [], supersedes: [], mergedFrom: [], splitFrom: [],
    scope: 'project', placement: 'indexed', lifecycle: 'active',
    authority: { owner: 'semantic-memory', source: 'import', protection: 'pinned' },
    observation: { status: 'on-disk', evidence: { source: 'synthetic-fixture', at: '2026-10-24T12:00:00.000Z', session: null, provider: null, version: null } },
  };
}
function snapshot(directory: string): unknown[] {
  return fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    return [name, stat.mode, stat.mtimeMs, stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('base64')];
  });
}
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-memory-audit-'));
  workspace = path.join(temp, 'workspace');
  home = path.join(temp, 'home');
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('AIWG_PROJECT_MEMORY_HOME', path.join(home, '.aiwg/projects'));
  for (const env of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR', 'AIWG_GROKBOT_SKILLS_DIR', 'GROK_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'OMP_PROFILE', 'PI_PROFILE']) vi.stubEnv(env, '');
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
  vi.stubEnv('HERMES_HOME', path.join(home, '.hermes'));
  vi.spyOn(process, 'cwd').mockReturnValue(workspace);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // Restore permission fixtures before cleanup on non-root runners.
  function unlock(dir: string): void {
    fs.chmodSync(dir, 0o700);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) unlock(path.join(dir, entry.name));
  }
  unlock(temp);
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('read-only memory inventory', () => {
  it('inventories workspace owners, provider/subtree instructions, roles, rules, prompts, skills and tools', async () => {
    write('WORKSPACE.md', 'Operator context');
    write('.aiwg/memory/line-memory.txt', 'A bounded fact');
    write('.aiwg/context/compound-memory/context.json', '{"schemaVersion":"aiwg.canonical-context.v1","entries":{}}');
    write('.aiwg/kb/page.md', 'Knowledge');
    write('CLAUDE.md', 'Root instructions');
    write('app/CLAUDE.md', 'Narrow instructions');
    write('.claude/agents/reviewer.md', 'Reviewer role');
    write('.claude/rules/policy.md', 'Policy rule');
    write('.claude/commands/review.md', 'Review prompt');
    write('.claude/skills/review/SKILL.md', 'Review skill');
    write('.claude/skills/review/.aiwg-managed', '');
    write('.mcp.json', JSON.stringify({ tools: [{ name: 'synthetic_lookup', description: 'Synthetic tool description' }], mcpServers: { synthetic: { command: 'never-executed', env: { TOKEN: 'do-not-print' } } } }));
    write('.aiwg/projects/manifest.json', '{"version":1,"projects":[]}', home);
    const report = await auditMemory({ provider: 'claude' });
    expect(report.scope).toBe('workspace');
    expect(report.items.map(i => i.category)).toEqual(expect.arrayContaining(['instruction', 'role', 'rule', 'prompt', 'skill', 'tool-description', 'compound-memory', 'registry', 'memory-store']));
    expect(report.items.find(i => i.sourcePath === 'app/CLAUDE.md')?.observation.status).toBe('on-disk');
    expect(report.items.find(i => i.sourcePath.endsWith('line-memory.txt'))?.record?.authority.owner).toBe('line-memory');
    expect(report.items.find(i => i.sourcePath.includes('#tools/synthetic_lookup'))).toBeDefined();
    expect(report.items.some(i => i.sourcePath.includes('#mcp/synthetic') && i.observation.status === 'opaque')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('do-not-print');
    expect(JSON.stringify(report)).not.toContain('Synthetic tool description');
    expect(report.items.every(i => i.observation.status !== 'observed')).toBe(true);
    expect(report.findings.some(f => f.code === 'potential-conflict')).toBe(true);
    expect(report.findings.some(f => f.code === 'unmanaged-artifact')).toBe(true);
    expect(report.items.find(i => i.sourcePath === '.claude/skills/review/SKILL.md')?.managed).toBe(true);
  });

  it('deduplicates the import-chain fixture while retaining every native include path', async () => {
    graphFiles(chain.graph);
    const report = await auditMemory({ provider: 'claude' });
    const shared = report.items.filter(i => i.sourcePath === 'docs/obligations.md');
    expect(shared).toHaveLength(1);
    expect(shared[0].exposures).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'include', chain: ['CLAUDE.md', 'WORKSPACE.md', 'docs/obligations.md'] }),
      expect.objectContaining({ kind: 'include', chain: ['CLAUDE.md', 'AIWG.md', 'docs/obligations.md'] }),
    ]));
    expect(shared[0].record?.placement).toBe('resident');
  });

  it('keeps symlink exposures while using one source identity', async () => {
    write('CLAUDE.md', '@docs/a.md\n@docs/alias.md');
    write('docs/a.md', 'Same physical obligation');
    fs.symlinkSync('a.md', path.join(workspace, 'docs/alias.md'));
    const report = await auditMemory({ provider: 'claude' });
    const item = report.items.find(i => i.sourcePath === 'docs/a.md')!;
    expect(item.exposures.map(e => e.path)).toEqual(expect.arrayContaining(['docs/a.md', 'docs/alias.md']));
    expect(report.items.filter(i => i.digest === sha256('Same physical obligation'))).toHaveLength(1);
  });

  it('reports fixture cycles, stale references and differing resident copies', async () => {
    graphFiles(cycle.graph);
    write('AIWG.md', '@missing.md');
    write('AGENTS.md', collision.content);
    write('AGENTS.override.md', collision.content);
    const report = await auditMemory();
    expect(report.findings.map(f => f.code)).toEqual(expect.arrayContaining(['include-cycle', 'stale-reference', 'shadow', 'duplicate-resident-copy']));
    expect(report.items.find(i => i.sourcePath === 'missing.md')?.observation.status).toBe('absent');
    expect(report.findings.find(f => f.code === 'include-cycle')?.paths).toEqual(expect.arrayContaining(cycle.expectedCycles[0]));
  });

  it('keeps pinned rare obligations and reports fixture alias collisions without choosing a winner', async () => {
    const record = ownerRecord();
    write('.aiwg/memory/pin.json', JSON.stringify(record));
    for (const [index, source] of collision.sourcePaths.entries()) {
      const value = { ...ownerRecord(source, collision.content), aliases: [collision.alias] };
      write(`.aiwg/memory/alias-${index}.json`, JSON.stringify(value));
    }
    const report = await auditMemory({ provider: 'generic' });
    expect(report.items.find(i => i.id === record.id)?.record?.authority.protection).toBe(pin.protection);
    expect(report.items.find(i => i.id === record.id)?.record?.lifecycle).toBe('active');
    expect(report.findings.some(f => f.code === 'alias-collision')).toBe(true);
  });

  it('resolves external artifact roots, including compound context, without falling back locally', async () => {
    const externalRoot = path.join(temp, 'external-artifacts');
    write('.aiwg-location', externalRoot);
    write('memory/external.json', JSON.stringify({ ...ownerRecord(external.sourcePath, external.content), scope: external.scope, sourceWorkspaceId: external.sourceWorkspaceId }), externalRoot);
    write('context/compound-memory/context.json', '{"entries":{}}', externalRoot);
    const report = await auditMemory({ provider: 'generic' });
    expect(report.items.find(i => i.sourcePath === external.sourcePath)?.record?.sourceWorkspaceId).toBe(external.sourceWorkspaceId);
    expect(report.coverage.roots).toContain(path.join(externalRoot, 'context'));
    expect(report.coverage.roots).not.toContain(path.join(workspace, '.aiwg/memory'));
    expect(fs.existsSync(path.join(workspace, '.aiwg'))).toBe(false);
  });

  it('uses storage.config root overrides and reports remote backends as opaque without network calls', async () => {
    const memoryRoot = path.join(temp, 'memory-store');
    write('.aiwg/storage.config', JSON.stringify({ version: '1', roots: { memory: memoryRoot }, backends: { kb: { type: 'notion', parent: { pageId: 'synthetic' } } } }));
    write('fact.md', 'A private fact', memoryRoot);
    const report = await auditMemory({ provider: 'generic' });
    expect(report.items.find(i => i.sourcePath === path.join(memoryRoot, 'fact.md'))).toBeDefined();
    expect(report.items.some(i => i.sourcePath.includes('backend:kb') && i.observation.status === 'opaque')).toBe(true);
  });

  it('resolves a registered current-project root without scanning another project', async () => {
    const privateRoot = path.join(temp, 'private-current/.aiwg');
    const otherRoot = path.join(temp, 'private-other/.aiwg');
    write('.aiwg/projects/manifest.json', JSON.stringify({ version: 1, projects: [
      { id: 'current', name: 'Current', workspaceRoots: [workspace], gitRemotes: [], memoryRoot: privateRoot, registeredAt: '2026-10-24', updatedAt: '2026-10-24' },
      { id: 'other', name: 'Other', workspaceRoots: [path.join(temp, 'other')], gitRemotes: [], memoryRoot: otherRoot, registeredAt: '2026-10-24', updatedAt: '2026-10-24' },
    ] }), home);
    write('memory/current.md', 'Current project memory', privateRoot);
    write('memory/other.md', 'Other project memory', otherRoot);
    const report = await auditMemory({ provider: 'generic' });
    expect(report.coverage.roots).toContain(path.join(privateRoot, 'memory'));
    expect(report.items.some(i => i.sourcePath === path.join(otherRoot, 'memory/other.md'))).toBe(false);
  });

  it('reads global native stores and registered external roots only with explicit global selection', async () => {
    write('.claude/CLAUDE.md', 'Global instructions', home);
    write('.claude/projects/synthetic/memory/MEMORY.md', truncation.durableText, home);
    write('.claude/projects/synthetic/session.jsonl', 'Never inventory session content', home);
    write('CLAUDE.md', 'Workspace instructions');
    const defaultReport = await auditMemory({ provider: 'claude' });
    expect(defaultReport.items.some(i => i.sourcePath.includes('/home/.claude/'))).toBe(false);
    const globalReport = await auditMemory({ scope: 'global', provider: 'claude' });
    const nativeMemory = globalReport.items.find(i => i.sourcePath.endsWith('/memory/MEMORY.md'))!;
    expect(nativeMemory.bytes).toBe(Buffer.byteLength(truncation.durableText));
    expect(nativeMemory.observation.status).toBe(truncation.status);
    expect(globalReport.items.some(i => i.sourcePath.endsWith('session.jsonl'))).toBe(false);
    expect(globalReport.items.some(i => i.sourcePath === 'CLAUDE.md')).toBe(false);
    expect(globalReport.items.find(i => i.sourcePath.endsWith('/.claude/CLAUDE.md'))?.record?.scope).toBe('global');
  });

  it('inventories global AIWG stores and registered external project roots', async () => {
    const registered = path.join(temp, 'registered/.aiwg');
    write('.aiwg/memory/line-memory.txt', 'Global AIWG fact', home);
    write('.aiwg/context/compound-memory/context.json', '{"entries":{}}', home);
    write('.aiwg/projects/manifest.json', JSON.stringify({ version: 1, projects: [
      { id: 'external', name: 'External', workspaceRoots: [], gitRemotes: [], memoryRoot: registered, registeredAt: '2026-10-24', updatedAt: '2026-10-24' },
    ] }), home);
    write('memory/fact.md', external.content, registered);
    const report = await auditMemory({ scope: 'global', provider: 'generic' });
    expect(report.coverage.roots).toContain(path.join(home, '.aiwg/memory'));
    expect(report.items.find(i => i.sourcePath === path.join(home, '.aiwg/memory/line-memory.txt'))?.record?.scope).toBe('global');
    expect(report.items.some(i => i.sourcePath === path.join(registered, 'memory/fact.md'))).toBe(true);
    expect(report.items.some(i => i.sourcePath === path.join(home, '.aiwg/context/compound-memory/context.json'))).toBe(true);
  });

  it('does not fall back when storage configuration exceeds the metadata bound', async () => {
    write('.aiwg/storage.config', JSON.stringify({ version: '1', roots: { memory: 'x'.repeat(256) } }));
    write('.aiwg/memory/fallback.md', 'Must not be scanned');
    const report = await auditMemory({ provider: 'generic', limits: { maxFileBytes: 128 } });
    expect(report.coverage.limitsHit).toContain('maxFileBytes');
    expect(report.items.some(i => i.sourcePath === '.aiwg/memory/fallback.md')).toBe(false);
    expect(report.items.some(i => i.sourcePath === '.aiwg/storage.config' && i.observation.status === 'inaccessible')).toBe(true);
  });

  it('reports duplicate physical resident records and conflicting metadata without changing owner axes', async () => {
    const resident = { ...ownerRecord(), placement: 'resident' };
    write('.aiwg/memory/a.json', JSON.stringify(resident));
    write('.aiwg/memory/b.json', JSON.stringify({ ...resident, version: 2 }));
    const report = await auditMemory({ provider: 'generic' });
    const items = report.items.filter(i => i.id === resident.id);
    expect(items).toHaveLength(1);
    expect(items[0].exposures.map(e => e.path)).toEqual(expect.arrayContaining(['.aiwg/memory/a.json', '.aiwg/memory/b.json']));
    expect(report.findings.map(f => f.code)).toEqual(expect.arrayContaining(['duplicate-resident-copy', 'conflicting-owner-metadata']));
  });

  it('keeps provider selection workspace scoped and honors the Copilot no-general-precedence contract', async () => {
    write('AGENTS.md', '[Context](WORKSPACE.md)');
    write('WORKSPACE.md', 'Shared context');
    write('CLAUDE.md', 'Other provider');
    const report = await auditMemory({ scope: 'provider', provider: 'codex' });
    expect(report.providers.map(p => p.id)).toEqual(['codex']);
    expect(report.items.some(i => i.sourcePath === 'CLAUDE.md')).toBe(false);
    expect(report.items.find(i => i.sourcePath === 'WORKSPACE.md')?.exposures[0].kind).toBe('reference');
    const copilot = await auditMemory({ scope: 'provider', provider: 'copilot' });
    expect(copilot.providers[0].precedence).toEqual([expect.stringContaining('No general precedence')]);
  });

  it('follows registered instruction imports and reports unresolved patterns', async () => {
    write('opencode.json', JSON.stringify({ instructions: ['docs/import.md', 'docs/*.txt'] }));
    write('docs/import.md', 'Imported instruction');
    const report = await auditMemory({ provider: 'opencode', scope: 'provider' });
    expect(report.items.find(i => i.sourcePath === 'docs/import.md')?.exposures.some(e => e.kind === 'include')).toBe(true);
    expect(report.findings.some(f => f.code === 'unresolved-reference')).toBe(true);
  });

  it('reuses firewall manifest and baseline drift classification', async () => {
    const file = '.claude/rules/stale.md';
    write(file, 'Changed rule');
    write('.claude/rules/.aiwg-manifest.json', JSON.stringify({ managed: { 'stale.md': { hash: sha256('Prior rule') } } }));
    write('.aiwg/context-memory-firewall-baseline.json', JSON.stringify({ schemaVersion: 'aiwg.context-memory-firewall-baseline/v1', files: { 'WORKSPACE.md': { digest: sha256('Old context'), trust: 'user-authored' } } }));
    write('WORKSPACE.md', 'Changed context');
    const report = await auditMemory({ provider: 'claude' });
    expect(report.items.find(i => i.sourcePath === file)?.trust).toBe('stale');
    expect(report.items.find(i => i.sourcePath === 'WORKSPACE.md')?.trust).toBe('quarantined');
    expect(report.findings.map(f => f.code)).toEqual(expect.arrayContaining(['stale-deployed-bytes', 'changed-since-review']));
  });

  it('reports mode-denied files and directories as inaccessible, including under privileged runners', async () => {
    const file = write('CLAUDE.md', 'Unreadable instruction');
    const directory = path.dirname(write('.claude/rules/rule.md', 'Unreadable rule'));
    fs.chmodSync(file, 0o000);
    fs.chmodSync(directory, 0o000);
    const report = await auditMemory({ provider: 'claude' });
    expect(report.items.find(i => i.sourcePath === 'CLAUDE.md')?.observation.status).toBe('inaccessible');
    expect(report.items.find(i => i.sourcePath === '.claude/rules')?.observation.status).toBe('inaccessible');
    expect(report.coverage.complete).toBe(false);
    expect(formatMemoryAudit(report)).toContain('inaccessible');
  });

  it('preserves OS permission errors as inaccessible rather than absent', async () => {
    write('CLAUDE.md', 'Permission denied via filesystem');
    const realpath = fsp.realpath.bind(fsp);
    vi.spyOn(fsp, 'realpath').mockImplementation(async (file, ...rest) => {
      if (String(file).endsWith('CLAUDE.md')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return realpath(file, ...rest as []);
    });
    const report = await auditMemory({ provider: 'claude' });
    expect(report.items.find(i => i.sourcePath === 'CLAUDE.md')?.observation.status).toBe('inaccessible');
  });

  it('does not read credential files or follow unselected external includes', async () => {
    write('CLAUDE.md', '@auth.json\n@../outside.md');
    write('auth.json', '{"token":"never-open"}');
    write('outside.md', 'External instruction body', temp);
    fs.symlinkSync('auth.json', path.join(workspace, 'safe.md'));
    write('CLAUDE.md', '@auth.json\n@safe.md\n@../outside.md');
    const readFile = vi.spyOn(fsp, 'readFile');
    const open = vi.spyOn(fsp, 'open');
    const report = await auditMemory({ provider: 'claude' });
    expect(readFile.mock.calls.some(([file]) => String(file).endsWith('/auth.json'))).toBe(false);
    expect(open.mock.calls.some(([file]) => String(file).endsWith('/auth.json'))).toBe(false);
    expect(report.items.find(i => i.sourcePath === 'safe.md')?.observation.status).toBe('opaque');
    expect(report.items.find(i => i.sourcePath === 'auth.json')?.observation.status).toBe('opaque');
    expect(report.findings.some(f => f.code === 'external-reference')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('never-open');
    expect(JSON.stringify(report)).not.toContain('External instruction body');
  });

  it.each(['maxFiles', 'maxDepth', 'maxEntries', 'maxExposures', 'maxFileBytes'] as const)('reports %s truncation with incomplete coverage', async bound => {
    graphFiles(chain.graph);
    write('.claude/rules/deep/nested/rule.md', 'A lengthy synthetic rule beyond the byte bound');
    const report = await auditMemory({ provider: 'claude', limits: { [bound]: 1 } });
    expect(report.coverage.limitsHit).toContain(bound);
    expect(report.coverage.complete).toBe(false);
    expect(report.findings.some(f => f.code === 'scan-truncated')).toBe(true);
  });

  it('uses an injected clock for time truncation and does not infer injected size from durable bytes', async () => {
    write('CLAUDE.md', truncation.durableText);
    let tick = 0;
    const report = await auditMemory({ provider: 'claude', limits: { maxMs: 1 }, clock: () => tick++ });
    expect(report.coverage.limitsHit).toContain('maxMs');
    expect(report.items.every(i => i.observation.status !== 'observed')).toBe(true);
  });

  it('reports provider byte ceilings as risks with no live truncation claim', async () => {
    write('AGENTS.md', 'x'.repeat(33 * 1024));
    const report = await auditMemory({ provider: 'codex' });
    expect(report.findings.some(f => f.code === 'provider-truncation-risk')).toBe(true);
    expect(report.items.find(i => i.sourcePath === 'AGENTS.md')?.bytes).toBe(33 * 1024);
  });

  it('enumerates the complete adapter registry, with opaque hidden content for every provider', async () => {
    const report = await auditMemory();
    expect(report.providers.map(p => p.id)).toEqual(listProviderMemoryAdapters().map(a => a.providerId));
    for (const provider of report.providers) expect(report.items.some(i => i.sourcePath === `provider:${provider.id}:system` && i.observation.status === 'opaque')).toBe(true);
    expect(report.items.every(i => i.observation.evidence.at && i.observation.evidence.source)).toBe(true);
  });

  it('validates emitted JSON against the published schema and rejects incompatible versions and malformed observations', async () => {
    write('.aiwg/memory/pin.json', JSON.stringify(ownerRecord()));
    const report = await auditMemory({ provider: 'generic' });
    const require = createRequire(import.meta.url);
    const { default: Ajv2020 } = require('ajv/dist/2020.js');
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    require('ajv-formats')(ajv);
    for (const name of ['memory-taxonomy', 'memory-record', 'memory-audit']) ajv.addSchema(JSON.parse(fs.readFileSync(new URL(`../../../schemas/memory/${name}.v1.schema.json`, import.meta.url), 'utf8')));
    const validate = ajv.getSchema('https://aiwg.io/schemas/memory/memory-audit.v1.schema.json')!;
    expect(validate(JSON.parse(JSON.stringify(report))), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...report, schemaVersion: 'aiwg.memory-audit.v99' })).toBe(false);
    const invalid = structuredClone(report);
    invalid.items[0].observation.status = 'observed';
    expect(validate(invalid)).toBe(false);
    expect(MemoryAuditSchema.safeParse(invalid).success).toBe(false);
  });

  it('leaves the entire temp tree byte-for-byte and metadata unchanged for human and JSON CLI output', async () => {
    graphFiles(chain.graph);
    write('.aiwg/memory/pin.json', JSON.stringify(ownerRecord()));
    const before = snapshot(temp);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['audit', '--provider', 'claude', '--json']);
    const report = JSON.parse(log.mock.calls[0][0]);
    expect(report.schemaVersion).toBe('aiwg.memory-audit.v1');
    await main(['audit', '--provider=claude']);
    expect(String(log.mock.calls[1][0])).toContain('live context unobserved');
    expect(snapshot(temp)).toEqual(before);
  });
});

describe('memory audit strict CLI options', () => {
  it.each([
    ['--write'], ['--scope'], ['--scope', '--json'], ['--provider'], ['--scope', 'workspace'],
    ['--scope', 'global', 'unexpected'], ['--json=true'], ['--scope', 'project', '--scope', 'global'],
    ['--provider', 'claude', '--provider', 'codex'], ['--scope', 'provider'], ['--provider='],
  ])('rejects invalid flags %j', args => {
    expect(() => parseMemoryAuditOptions(args)).toThrow();
  });
  it('rejects unknown providers and accepts documented flags and help', async () => {
    expect(parseMemoryAuditOptions(['--scope=provider', '--provider=codex', '--json'])).toEqual({ scope: 'provider', provider: 'codex', json: true });
    await expect(auditMemory({ provider: 'nonexistent' })).rejects.toThrow('Unknown memory provider');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['audit', '--help']);
    expect(log.mock.calls[0][0]).toContain('--scope global|project|provider');
  });
});
