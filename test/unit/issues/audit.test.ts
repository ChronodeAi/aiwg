import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { runIssueAudit, renderIssueAudit } from '../../../src/issues/audit.js';
import { auditBytes, parseAuditFilter, type AuditMetadata, type AuditTracker } from '../../../src/issues/audit-contract.js';
import { main } from '../../../src/issues/audit-cli.js';
import { LocalIssueProviderCore } from '../../../src/issues/local.js';
import { createLocalAuditTracker } from '../../../src/issues/audit-local.js';
import { extractSkillScript, parseFrontmatter } from '../../../src/artifacts/index-builder.js';
import { ForgeReadError } from '../../../src/tracker/forge-http.js';

function fakeTracker(count = 250) {
  const pages: Array<{ cursor: string | null; pageSize: number }> = [];
  const hydrated: string[] = [];
  const data: AuditMetadata[] = Array.from({ length: count }, (_, i) => ({ id: String(i + 1),
    title: `Issue ${i + 1}`, labels: i % 10 === 0 ? ['epic'] : [], status: 'open', updatedAt: '2026-10-01T00:00:00Z' }));
  const tracker: AuditTracker = {
    identity: 'fake:backlog',
    async listMetadata(options) {
      pages.push({ cursor: options.cursor, pageSize: options.pageSize });
      const start = Number(options.cursor ?? 0);
      const items = data.slice(start, start + options.pageSize);
      const next = start + items.length;
      return { items, bytes: auditBytes(items), nextCursor: next < count ? String(next) : null, complete: next >= count };
    },
    async hydrate(issue) {
      hydrated.push(issue.id);
      return { body: 'private issue body', comments: ['private comment'], bytes: 100 };
    },
  };
  return { tracker, pages, hydrated, data };
}

