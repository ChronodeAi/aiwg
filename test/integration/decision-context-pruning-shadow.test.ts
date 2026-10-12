import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextBudgetManager, type BudgetConfig } from '../../src/metrics/context-budget.js';
import { canonicalJson } from '../../src/security/artifact-trust.js';
import {
  applyContextPruningPilot,
  contextPruningDigest,
  type ContextPruningCandidate,
  type ContextPruningPolicy,
} from '../../src/decision/context-pruning.js';

/*
 * AIWG has no code path that turns context items into a downstream model prompt: the host harness
 * (Claude Code, Codex, ...) assembles its own prompt. The only AIWG context-selection substrate is
 * ContextBudgetManager (src/metrics/context-budget.ts), and nothing but this pilot consumes it. This test
 * therefore proves byte identity for the real ContextBudgetManager selection (the item bodies, order and
 * metadata it hands onward) rather than for an invented prompt renderer. The last test fails if a real
 * consumer appears, so the byte-identity check can be moved onto it.
 */

const now = () => '2026-09-29T12:00:00.000Z';
const digest = (value: unknown) => contextPruningDigest(value);
const budget: Partial<BudgetConfig> = {
  totalTokens: 120, contextFraction: 0.5, generationFraction: 0.5, warningThreshold: 0.5, hardLimitThreshold: 0.9,
};

function item(id: string, content: string, overrides: Partial<ContextPruningCandidate> = {}): ContextPruningCandidate {
  return {
    schemaVersion: 'decision-context-candidate/v1',
    itemId: id,
    locator: `fixture://${id}`,
    content,
    contentDigest: digest(content),
    source: { kind: 'ordinary', addedAt: now() },
    tokenEstimate: content.length,
    priority: 0.5,
    trust: 'untrusted',
    sensitivity: 'internal',
    dependencies: [],
    protectedHints: [],
    taskSubject: 'snapshot',
    dataPolicy: { externalEvaluation: 'allowed', localOnly: false, legalAction: 'none' },
    ...overrides,
  };
}

const basePolicy: ContextPruningPolicy = {
  mode: 'shadow',
  minimumConfidenceBps: 8_000,
  minimumMarginBps: 1_000,
  allowedDestructiveActions: ['drop'],
  calibrationDigest: `sha256:${'c'.repeat(64)}`,
  modelIdentityDigest: `sha256:${'d'.repeat(64)}`,
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

/** The real selection path: feed the downstream item list, in order, to ContextBudgetManager and serialize its output. */
function contextBudgetSelectionBytes(ids: readonly string[], candidates: readonly ContextPruningCandidate[]): Buffer {
  const byId = new Map(candidates.map(candidate => [candidate.itemId, candidate]));
  const manager = new ContextBudgetManager('/nonexistent-aiwg-fixture', budget);
  for (const id of ids) {
    const candidate = byId.get(id)!;
    manager.addItem(candidate.itemId, candidate.content!, candidate.source.kind === 'system' ? 'system' : 'auto', candidate.priority);
  }
  const degraded = manager.degrade();
  return Buffer.from(canonicalJson({ status: manager.getStatus(), kept: degraded.kept, dropped: degraded.dropped, items: manager.getItems() }));
}

describe('D26 shadow context snapshot against ContextBudgetManager', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(now())); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps the ContextBudgetManager selection byte-identical when disabled and in shadow mode', () => {
    const candidates = deepFreeze([
      item('rules', 'system and project instructions remain in the actual context', { source: { kind: 'system', addedAt: now() } }),
      item('distractor', 'ordinary retrieved note that shadow evidence would drop '.repeat(4), { priority: 0.05 }),
      item('relevant', 'ordinary retrieved note that is on topic', { priority: 0.9 }),
    ]);
    const candidateBytes = canonicalJson(candidates);
    const baseline = contextBudgetSelectionBytes(candidates.map(candidate => candidate.itemId), candidates);
    const dropEverything = candidates.map(candidate => ({
      itemId: candidate.itemId,
      subject: `context-item:${candidate.itemId}`,
      status: 'success' as const,
      proposedAction: 'drop' as const,
      confidenceBps: 9_900,
      marginBps: 9_000,
      calibrated: true,
      calibrationDigest: basePolicy.calibrationDigest!,
      modelIdentityDigest: basePolicy.modelIdentityDigest!,
      decisionReceiptDigest: digest(`receipt-${candidate.itemId}`),
    }));
    const disabled = applyContextPruningPilot({ candidates, policy: { ...basePolicy, mode: 'disabled' }, now, budget });
    const shadow = applyContextPruningPilot({ candidates, policy: basePolicy, now, budget, evidence: dropEverything });
    const advisory = applyContextPruningPilot({ candidates, policy: { ...basePolicy, mode: 'advisory' }, now, budget, evidence: dropEverything });

    // The shadow run really proposed drops, and ContextBudgetManager (run inside the pilot) dropped the distractor.
    expect(shadow.receipts.filter(receipt => receipt.proposedAction === 'drop').map(receipt => receipt.itemId))
      .toEqual(['distractor', 'relevant']);
    expect(shadow.deterministicBaseline?.droppedItemIds).toEqual(['distractor']);
    for (const run of [disabled, shadow, advisory]) {
      expect(run.receipts.every(receipt => receipt.appliedAction === 'keep')).toBe(true);
      expect(contextBudgetSelectionBytes(run.downstreamItemIds, candidates).equals(baseline)).toBe(true);
    }
    // The pilot neither mutated the frozen candidates nor altered their serialized bytes.
    expect(canonicalJson(candidates)).toBe(candidateBytes);
  });

  it('has no AIWG module other than the pilot consuming ContextBudgetManager (no real prompt builder to snapshot)', () => {
    const root = join(__dirname, '..', '..');
    const consumers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|mts|js|mjs)$/.test(name) && /metrics\/context-budget(\.js)?['"]/.test(readFileSync(path, 'utf8'))) {
          consumers.push(relative(root, path));
        }
      }
    };
    for (const dir of ['src', 'tools']) walk(join(root, dir));
    expect(consumers.sort()).toEqual(['src/decision/context-pruning.ts']);
  });
});
