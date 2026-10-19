import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KnowledgeStore } from '../../../src/agents/grounding/knowledge-base.js';
import { labelledClaims } from '../../fixtures/grounding/labelled-claims.js';

describe('KnowledgeStore.verifyClaim', () => {
  let root: string;
  let store: KnowledgeStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aiwg-grounding-'));
    vi.stubEnv('AIWG_ARTIFACTS_PATH', path.join(root, 'artifacts'));
    store = new KnowledgeStore(root);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function load(contents: string[], domain = 'technology'): Promise<void> {
    const directory = path.join(root, 'artifacts', 'knowledge', domain);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'entries.json'), JSON.stringify({
      entries: contents.map((content, index) => ({
        id: `entry-${index}`, topic: 'Transport security', content,
        source: `manual#entry-${index}`, keywords: ['TLS', 'transport', 'encrypted'],
      })),
    }));
    await store.load();
  }

  it('rejects a relevant contradicting fragment and returns its correction (#3313)', async () => {
    await load(['TLS transport is not encrypted.']);
    const claim = 'TLS transport is encrypted.';
    expect(store.search(claim)[0].relevance_score).toBeGreaterThan(0.3);

    const result = store.verifyClaim(claim);
    expect(result.verified).toBe(false);
    expect(result.correction).toContain('TLS transport is not encrypted.');
    expect(result.sources).toEqual(['technology/manual#entry-0']);
    expect(result.evidence).toEqual([{
      source: 'technology/manual#entry-0', entry_id: 'entry-0',
      content: 'TLS transport is not encrypted.', relation: 'contradicts',
    }]);
  });

  it('verifies an explicitly supporting fragment', async () => {
    await load(['TLS transport is encrypted.']);
    expect(store.verifyClaim('TLS transport is encrypted.')).toMatchObject({
      verified: true, sources: ['technology/manual#entry-0'],
    });
  });

  it('does not verify an irrelevant fragment', async () => {
    await load(['Bananas grow in tropical regions.']);
    expect(store.verifyClaim('Saturn has rings.')).toMatchObject({
      verified: false, confidence: 0, sources: [],
    });
  });

  it('does not treat matching topics or keywords as supporting evidence', async () => {
    await load(['The manual discusses transport configuration.']);
    expect(store.search('TLS transport is encrypted.')[0].relevance_score).toBeGreaterThan(0.3);
    expect(store.verifyClaim('TLS transport is encrypted.')).toMatchObject({
      verified: false, confidence: 0,
    });
  });

  it('rejects conflicting evidence even when supporting evidence ranks first', async () => {
    await load(['TLS transport is encrypted.', 'TLS transport is not encrypted.']);
    const result = store.verifyClaim('TLS transport is encrypted.');
    expect(result.verified).toBe(false);
    expect(result.correction).toContain('TLS transport is not encrypted.');
  });

  it('checks a negated claim against affirmative evidence', async () => {
    await load(['TLS transport is encrypted.']);
    const result = store.verifyClaim('TLS transport is not encrypted.');
    expect(result.verified).toBe(false);
    expect(result.correction).toContain('TLS transport is encrypted.');
  });

  it('keeps verification scoped to the requested domain', async () => {
    await load(['TLS transport is encrypted.']);
    await load(['TLS transport is not encrypted.'], 'security');
    expect(store.verifyClaim('TLS transport is encrypted.', 'technology').verified).toBe(true);
    expect(store.verifyClaim('TLS transport is encrypted.', 'security').verified).toBe(false);
  });

  it('does not verify an empty claim', async () => {
    await load(['TLS transport is encrypted.']);
    expect(store.verifyClaim('')).toMatchObject({ verified: false, confidence: 0 });
  });

  it.each([
    'TLS transport is encrypted?',
    'TLS transport is encrypted. That statement is false.',
    '"TLS transport is encrypted"',
  ])('abstains on non-assertion or compound text: %s', async (claim) => {
    await load([claim]);
    expect(store.verifyClaim(claim).verified).toBe(false);
  });

  it('measures support and contradiction precision/recall on 24 labelled pairs', async () => {
    const counts = {
      supports: { tp: 0, fp: 0, fn: 0 },
      contradicts: { tp: 0, fp: 0, fn: 0 },
    };
    for (const [index, pair] of labelledClaims.entries()) {
      // Exercise real loading and retrieval, with each pair isolated by domain.
      const domain = `pair-${index}`;
      await load([pair.content], domain);
      const result = store.verifyClaim(pair.claim, domain);
      for (const relation of ['supports', 'contradicts'] as const) {
        const predicted = relation === 'supports'
          ? result.verified
          : result.evidence?.some((item) => item.relation === relation) ?? false;
        const expected = pair.label === relation;
        if (predicted && expected) counts[relation].tp++;
        if (predicted && !expected) counts[relation].fp++;
        if (!predicted && expected) counts[relation].fn++;
      }
    }
    expect(counts).toEqual({
      supports: { tp: 6, fp: 0, fn: 3 },
      contradicts: { tp: 6, fp: 0, fn: 2 },
    });
    for (const [relation, { tp, fp, fn }] of Object.entries(counts)) {
      const precision = tp / (tp + fp);
      const recall = tp / (tp + fn);
      console.info(`labelled grounding ${relation}: n=${labelledClaims.length}, TP=${tp}, FP=${fp}, FN=${fn}, precision=${precision}, recall=${recall}`);
      expect(precision).toBe(1);
      expect(recall).toBe(relation === 'supports' ? 2 / 3 : 0.75);
    }
  });
});
