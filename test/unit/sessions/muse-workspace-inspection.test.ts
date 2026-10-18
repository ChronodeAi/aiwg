import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inspectMuseNativeWorkspace, museNativeSourceMatchesWorkspace, MuseWorkspaceInspectionSchema,
} from '../../../src/sessions/adapters/muse.js';
import { MUSE_WORKSPACE_SCAN_LIMITS, MUSE_WORKSPACE_TAIL_BYTES } from '../../../src/sessions/adapters/muse-workspace-scan.js';
import { discoverWorkspaceHistories, readDiscoveryManifest, writeDiscoveryManifest } from '../../../src/sessions/workspace-discovery.js';
import { coverageFromBatchRun } from '../../../src/sessions/batch-contracts.js';
import type { SelectedSource } from '../../../src/sessions/contracts.js';
import { museMetadata, writeMuseLog } from '../../helpers/muse-native.js';
import { createSessionWorktree } from '../../helpers/session-worktree.js';

let root: string;
let workspace: string;
let museRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiwg-muse-inspection-'));
  workspace = join(root, 'workspace');
  museRoot = join(root, 'sessions');
  await Promise.all([workspace, museRoot].map((path) => mkdir(path)));
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function selected(locator: string): SelectedSource {
  return {
    provider: 'muse', locator, locatorClass: 'muse-native-session-log', sourceId: 'synthetic',
    authorizedScope: { workspaceId: workspace, allowedRoots: [museRoot] },
  };
}

