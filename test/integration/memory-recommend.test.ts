import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildIndex } from '../../src/artifacts/index-builder.js';
import type { MemoryRecommendations } from '../../src/memory/recommend.js';
import type { MemoryAudit } from '../../src/memory/audit.js';

const cli = path.resolve('bin/aiwg.mjs');
let temporary: string;
let workspace: string;
let env: NodeJS.ProcessEnv;
function write(relative: string, value: unknown): void {
  const file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function run(args: string[]): string {
  return execFileSync(process.execPath, [cli, 'memory', ...args], { cwd: workspace, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
}
function fail(args: string[]): string {
  const result = spawnSync(process.execPath, [cli, 'memory', ...args], { cwd: workspace, env, encoding: 'utf8', timeout: 30000 });
  expect(result.status).toBe(1);
  return result.stdout + result.stderr;
}
function snapshot(root: string): unknown[] {
  return fs.readdirSync(root).sort().map(name => {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    return [name, stat.mode, stat.mtimeMs, stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('base64')];
  });
}
function setupEvidence(): void {
  const audit = JSON.parse(run(['audit', '--provider', 'claude', '--json'])) as MemoryAudit;
  const item = audit.items.find(i => i.sourcePath === '.aiwg/wiki/decision.md')!;
  write('evidence.json', { items: { [item.id]: { source: 'synthetic-owner-review', categoryCorrection: 'decision' } } });
}
function exportCandidate(): MemoryRecommendations {
  const report = JSON.parse(run(['recommend', '--provider', 'claude', '--evidence', 'evidence.json', '--json'])) as MemoryRecommendations;
  const candidate = report.candidates.find(c => c.kind === 'recategorize')!;
  return JSON.parse(run(['recommend', '--provider', 'claude', '--evidence', 'evidence.json', '--candidate', candidate.id, '--emit-review-input']));
}
beforeEach(async () => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-memory-recommend-cli-'));
  workspace = path.join(temporary, 'workspace');
  const home = path.join(temporary, 'home');
  fs.mkdirSync(workspace); fs.mkdirSync(home);
  env = { ...process.env, HOME: home, USERPROFILE: home, AIWG_CONFIG: path.join(home, '.aiwg'), AIWG_CLI_DRY_RUN: '',
    AIWG_PROJECT_MEMORY_HOME: path.join(home, '.aiwg/projects'), HERMES_HOME: path.join(home, '.hermes'), XDG_CONFIG_HOME: path.join(home, '.config'),
    AIWG_ARTIFACTS_PATH: '', AIWG_PROJECT_ARTIFACTS_PATH: '', AIWG_PROJECT_AIWG_DIR: '', AIWG_GROKBOT_SKILLS_DIR: '',
    GROK_HOME: '', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', PI_CONFIG_DIR: '', PI_CODING_AGENT_DIR: '', OMP_PROFILE: '', PI_PROFILE: '',
    AIWG_RULES_INLINE_BUDGET_TOKENS: '', NO_COLOR: '1' };
  delete env.AIWG_RULES_INLINE_BUDGET_TOKENS;
  write('CLAUDE.md', '@WORKSPACE.md');
  write('WORKSPACE.md', 'Synthetic workspace context');
  write('.aiwg/wiki/decision.md', '# Synthetic knowledge\nKeep bounded retries.\n');
  write('.claude/rules/duplicate-a.md', 'Same synthetic rule');
  write('.claude/rules/duplicate-b.md', 'Same synthetic rule');
  write('.aiwg/aiwg.config', { version: '1', command_log: { enabled: true, scopes: ['project', 'global'] }, telemetry: { skill_usage: { enabled: true, scopes: ['project', 'global'] } } });
  await buildIndex(workspace, { force: true, quiet: true, workers: 0 });
});
afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

describe('built read-only recommendation CLI', () => {
  it('emits JSON and human reports without writing workspace, global telemetry, indexes or receipts', () => {
    setupEvidence();
    const before = snapshot(temporary);
    const report = JSON.parse(run(['recommend', '--provider', 'claude', '--json'])) as MemoryRecommendations;
    expect(report.schemaVersion).toBe('aiwg.memory-recommendations.v1');
    expect(report.advisoryOnly).toBe(true);
    expect(report.candidates.some(c => c.kind === 'merge')).toBe(true);
    expect(run(['recommend', '--scope=project', '--provider=codex'])).toContain('advisory only');
    expect(run(['recommend', '--scope=provider', '--provider=codex', '--json'])).toContain('aiwg.memory-recommendations.v1');
    expect(run(['recommend', '--scope=global', '--provider=claude', '--json'])).toContain('aiwg.memory-recommendations.v1');
    expect(exportCandidate().candidates).toHaveLength(1);
    expect(snapshot(temporary)).toEqual(before);
  });

  it('hands a selected stdout export to existing reviewed planning without applying anything', () => {
    setupEvidence();
    const report = exportCandidate();
    expect(report).not.toHaveProperty('operations');
    write('review.json', report);
    const before = snapshot(temporary);
    const result = JSON.parse(run(['plan', '--recommendation', 'review.json', '--reviewer', 'synthetic operator', '--preview', '--json']));
    expect(result.plan.schemaVersion).toBe('aiwg.maintenance-plan.v1');
    expect(result.plan.operations[0]).toMatchObject({ op: 'recategorize', category: 'decision', review: { reviewer: 'synthetic operator' }, owner: { name: 'semantic-memory' } });
    expect(snapshot(temporary)).toEqual(before);
    run(['plan', '--recommendation', 'review.json', '--reviewer', 'synthetic operator', '--out', 'plan.json']);
    expect(fs.existsSync(path.join(workspace, 'plan.json'))).toBe(true);
    fs.unlinkSync(path.join(workspace, 'plan.json'));
    // Deleting the only authorized output changes the parent directory mtime.
    expect(fs.readFileSync(path.join(workspace, '.aiwg/wiki/decision.md'), 'utf8')).toBe('# Synthetic knowledge\nKeep bounded retries.\n');
    expect(fs.existsSync(path.join(workspace, '.aiwg/memory/maintenance'))).toBe(false);
  });

  it('uses real owner placement and binds whole-source hashes separately from body revisions', () => {
    run(['plan', '--owner', 'semantic-memory', '--target', '.aiwg/wiki/decision.md', '--op', 'promote', '--placement', 'resident', '--reviewer', 'operator', '--rationale', 'Synthetic continuing obligation', '--out', 'promote.json']);
    run(['apply', '--plan', 'promote.json', '--yes', '--json']);
    const audit = JSON.parse(run(['audit', '--provider', 'claude', '--json'])) as MemoryAudit;
    const item = audit.items.find(i => i.sourcePath === '.aiwg/wiki/decision.md')!;
    expect(item.record!.placement).toBe('resident');
    expect(item.record!.version).toBe(2);
    expect(item.sourceDigest).not.toBe(item.digest);
    write('evidence.json', { thresholds: { demoteMinimumTokens: 1 }, items: { [item.id]: { source: 'synthetic-owner-review', provenance: 'verified' } } });
    write('usage.json', { [item.id]: { used: false, evidence: 'synthetic-task-review' } });
    const args = ['--provider', 'claude', '--evidence', 'evidence.json', '--usage', 'usage.json'];
    const report = JSON.parse(run(['recommend', ...args, '--json'])) as MemoryRecommendations;
    const candidate = report.candidates.find(c => c.kind === 'demote' && c.target.id === item.id)!;
    expect(candidate.status).toBe('advisory');
    write('review.json', JSON.parse(run(['recommend', ...args, '--candidate', candidate.id, '--emit-review-input'])));
    const before = snapshot(temporary);
    const preview = JSON.parse(run(['plan', '--recommendation', 'review.json', '--reviewer', 'operator', '--preview', '--json']));
    expect(preview.plan.operations[0]).toMatchObject({ op: 'demote', target: { digest: item.record!.digest, version: 2 }, to: { placement: 'indexed' } });
    expect(snapshot(temporary)).toEqual(before);
  });

  it('preserves source-frontmatter pins even when utility is low and caller evidence omits the pin', () => {
    write('.aiwg/wiki/pinned.md', '---\npinned: true\n---\nRare critical obligation.\n');
    const audit = JSON.parse(run(['audit', '--provider', 'claude', '--json'])) as MemoryAudit;
    const item = audit.items.find(i => i.sourcePath === '.aiwg/wiki/pinned.md')!;
    expect(item.record!.authority.protection).toBe('pinned');
    write('evidence.json', { items: { [item.id]: { source: 'synthetic-review', provenance: 'verified', history: 'known', createdAt: '2025-01-01T00:00:00.000Z', obsolete: true } } });
    write('usage.json', { [item.id]: { used: false, evidence: 'synthetic-utility' } });
    const report = JSON.parse(run(['recommend', '--provider', 'claude', '--evidence', 'evidence.json', '--usage', 'usage.json', '--json'])) as MemoryRecommendations;
    const retirement = report.candidates.find(c => c.kind === 'retire' && c.target.id === item.id)!;
    expect(retirement.status).toBe('blocked');
    expect(retirement.protectedItemExceptions).toContain('Owner pin protects this item');
    expect(fail(['recommend', '--provider', 'claude', '--evidence', 'evidence.json', '--usage', 'usage.json', '--candidate', retirement.id, '--emit-review-input'])).toContain('candidate is blocked');
  });

  it('requires a reviewer and rejects stale source bindings, ambiguous inputs and blocked proposals', () => {
    setupEvidence();
    const report = exportCandidate();
    write('review.json', report);
    expect(fail(['plan', '--recommendation', 'review.json', '--preview'])).toContain('--reviewer');
    expect(fail(['plan', '--recommendation', 'review.json', '--reviewer', 'operator', '--op', 'retire', '--preview'])).toContain('cannot be combined');
    write('.aiwg/wiki/decision.md', 'Concurrent source revision');
    expect(fail(['plan', '--recommendation', 'review.json', '--reviewer', 'operator', '--preview'])).toContain('Stale recommendation');
    report.candidates[0].status = 'blocked';
    report.candidates[0].blockedReasons = ['Rare obligation'];
    write('review.json', report);
    expect(fail(['plan', '--recommendation', 'review.json', '--reviewer', 'operator', '--preview'])).toContain('Blocked, rejected or conflicting');
  });

  it('binds both duplicate sources and requires an explicit reviewed merge replacement', async () => {
    write('.aiwg/wiki/duplicate.md', '# Synthetic knowledge\nKeep bounded retries.\n');
    await buildIndex(workspace, { force: true, quiet: true, workers: 0 });
    const report = JSON.parse(run(['recommend', '--provider', 'claude', '--json'])) as MemoryRecommendations;
    const candidate = report.candidates.find(c => c.kind === 'merge' && c.target.scope === 'project')!;
    expect(candidate.status).toBe('advisory');
    expect(candidate.relatedTargets).toHaveLength(1);
    write('review.json', JSON.parse(run(['recommend', '--provider', 'claude', '--candidate', candidate.id, '--emit-review-input'])));
    write('replacement.json', [{ key: 'merged-decision', value: '# Synthetic knowledge\nKeep bounded retries.\n', sourcePath: '.aiwg/wiki/merged.md' }]);
    const args = ['plan', '--recommendation', 'review.json', '--reviewer', 'operator', '--replacements', 'replacement.json', '--preview', '--json'];
    const before = snapshot(temporary);
    const preview = JSON.parse(run(args));
    expect(preview.plan.operations[0].op).toBe('merge');
    expect(preview.plan.operations[0].related).toHaveLength(1);
    expect(snapshot(temporary)).toEqual(before);
    write(candidate.relatedTargets[0].record.sourcePath, 'Concurrent duplicate revision');
    expect(fail(args)).toContain('Stale related recommendation source digest');
  });

  it('fails closed on unsupported lineage handoff and foreign workspace inputs', () => {
    setupEvidence();
    const report = exportCandidate();
    report.candidates[0].kind = 'merge';
    write('review.json', report);
    expect(fail(['plan', '--recommendation', 'review.json', '--reviewer', 'operator', '--preview'])).toContain('Lineage recommendations require explicit owner review');
    report.workspace = path.join(temporary, 'another-workspace');
    write('review.json', report);
    expect(fail(['plan', '--recommendation', 'review.json', '--reviewer', 'operator', '--preview'])).toContain('this workspace');
  });

  it('advertises recommend and rejects mutation flags, missing selections, and malformed evidence', () => {
    expect(run(['--help'])).toContain('recommend');
    expect(run(['recommend', '--help'])).toContain('--emit-review-input');
    expect(run(['plan', '--help'])).toContain('--recommendation');
    for (const args of [['--write'], ['--scope', 'provider'], ['--json=true'], ['--candidate', 'id'], ['--provider', 'missing']]) {
      expect(fail(['recommend', ...args])).toMatch(/memory command failed|Unknown memory provider/);
    }
    write('evidence.json', { thresholds: { minimumAgeDays: -1 } });
    expect(fail(['recommend', '--evidence', 'evidence.json'])).toContain('memory command failed');
    expect(fail(['recommend', '--candidate', 'missing', '--emit-review-input'])).toContain('missing or changed');
  });
});