describe('bounded issue-audit', () => {
  let root: string;
  let checkpoint: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'aiwg-audit-')); checkpoint = join(root, 'audit.json'); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('declares executable metadata consumed by the existing discovery index', async () => {
    const skill = await readFile(new URL('../../../agentic/code/frameworks/sdlc-complete/skills/issue-audit/SKILL.md', import.meta.url), 'utf8');
    expect(extractSkillScript(parseFrontmatter(skill).data)).toEqual({ entrypoint: 'scripts/audit.mjs', runtime: 'node', cwd: 'project-root' });
  });

  it('pages 250 issues within per-batch item/byte bounds and hydrates only selected candidates', async () => {
    const fake = fakeTracker();
    const report = await runIssueAudit(fake.tracker, { checkpoint, pageSize: 25, maxBytes: 6000 });
    expect(report.coverage).toEqual({ totalSeen: 250, totalCompleted: 250, totalHydrated: 25, incomplete: false, reason: null });
    expect(fake.pages).toHaveLength(10);
    expect(fake.pages.map(p => p.cursor)).toEqual([null, '25', '50', '75', '100', '125', '150', '175', '200', '225']);
    expect(report.batches.every(b => b.items <= 25 && b.bytes <= 6000)).toBe(true);
    expect(new Set(fake.hydrated).size).toBe(25);
    const retained = await readFile(checkpoint, 'utf8');
    expect(retained).not.toContain('private issue body');
    expect(retained).not.toContain('private comment');
  });

  it('resumes in the middle of a persisted page without refetching it or duplicating findings', async () => {
    const fake = fakeTracker(60);
    const controller = new AbortController();
    const first = await runIssueAudit(fake.tracker, { checkpoint, signal: controller.signal,
      afterItem: id => { if (id === '7') controller.abort(); } });
    expect(first.coverage).toMatchObject({ incomplete: true, reason: 'interrupted', totalCompleted: 7, totalSeen: 25 });
    const second = await runIssueAudit(fake.tracker, { checkpoint });
    expect(second.coverage).toMatchObject({ incomplete: false, totalCompleted: 60, totalSeen: 60, totalHydrated: 6 });
    expect(second.findings.map(f => f.id)).toEqual(fake.data.map(i => i.id));
    expect(fake.pages.map(p => p.cursor)).toEqual([null, '25', '50']);
    expect(new Set(fake.hydrated).size).toBe(fake.hydrated.length);
    const again = await runIssueAudit(fake.tracker, { checkpoint });
    expect(again.findings).toEqual(second.findings);
    expect(fake.pages).toHaveLength(3);
  });

  it('persists checkpoints that match the governed checkpoint schema, mid-page and finished', async () => {
    const schema = JSON.parse(await readFile(new URL('../../../schemas/skills/issue-audit-checkpoint.v1.schema.json', import.meta.url), 'utf8'));
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    const fake = fakeTracker(60);
    const controller = new AbortController();
    await runIssueAudit(fake.tracker, { checkpoint, signal: controller.signal,
      afterItem: id => { if (id === '7') controller.abort(); } });
    const midPage = JSON.parse(await readFile(checkpoint, 'utf8'));
    expect(midPage.pending.length).toBeGreaterThan(0);
    expect(validate(midPage), JSON.stringify(validate.errors)).toBe(true);
    await runIssueAudit(fake.tracker, { checkpoint });
    const finished = JSON.parse(await readFile(checkpoint, 'utf8'));
    expect(finished.finished).toBe(true);
    expect(validate(finished), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...finished, token: 'x' })).toBe(false);
  });

  it('continues after a completed page when an item budget stops execution', async () => {
    const fake = fakeTracker(51);
    const first = await runIssueAudit(fake.tracker, { checkpoint, maxItems: 25 });
    expect(first.coverage).toMatchObject({ incomplete: true, reason: 'item-budget', totalCompleted: 25 });
    expect(first.continuation).toMatchObject({ cursor: '25', pending: 0 });
    const resumed = await runIssueAudit(fake.tracker, { checkpoint });
    expect(resumed.coverage).toMatchObject({ incomplete: false, totalCompleted: 51 });
    expect(new Set(resumed.findings.map(f => f.id)).size).toBe(51);
  });

  it('marks context budget exhaustion incomplete and permits a larger budget on resume', async () => {
    const fake = fakeTracker(25);
    const report = await runIssueAudit(fake.tracker, { checkpoint, maxContextBytes: 3700 });
    expect(report.coverage).toMatchObject({ incomplete: true, reason: 'context-budget' });
    expect(renderIssueAudit(report)).toContain('INCOMPLETE (context-budget)');
    expect((await runIssueAudit(fake.tracker, { checkpoint })).coverage.incomplete).toBe(false);
  });

  it('does not checkpoint or accept an oversized page', async () => {
    const fake = fakeTracker(25);
    const report = await runIssueAudit(fake.tracker, { checkpoint, maxBytes: 100 });
    expect(report.coverage).toMatchObject({ incomplete: true, reason: 'byte-budget', totalSeen: 0 });
    expect(report.findings).toEqual([]);
  });

  it('reports transport limits and provider failures with safe, distinct reasons', async () => {
    const fake = fakeTracker(25);
    for (const [code, reason] of [['oversized', 'byte-budget'], ['rate-limited', 'tracker-rate-limited']] as const) {
      fake.tracker.listMetadata = async () => { throw new ForgeReadError(code); };
      expect((await runIssueAudit(fake.tracker, { checkpoint })).coverage).toMatchObject({ incomplete: true, reason, totalSeen: 0 });
    }
  });

  it('resumes a hydration provider error without omissions or exposing error content', async () => {
    const fake = fakeTracker(30);
    const hydrate = fake.tracker.hydrate;
    fake.tracker.hydrate = async (issue, options) => {
      if (issue.id === '11') throw new Error('private credentials must not appear');
      return hydrate(issue, options);
    };
    const first = await runIssueAudit(fake.tracker, { checkpoint });
    expect(first.coverage).toMatchObject({ incomplete: true, reason: 'tracker-error', totalCompleted: 10 });
    expect(JSON.stringify(first)).not.toContain('private credentials');
    fake.tracker.hydrate = hydrate;
    const resumed = await runIssueAudit(fake.tracker, { checkpoint });
    expect(resumed.findings.map(f => f.id)).toEqual(fake.data.map(i => i.id));
    expect(fake.hydrated.filter(id => id === '1')).toHaveLength(1);
  });

  it('deduplicates repeated issues across synthetic pages', async () => {
    const fake = fakeTracker(30);
    fake.data[25] = fake.data[0];
    const report = await runIssueAudit(fake.tracker, { checkpoint });
    expect(report.coverage).toMatchObject({ totalSeen: 29, totalCompleted: 29 });
    expect(fake.hydrated.filter(id => id === '1')).toHaveLength(1);
  });

  it('rejects changed checkpoint scope and malformed checkpoints', async () => {
    const fake = fakeTracker(1);
    await runIssueAudit(fake.tracker, { checkpoint });
    await expect(runIssueAudit(fake.tracker, { checkpoint, guidance: 'changed' })).rejects.toThrow('checkpoint-scope-mismatch');
    await writeFile(checkpoint, '{broken');
    await expect(runIssueAudit(fake.tracker, { checkpoint })).rejects.toThrow('checkpoint-invalid');
  });

  it('rejects cursors that do not advance', async () => {
    const fake = fakeTracker(30);
    fake.tracker.listMetadata = async () => ({ items: [], bytes: 2, nextCursor: null, complete: false });
    const report = await runIssueAudit(fake.tracker, { checkpoint });
    expect(report.coverage).toMatchObject({ incomplete: true, reason: 'pagination-incomplete' });
  });

  it('bounds empty pages and rejects cycles even when no issues consume the item budget', async () => {
    const fake = fakeTracker(0);
    let call = 0;
    fake.tracker.listMetadata = async () => ({ items: [], bytes: 2, nextCursor: String(++call), complete: false });
    expect((await runIssueAudit(fake.tracker, { checkpoint, maxPages: 3 })).coverage)
      .toMatchObject({ incomplete: true, reason: 'page-budget', totalSeen: 0 });
    expect(call).toBe(3);
    await rm(checkpoint);
    call = 0;
    fake.tracker.listMetadata = async () => ({ items: [], bytes: 2, nextCursor: ['a', 'b', 'a'][call++], complete: false });
    expect((await runIssueAudit(fake.tracker, { checkpoint })).coverage.reason).toBe('cursor-invalidated');
  });

  it('exposes JSON coverage, selective hydration and a visible incomplete Markdown CLI report', async () => {
    const fake = fakeTracker(30);
    const lines: string[] = [];
    const args = ['--provider', 'local', '--checkpoint', checkpoint, '--select', '2,3', '--max-items', '5', '--format', 'json'];
    const deps = { tracker: fake.tracker, config: null, remoteUrls: {}, output: (line: string) => lines.push(line) };
    expect(await main(args, root, deps)).toBe(2);
    expect(JSON.parse(lines.pop()!).coverage).toMatchObject({ totalHydrated: 2, totalCompleted: 5, incomplete: true, reason: 'item-budget' });
    expect(fake.hydrated).toEqual(['2', '3']);
    expect(await main([...args.slice(0, -2), '--format', 'markdown'], root, deps)).toBe(2);
    expect(lines.pop()).toContain('INCOMPLETE (item-budget)');
  });

  it('refuses apply mode before any tracker read', async () => {
    const fake = fakeTracker(30);
    expect(await main(['--apply', '--format', 'json'], root, { tracker: fake.tracker, output: () => {} })).toBe(2);
    expect(fake.pages).toEqual([]);
    expect(fake.hydrated).toEqual([]);
  });

  it('resolves semantic filter/selection roles to provider labels containing spaces', async () => {
    const fake = fakeTracker(1);
    fake.data[0].labels = ['Later please'];
    const list = fake.tracker.listMetadata;
    let resolvedFilter = '';
    fake.tracker.listMetadata = async options => { resolvedFilter = options.filter; return list(options); };
    const result: string[] = [];
    const code = await main(['--provider', 'local', '--filter', 'status:open label:lifecycle.deferred',
      '--format', 'json', '--checkpoint', checkpoint], root, { tracker: fake.tracker, remoteUrls: {},
      output: text => result.push(text), config: { version: '1', providers: [], installed: {}, scripts: {},
        issues: { labels: { 'lifecycle.deferred': { name: 'Deferred', provider_names: { local: 'Later please' },
          category: 'lifecycle', description: 'Deferred work', requires_human: false, blocks_automation: false } } } } });
    expect(code).toBe(0);
    expect(parseAuditFilter(resolvedFilter)).toEqual({ status: 'open', labels: ['Later please'] });
    expect(JSON.parse(result[0]).coverage.totalHydrated).toBe(1);
    expect(JSON.parse(result[0]).findings[0].category).toBe('Cleanup Candidates');
  });

  it('uses the local metadata index and invalidates cursors after index changes', async () => {
    const issuesRoot = join(root, 'issues');
    const local = new LocalIssueProviderCore(issuesRoot);
    await local.init({ prefix: 'AUD' });
    await local.createIssue({ title: 'Ordinary', body: 'do not load', type: 'task' });
    await local.createIssue({ title: 'Epic', body: 'child table', type: 'epic' });
    const tracker = createLocalAuditTracker(issuesRoot);
    const page = await tracker.listMetadata({ cursor: null, pageSize: 1, maxBytes: 6000, filter: 'status:open' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).not.toHaveProperty('body');
    await expect(tracker.listMetadata({ cursor: 'broken', pageSize: 1, maxBytes: 6000, filter: 'status:open' })).rejects.toThrow('cursor-invalidated');
    await local.createIssue({ title: 'Added', body: '', type: 'task' });
    await expect(tracker.listMetadata({ cursor: page.nextCursor, pageSize: 1, maxBytes: 6000, filter: 'status:open' })).rejects.toThrow('tracker-changed');
    const report = await runIssueAudit(tracker, { checkpoint, pageSize: 1 });
    expect(report.coverage).toMatchObject({ incomplete: false, totalCompleted: 3, totalHydrated: 1 });
  });
});