describe('bounded Muse workspace inspection', () => {
  it('reports canonical subfolder and worktree match kinds from metadata', async () => {
    const subfolder = join(workspace, 'sub');
    await mkdir(subfolder);
    const alias = join(root, 'workspace-alias');
    await symlink(workspace, alias);
    const worktree = join(root, 'worktree');
    await createSessionWorktree(workspace, worktree);
    for (const [id, cwd, matchKind] of [
      ['exact', workspace, 'exact'],
      ['subfolder', subfolder, 'subfolder'],
      ['symlink', join(alias, 'sub'), 'subfolder'],
      ['worktree', worktree, 'worktree'],
    ]) {
      const locator = await writeMuseLog(museRoot, id, 1, cwd);
      expect(await inspectMuseNativeWorkspace(selected(locator), workspace)).toMatchObject({ outcome: 'matched', matchKind });
    }
    const sibling = `${workspace}-sibling`;
    await mkdir(sibling);
    const mismatch = await writeMuseLog(museRoot, 'sibling', 1, sibling);
    expect(await inspectMuseNativeWorkspace(selected(mismatch), workspace)).toMatchObject({ outcome: 'mismatch' });
    await mkdir(join(subfolder, '.aiwg', 'sessions'), { recursive: true });
    const nested = await writeMuseLog(museRoot, 'nested', 1, subfolder);
    expect(await inspectMuseNativeWorkspace(selected(nested), workspace)).toMatchObject({ outcome: 'mismatch' });
    expect(await inspectMuseNativeWorkspace(selected(nested), subfolder)).toMatchObject({ outcome: 'matched', matchKind: 'exact' });
  });

  it.each([100, 101, 5000, 20_000])('selects %i-record logs on early evidence', async (count) => {
    const locator = await writeMuseLog(museRoot, `session-${count}`, count, workspace);
    expect(await inspectMuseNativeWorkspace(selected(locator), workspace)).toMatchObject({
      outcome: 'matched', reasonCode: null, recordsInspected: 1, completeInspection: false,
    });
    expect(await museNativeSourceMatchesWorkspace(selected(locator), workspace)).toBe(true);
    const manifest = await discoverWorkspaceHistories({ workspace, museRoot, providerHome: root });
    expect(manifest.sources.map((source) => source.locator)).toEqual([locator]);
  });

  it.each([100, 101, 5000])('recognizes retained-frame evidence in %i-record logs', async (count) => {
    const locator = await writeMuseLog(museRoot, `retained-${count}`, count);
    const frame = { retained_frame: 'synthetic-frame', children: [
      { child_index: 0, record_json: JSON.stringify(museMetadata('retained', 0, workspace)) },
    ] };
    const lines = Array.from({ length: count - 1 }, (_, i) => JSON.stringify(museMetadata('retained', i + 1)));
    await writeFile(locator, [JSON.stringify(frame), ...lines].join('\n') + '\n');
    expect(await inspectMuseNativeWorkspace(selected(locator), workspace)).toMatchObject({ outcome: 'matched', recordsInspected: 1 });
  });

  it.each([101, 5000, MUSE_WORKSPACE_SCAN_LIMITS.maxRecords])('finds late evidence at record %i within the budget', async (count) => {
    const locator = await writeMuseLog(museRoot, 'late', count, workspace, count - 1);
    expect(await inspectMuseNativeWorkspace(selected(locator), workspace)).toMatchObject({ outcome: 'matched', recordsInspected: count });
  });

  it('keeps scanning after unrelated evidence before a later match', async () => {
    const locator = await writeMuseLog(museRoot, 'changing-evidence', 1);
    await writeFile(locator, [museMetadata('changing', 0, root), museMetadata('changing', 1, workspace)]
      .map((value) => JSON.stringify(value)).join('\n') + '\n');
    expect(await inspectMuseNativeWorkspace(selected(locator), workspace)).toMatchObject({ outcome: 'matched', recordsInspected: 2 });
  });

  it.each([undefined, 'unrelated'])('finds tail evidence beyond the record budget even after %s evidence', async (initial) => {
    const locator = await writeMuseLog(museRoot, 'too-late', MUSE_WORKSPACE_SCAN_LIMITS.maxRecords + 1, workspace, MUSE_WORKSPACE_SCAN_LIMITS.maxRecords);
    if (initial) {
      // Valid nonmatching evidence does not prove mismatch if inspection is bounded.
      const lines = [museMetadata('too-late', 0, root), ...Array.from({ length: MUSE_WORKSPACE_SCAN_LIMITS.maxRecords }, (_, i) => museMetadata('too-late', i + 1, i === MUSE_WORKSPACE_SCAN_LIMITS.maxRecords - 1 ? workspace : undefined))];
      await writeFile(locator, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    }
    expect(await inspectMuseNativeWorkspace(selected(locator), workspace)).toMatchObject({
      outcome: 'matched', attribution: 'matched', reasonCode: null, completeInspection: false,
      fallback: 'bounded-tail', limit: { name: 'maxRecords', value: MUSE_WORKSPACE_SCAN_LIMITS.maxRecords },
    });
  });

  it.each([undefined, 'unrelated'])('diagnoses evidence beyond the record budget even after %s evidence', async (initial) => {
    const locator = await writeMuseLog(museRoot, 'too-late', MUSE_WORKSPACE_SCAN_LIMITS.maxRecords + 1, workspace, MUSE_WORKSPACE_SCAN_LIMITS.maxRecords);
    if (initial) {
      // Valid nonmatching evidence does not prove mismatch if inspection is bounded.
      const lines = [museMetadata('too-late', 0, root), ...Array.from({ length: MUSE_WORKSPACE_SCAN_LIMITS.maxRecords }, (_, i) => museMetadata('too-late', i + 1, i === MUSE_WORKSPACE_SCAN_LIMITS.maxRecords - 1 ? workspace : undefined))];
      await writeFile(locator, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    }
    // Keep the late evidence outside the bounded tail as well as the prefix.
    await appendFile(locator, JSON.stringify({ padding: 'x'.repeat(MUSE_WORKSPACE_TAIL_BYTES) }) + '\n');
    expect(await inspectMuseNativeWorkspace(selected(locator), workspace)).toMatchObject({
      outcome: 'inconclusive', attribution: 'unattributed', reasonCode: 'RESOURCE_LIMIT_EXCEEDED',
      recordsInspected: MUSE_WORKSPACE_SCAN_LIMITS.maxRecords, completeInspection: false,
      fallback: 'bounded-tail', limit: { name: 'maxRecords', value: MUSE_WORKSPACE_SCAN_LIMITS.maxRecords },
      detail: { limit: 'maxRecords', configured: MUSE_WORKSPACE_SCAN_LIMITS.maxRecords, observed: MUSE_WORKSPACE_SCAN_LIMITS.maxRecords + 1 },
    });
  });

  it.each(['workspace_root', 'cwd', 'retained'] as const)('finds %s evidence after an oversized record', async (kind) => {
    const locator = await writeMuseLog(museRoot, 'oversized-prefix', 1);
    const metadata = kind === 'cwd'
      ? { ...museMetadata('oversized-prefix', 1), payload: { kind: 'metadata', record: { cwd: workspace } } }
      : museMetadata('oversized-prefix', 1, workspace);
    const evidence = kind === 'retained'
      ? { retained_frame: 'frame', children: [{ record_json: JSON.stringify(metadata) }] }
      : metadata;
    await writeFile(locator, JSON.stringify({ padding: 'x'.repeat(MUSE_WORKSPACE_SCAN_LIMITS.maxRecordBytes) })
      + '\r\n' + JSON.stringify(evidence));
    const result = await inspectMuseNativeWorkspace(selected(locator), workspace);
    expect(result).toMatchObject({
      outcome: 'matched', fallback: 'bounded-tail', completeInspection: false,
      limit: { name: 'maxRecordBytes', value: MUSE_WORKSPACE_SCAN_LIMITS.maxRecordBytes },
    });
    expect(result.bytesInspected).toBeLessThanOrEqual(MUSE_WORKSPACE_SCAN_LIMITS.maxRecordBytes + MUSE_WORKSPACE_TAIL_BYTES);
  });

  it('preserves canonical match kinds in bounded-tail receipts', async () => {
    const subfolder = join(workspace, 'sub');
    await mkdir(subfolder);
    const alias = join(root, 'workspace-alias');
    await symlink(workspace, alias);
    const worktree = join(root, 'worktree');
    await createSessionWorktree(workspace, worktree);
    for (const [id, cwd, matchKind] of [
      ['exact', workspace, 'exact'],
      ['subfolder', subfolder, 'subfolder'],
      ['symlink', join(alias, 'sub'), 'subfolder'],
      ['worktree', worktree, 'worktree'],
    ]) {
      const locator = await writeMuseLog(museRoot, id, 1);
      await writeFile(locator, JSON.stringify({ padding: 'x'.repeat(MUSE_WORKSPACE_SCAN_LIMITS.maxRecordBytes) })
        + '\n' + JSON.stringify(museMetadata(id, 1, cwd)) + '\n');
      const result = await inspectMuseNativeWorkspace(selected(locator), workspace);
      expect(result).toMatchObject({
        outcome: 'matched', attribution: 'matched', matchKind, reasonCode: null,
        completeInspection: false, fallback: 'bounded-tail',
        limit: { name: 'maxRecordBytes', value: MUSE_WORKSPACE_SCAN_LIMITS.maxRecordBytes },
      });
      expect(MuseWorkspaceInspectionSchema.parse(result)).toEqual(result);
    }
  });

  it('finds workspace evidence after the default total byte budget', async () => {
    const locator = await writeMuseLog(museRoot, 'total-byte-tail', 1);
    const line = JSON.stringify({ ...museMetadata('large', 0), padding: 'x'.repeat(4000) }) + '\n';
    await writeFile(locator, line.repeat(Math.ceil(MUSE_WORKSPACE_SCAN_LIMITS.maxTotalBytes / Buffer.byteLength(line)) + 1)
      + JSON.stringify(museMetadata('large', 1, workspace)) + '\n');
    const result = await inspectMuseNativeWorkspace(selected(locator), workspace);
    expect(result).toMatchObject({
      outcome: 'matched', fallback: 'bounded-tail', completeInspection: false,
      limit: { name: 'maxTotalBytes', value: MUSE_WORKSPACE_SCAN_LIMITS.maxTotalBytes },
    });
    expect(result.bytesInspected).toBeLessThanOrEqual(MUSE_WORKSPACE_SCAN_LIMITS.maxTotalBytes + MUSE_WORKSPACE_TAIL_BYTES);
  });

  it('does not treat a partial tail record as workspace evidence', async () => {
    const locator = await writeMuseLog(museRoot, 'partial-tail', 1);
    await writeFile(locator, ' '.repeat(MUSE_WORKSPACE_SCAN_LIMITS.maxRecordBytes + 1)
      + JSON.stringify(museMetadata('partial-tail', 0, workspace)) + '\n');
    expect(await inspectMuseNativeWorkspace(selected(locator), workspace)).toMatchObject({
      outcome: 'inconclusive', attribution: 'unattributed', reasonCode: 'RESOURCE_LIMIT_EXCEEDED',
      limit: { name: 'maxRecordBytes', value: MUSE_WORKSPACE_SCAN_LIMITS.maxRecordBytes },
    });
  });

  it('preserves the original limit detail when the tail is malformed', async () => {
    const locator = await writeMuseLog(museRoot, 'malformed-fallback', 1);
    const oversized = JSON.stringify({ padding: 'x'.repeat(MUSE_WORKSPACE_SCAN_LIMITS.maxRecordBytes) }) + '\n';
    await writeFile(locator, oversized + '{invalid}\n');
    expect(await inspectMuseNativeWorkspace(selected(locator), workspace)).toMatchObject({
      outcome: 'inconclusive', attribution: 'unattributed', reasonCode: 'RESOURCE_LIMIT_EXCEEDED',
      fallback: 'bounded-tail', limit: { name: 'maxRecordBytes', value: MUSE_WORKSPACE_SCAN_LIMITS.maxRecordBytes },
      detail: {
        limit: 'maxRecordBytes', configured: MUSE_WORKSPACE_SCAN_LIMITS.maxRecordBytes,
        observed: Buffer.byteLength(oversized),
      },
    });
  });

  it('leaves evidence outside both windows unattributed despite unrelated prefix evidence', async () => {
    const locator = await writeMuseLog(museRoot, 'middle-evidence', 1);
    await writeFile(locator, [
      museMetadata('middle-evidence', 0, root),
      { padding: 'x'.repeat(MUSE_WORKSPACE_SCAN_LIMITS.maxRecordBytes) },
      museMetadata('middle-evidence', 1, workspace),
      { padding: 'x'.repeat(MUSE_WORKSPACE_TAIL_BYTES + 1) },
    ].map((value) => JSON.stringify(value)).join('\n') + '\n');
    expect(await inspectMuseNativeWorkspace(selected(locator), workspace)).toMatchObject({
      outcome: 'inconclusive', attribution: 'unattributed', reasonCode: 'RESOURCE_LIMIT_EXCEEDED',
      completeInspection: false, limit: { name: 'maxRecordBytes', value: MUSE_WORKSPACE_SCAN_LIMITS.maxRecordBytes },
    });
  });

  it.each([100, 101, 5000, MUSE_WORKSPACE_SCAN_LIMITS.maxRecords])('distinguishes absent evidence from confirmed mismatch at EOF (%i records)', async (count) => {
    const absent = await writeMuseLog(museRoot, 'absent', count);
    const mismatch = await writeMuseLog(museRoot, 'mismatch', count, root);
    expect(await inspectMuseNativeWorkspace(selected(absent), workspace)).toMatchObject({ outcome: 'inconclusive', reasonCode: 'MUSE_WORKSPACE_EVIDENCE_ABSENT', completeInspection: true });
    expect(await inspectMuseNativeWorkspace(selected(mismatch), workspace)).toMatchObject({ outcome: 'mismatch', reasonCode: 'MUSE_WORKSPACE_MISMATCH', completeInspection: true });
    await expect(museNativeSourceMatchesWorkspace(selected(absent), workspace)).rejects.toThrow('inconclusive');
    expect(await museNativeSourceMatchesWorkspace(selected(mismatch), workspace)).toBe(false);
  });

  it.each([
    ['malformed JSON', '{invalid}\n', 'MALFORMED_SOURCE'],
    ['non-object record', '123\n', 'MALFORMED_SOURCE'],
    ['truncated tail', '{"sequence":', 'TRUNCATED_SOURCE'],
    ['malformed retained JSON', JSON.stringify({ retained_frame: 'frame', children: [{ record_json: '{bad}' }] }) + '\n', 'MALFORMED_SOURCE'],
    ['unmodelled retained shape only', JSON.stringify({ retained_frame: 'frame', children: [{ record_json: '{}' }] }) + '\n', 'MUSE_WORKSPACE_EVIDENCE_ABSENT'],
    ['unmodelled record only', '{}\n', 'MUSE_WORKSPACE_EVIDENCE_ABSENT'],
    ['empty input', '', 'MUSE_WORKSPACE_EVIDENCE_ABSENT'],
  ])('reports %s explicitly', async (_name, content, reasonCode) => {
    const locator = await writeMuseLog(museRoot, 'invalid', 1);
    await writeFile(locator, content);
    const result = await inspectMuseNativeWorkspace(selected(locator), workspace);
    expect(result).toMatchObject({ outcome: 'inconclusive', reasonCode });
    if (reasonCode === 'MALFORMED_SOURCE') {
      expect(result.detail).toMatchObject({ issues: expect.arrayContaining([
        { path: expect.any(String), code: expect.any(String) },
      ]) });
    }
  });

  it('skips unmodelled native records before workspace evidence (#2865)', async () => {
    const locator = await writeMuseLog(museRoot, 'unmodelled', 1);
    // Muse Code 1.4.3 writes runtime.session mode records whose payload.event has no kind.
    const modeRecord = {
      ...museMetadata('unmodelled', 0, workspace),
      record_type: 'event', payload_type: 'runtime.session',
      payload: { event: { approval: 'never', effective_mode: 'auto', sandbox: 'workspace-write', source: 'startup' } },
    };
    const retained = { retained_frame: 'frame', children: [{ record_json: JSON.stringify(modeRecord) }] };
    await writeFile(locator, [modeRecord, retained, museMetadata('unmodelled', 1, workspace)]
      .map((record) => JSON.stringify(record)).join('\n') + '\n');
    expect(await inspectMuseNativeWorkspace(selected(locator), workspace)).toMatchObject({ outcome: 'matched', recordsInspected: 3 });
  });

  it.each(['maxTotalBytes', 'maxRecordBytes', 'maxNestingDepth', 'maxRecords'] as const)('enforces %s before positive evidence', async (limit) => {
    const locator = await writeMuseLog(museRoot, 'limited', 2, workspace, 1);
    const result = await inspectMuseNativeWorkspace(selected(locator), workspace, { [limit]: 1 });
    expect(result).toMatchObject({
      outcome: 'inconclusive', attribution: 'unattributed', reasonCode: 'RESOURCE_LIMIT_EXCEEDED',
      limit: { name: limit, value: 1 }, fallback: 'bounded-tail',
      detail: { limit, configured: 1, observed: expect.any(Number) },
    });
    expect(JSON.stringify(result.detail)).not.toContain(workspace);
    expect(MuseWorkspaceInspectionSchema.parse(result)).toEqual(result);
  });

  it('bounds decoded retained-child depth and count', async () => {
    const locator = await writeMuseLog(museRoot, 'child-limits', 1);
    let nested: unknown = {};
    for (let i = 0; i < 70; i += 1) nested = { nested };
    const child = { ...museMetadata('child', 0, workspace), nested };
    await writeFile(locator, JSON.stringify({ retained_frame: 'frame', children: [{ record_json: JSON.stringify(child) }] }) + '\n');
    expect(await inspectMuseNativeWorkspace(selected(locator), workspace)).toMatchObject({
      outcome: 'inconclusive', attribution: 'unattributed', reasonCode: 'RESOURCE_LIMIT_EXCEEDED',
      fallback: 'bounded-tail',
      limit: { name: 'maxNestingDepth', value: MUSE_WORKSPACE_SCAN_LIMITS.maxNestingDepth },
      detail: { limit: 'maxNestingDepth', configured: MUSE_WORKSPACE_SCAN_LIMITS.maxNestingDepth, observed: 65 },
    });
    await writeFile(locator, JSON.stringify({ retained_frame: 'frame', children: Array.from({ length: 3 }, (_, sequence) => ({ record_json: JSON.stringify(museMetadata('child', sequence, workspace)) })) }) + '\n');
    expect(await inspectMuseNativeWorkspace(selected(locator), workspace, { maxRecords: 2 })).toMatchObject({
      outcome: 'inconclusive', attribution: 'unattributed', reasonCode: 'RESOURCE_LIMIT_EXCEEDED',
      fallback: 'bounded-tail', limit: { name: 'maxRecords', value: 2 },
      detail: { limit: 'maxRecords', configured: 2, observed: 3 },
    });
  });

  it('bounds retained children cumulatively across frames', async () => {
    const locator = await writeMuseLog(museRoot, 'cumulative-children', 1);
    const frames = [0, 1].map((frame) => ({
      retained_frame: `frame-${frame}`,
      children: [0, 1].map((child) => ({
        record_json: JSON.stringify(museMetadata('child', frame * 2 + child)),
      })),
    }));
    await writeFile(locator, frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n');
    expect(await inspectMuseNativeWorkspace(selected(locator), workspace, { maxRecords: 3 })).toMatchObject({
      outcome: 'inconclusive', attribution: 'unattributed', reasonCode: 'RESOURCE_LIMIT_EXCEEDED',
      fallback: 'bounded-tail', limit: { name: 'maxRecords', value: 3 },
      detail: { limit: 'maxRecords', configured: 3, observed: 4 },
    });
  });

  it('finds tail evidence after a retained-child count limit', async () => {
    const locator = await writeMuseLog(museRoot, 'child-count-tail', 1);
    const frame = {
      retained_frame: 'frame',
      children: [0, 1, 2].map((sequence) => ({
        record_json: JSON.stringify(museMetadata('child', sequence)),
      })),
    };
    await writeFile(locator, [frame, { padding: 'x'.repeat(MUSE_WORKSPACE_TAIL_BYTES) },
      museMetadata('child-count-tail', 1, workspace)].map((value) => JSON.stringify(value)).join('\n') + '\n');
    expect(await inspectMuseNativeWorkspace(selected(locator), workspace, { maxRecords: 2 })).toMatchObject({
      outcome: 'matched', attribution: 'matched', matchKind: 'exact', reasonCode: null,
      fallback: 'bounded-tail', limit: { name: 'maxRecords', value: 2 }, completeInspection: false,
    });
  });

  it.each(['record', 'total'] as const)('enforces the default %s byte budget without unbounded line buffering', async (budget) => {
    const locator = await writeMuseLog(museRoot, 'default-byte-limit', 1);
    if (budget === 'record') {
      await writeFile(locator, 'x'.repeat(MUSE_WORKSPACE_SCAN_LIMITS.maxRecordBytes + 1));
    } else {
      const line = JSON.stringify({ ...museMetadata('large', 0, root), padding: 'x'.repeat(4000) }) + '\n';
      await writeFile(locator, line.repeat(Math.ceil(MUSE_WORKSPACE_SCAN_LIMITS.maxTotalBytes / Buffer.byteLength(line)) + 1));
    }
    const result = await inspectMuseNativeWorkspace(selected(locator), workspace);
    expect(result).toMatchObject({ outcome: 'inconclusive', reasonCode: 'RESOURCE_LIMIT_EXCEEDED', completeInspection: false });
    expect(result.bytesInspected).toBeLessThanOrEqual(MUSE_WORKSPACE_SCAN_LIMITS.maxTotalBytes + MUSE_WORKSPACE_TAIL_BYTES);
    await expect(museNativeSourceMatchesWorkspace(selected(locator), workspace)).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED', detail: result.detail,
    });
  });

  it('rejects deeply nested outer JSON with a resource diagnostic', async () => {
    const locator = await writeMuseLog(museRoot, 'deep-outer', 1);
    await writeFile(locator, '{"sequence":0,"nested":' + '['.repeat(2000) + '0' + ']'.repeat(2000) + '}\n');
    expect(await inspectMuseNativeWorkspace(selected(locator), workspace)).toMatchObject({ outcome: 'inconclusive', reasonCode: 'RESOURCE_LIMIT_EXCEEDED' });
  });

  it('handles blank lines, CRLF, chunk boundaries, UTF-8, and a complete unterminated record', async () => {
    const locator = await writeMuseLog(museRoot, 'boundaries', 1);
    const record = { ...museMetadata('boundaries', 0, workspace), padding: 'é'.repeat(40_000) };
    await writeFile(locator, '\r\n  \r\n' + JSON.stringify(record));
    expect(await inspectMuseNativeWorkspace(selected(locator), workspace)).toMatchObject({ outcome: 'matched', recordsInspected: 1 });
  });

  it('reports unreadable and unauthorized sources without escaping the explicit root', async () => {
    const outside = await writeMuseLog(root, 'outside', 1, workspace);
    expect(await inspectMuseNativeWorkspace(selected(outside), workspace)).toMatchObject({ outcome: 'inconclusive', reasonCode: 'SOURCE_OUTSIDE_ALLOWED_ROOT' });
    expect(await inspectMuseNativeWorkspace(selected(join(museRoot, 'missing')), workspace)).toMatchObject({ outcome: 'inconclusive', reasonCode: 'SOURCE_NOT_AUTHORIZED' });
    const link = join(museRoot, 'link.jsonl');
    await symlink(outside, link);
    expect(await inspectMuseNativeWorkspace(selected(link), workspace)).toMatchObject({ outcome: 'inconclusive', reasonCode: 'SOURCE_SYMLINK' });
    const directoryLink = join(museRoot, 'escaped');
    await symlink(root, directoryLink);
    expect(await inspectMuseNativeWorkspace(selected(join(directoryLink, '2026', '09', '24', 'outside', 'session.jsonl')), workspace)).toMatchObject({ outcome: 'inconclusive', reasonCode: 'SOURCE_OUTSIDE_ALLOWED_ROOT' });
  });

  it('persists content-free receipts and keeps unresolved Muse coverage partial', async () => {
    await writeMuseLog(museRoot, 'matched', 101, workspace);
    await writeMuseLog(museRoot, 'mismatch', 101, root);
    await writeMuseLog(museRoot, 'absent', 101);
    const malformed = await writeMuseLog(museRoot, 'malformed', 1);
    await writeFile(malformed, '{private-content-invalid}\n');
    await writeMuseLog(museRoot, 'limited', MUSE_WORKSPACE_SCAN_LIMITS.maxRecords + 1);
    const manifest = await discoverWorkspaceHistories({ workspace, museRoot, providerHome: root });
    expect(manifest.sources).toHaveLength(1);
    const report = manifest.providers.find((provider) => provider.provider === 'muse')!;
    expect(report).toMatchObject({ status: 'not-checked', sourceCount: 1, reasonCode: 'MUSE_SOURCE_INSPECTION_INCOMPLETE', remediation: expect.any(String) });
    expect(report.museSourceInspections?.map((inspection) => inspection.reasonCode).sort())
      .toEqual([null, 'MUSE_WORKSPACE_MISMATCH', 'MUSE_WORKSPACE_EVIDENCE_ABSENT', 'MALFORMED_SOURCE', 'RESOURCE_LIMIT_EXCEEDED'].sort());
    expect(JSON.stringify(report)).not.toContain('private-content');
    expect(report.museSourceInspections?.find((inspection) => inspection.reasonCode === null))
      .toMatchObject({ attribution: 'matched', matchKind: 'exact' });
    expect(report.museSourceInspections?.find((inspection) => inspection.reasonCode === 'RESOURCE_LIMIT_EXCEEDED'))
      .toMatchObject({
        attribution: 'unattributed', fallback: 'bounded-tail',
        limit: { name: 'maxRecords', value: MUSE_WORKSPACE_SCAN_LIMITS.maxRecords },
        detail: { limit: 'maxRecords', configured: MUSE_WORKSPACE_SCAN_LIMITS.maxRecords, observed: MUSE_WORKSPACE_SCAN_LIMITS.maxRecords + 1 },
      });
    expect(report.museSourceInspections?.every((inspection) => !inspection.redactedLocator.includes(root))).toBe(true);
    const path = join(root, 'manifest.json');
    await writeDiscoveryManifest(path, manifest);
    expect(await readDiscoveryManifest(path)).toEqual(manifest);
    const coverage = coverageFromBatchRun({
      schemaVersion: '1.0.0', runId: 'synthetic', manifestId: manifest.manifestId,
      manifestCreatedAt: manifest.createdAt, workspaceId: workspace, status: 'partial',
      startedAt: manifest.createdAt, updatedAt: manifest.createdAt, completedAt: manifest.createdAt,
      providers: [report], sources: [],
    });
    expect(coverage).toMatchObject({ status: 'partial', providers: { notChecked: ['muse'] } });
    report.museSourceInspections![0].reasonCode = 'tampered';
    await writeDiscoveryManifest(path, manifest);
    await expect(readDiscoveryManifest(path)).rejects.toThrow('identity');
  });
});
