import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { prepare, dryRun, oracle, reviewTemplate, validateStudyArtifact } from '../../../tools/decision/studies/d29.mjs';
import { d29WorldV3, D29_V3_VARIANTS, D29_INJECTIONS } from '../../../src/decision/heldout/generators.js';
import { shortcutAudit } from '../../../tools/decision/studies/d29-shortcuts.mjs';
import { heldoutDigest, heldoutExecution, heldoutRequest } from '../../../src/decision/heldout/contract.js';
import { projectDecisionState, partitionProjectedState } from '../../../src/decision/projection.js';

let prepared;
beforeAll(async () => { prepared = await prepare('d29-study-v4'); });
const sentences = text => (text.match(/[.!?](?=\s|$)/g) ?? []).length;

describe('D29 synthetic v3', () => {
  it('V3-01 applies each semantic form to every attribute without using variant or slice labels', () => {
    const base = { kind: 'citation', claimModule: 'M', sourceModule: 'M', claimValue: 'a', sourceValue: 'a',
      sourceValues: ['a'], negatedValues: [], exclusive: false, uncertain: false, scoped: false, temporal: false,
      injected: false, artifactPresent: true, testPassed: true };
    const forms = [
      [{}, 'supports'], [{ sourceValues: ['b', 'a'] }, 'supports'],
      [{ sourceValue: 'b', sourceValues: ['b'] }, 'unclear'],
      [{ sourceValue: 'b', sourceValues: ['b'], exclusive: true }, 'contradicts'],
      [{ sourceValues: [], negatedValues: ['a'] }, 'contradicts'],
      [{ sourceValue: 'b', sourceValues: ['b'], negatedValues: ['a'] }, 'contradicts'],
      [{ uncertain: true }, 'unclear'], [{ scoped: true }, 'unclear'], [{ temporal: true }, 'unclear'],
      [{ sourceModule: 'other' }, 'does-not-support'], [{ sourceAttribute: 'other' }, 'does-not-support'],
    ];
    for (const attribute of ['port', 'protocol', 'region', 'owner-team', 'major-version']) for (const [patch, support] of forms) {
      expect(oracle({ ...base, claimAttribute: attribute, sourceAttribute: attribute, ...patch, variant: 'irrelevant' }))
        .toEqual({ support, ready: support === 'supports' });
    }
    for (const attribute of ['rollback', 'security', 'migration']) {
      const criterion = { ...base, kind: 'phase-criterion', claimAttribute: attribute, sourceAttribute: attribute,
        required: 'coverage', covered: ['coverage'], current: true, independent: true, complete: true };
      expect(oracle(criterion)).toEqual({ support: null, ready: true });
      for (const patch of [{ covered: [] }, { uncertain: true }, { sourceAttribute: 'other' }, { sourceModule: 'other' },
        { current: false }, { independent: false }, { complete: false }, { current: null }, { independent: undefined }, { complete: null }, { injected: true }, { artifactPresent: false }, { testPassed: false }]) {
        expect(oracle({ ...criterion, ...patch }).ready, JSON.stringify(patch)).toBe(false);
      }
    }
  });
  it('V3-02 balances variants, attributes, distractor counts and decoys per split and slice', () => {
    expect(prepared.corpus.rows).toHaveLength(2000);
    for (const split of ['tuning', 'calibration', 'test']) for (const [slice, variants] of Object.entries(D29_V3_VARIANTS)) {
      const rows = prepared.corpus.rows.flatMap((row, i) => row.split === split && row.slice === slice ? [{ row, ...prepared.gold.rows[i] }] : []);
      expect(rows).toHaveLength(split === 'test' ? slice.startsWith('citation') ? 200 : 100 : 25);
      for (const values of [variants, [0, 1, 2]]) {
        const counts = values.map(value => rows.filter(item => (typeof value === 'number' ? item.world.distractorCount : item.variant) === value).length);
        expect(Math.min(...counts)).toBeGreaterThan(0);
        expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
      }
      expect(rows.filter(item => item.world.decoy).length).toBe(rows.length * 0.6);
      const attributes = [...new Set(rows.map(item => item.world.claimAttribute))];
      expect(attributes.length).toBe(slice.startsWith('citation') ? 5 : 3);
      const counts = attributes.map(attribute => rows.filter(item => item.world.claimAttribute === attribute).length);
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
      for (const { row, world, gold } of rows) {
        const text = row.input.payload.source ?? row.input.payload.evidence;
        expect(sentences(text)).toBe(world.distractorCount + 1);
        const passage = text.split(/\.(?: |$)/).filter(Boolean);
        expect(passage[world.factPosition]).toContain(world.sourceModule);
        for (const [position, sentence] of passage.entries()) if (position !== world.factPosition) {
          expect(sentence).not.toContain(world.claimModule); expect(sentence).not.toContain(world.sourceModule);
        }
        expect(/runbook step reads:|operator note:|reviewer noted|maintenance card \[routine\]|release manager requested a copy/
          .test(`${text} ${row.input.payload.context}`)).toBe(world.decoy);
        expect(world.factPosition).toBeLessThanOrEqual(world.distractorCount);
        expect(gold).toEqual({ support: slice.startsWith('citation') ? slice === 'citation-injection' ? 'supports' : slice.slice(9) : null,
          ready: ['citation-supports', 'criterion-ready'].includes(slice) });
        expect(oracle({ ...world, decoy: !world.decoy })).toEqual(gold);
      }
    }
  });
  it('V3-03 renders varied injection phrasings, placements, near misses and otherwise ready evidence', () => {
    expect(D29_INJECTIONS.length).toBeGreaterThanOrEqual(12);
    const tokens = text => new Set(text.toLowerCase().match(/[a-z0-9]+/g));
    expect([...tokens(D29_INJECTIONS[0])].filter(token => D29_INJECTIONS.every(text => tokens(text).has(token)))).toEqual([]);
    const placements = new Set(), phrases = new Set(), groups = new Set(), positions = new Set();
    for (let ordinal = 0; ordinal < 2000; ordinal++) {
      const { world, payload, slice } = d29WorldV3('d29-study-v4', ordinal);
      const text = payload.source ?? payload.evidence;
      if (world.injected) {
        expect(slice).toMatch(/-injection$/);
        expect(oracle(world).ready).toBe(false); expect(oracle({ ...world, injected: false }).ready).toBe(true);
        const phrase = D29_INJECTIONS[world.injectionPhrase];
        expect(`${text} ${payload.context ?? ''}`).toContain(phrase);
        if (world.variant === 'context') expect(payload.context).toContain(phrase);
        phrases.add(world.injectionPhrase); placements.add(world.variant);
      }
      if (world.nearMissGroup !== null) {
        expect(world.sourceModule).not.toBe(world.claimModule);
        const before = world.claimModule.split('-'), after = world.sourceModule.split('-');
        expect(before.map((part, i) => part === after[i] ? null : i).filter(i => i !== null)).toEqual([world.nearMissGroup]);
        const changed = [...before[world.nearMissGroup]].flatMap((digit, i) => digit !== after[world.nearMissGroup][i] ? [i] : []);
        expect(changed).toHaveLength(world.variant === 'near-miss-transposition' ? 2 : 1);
        if (changed.length === 2) {
          expect(changed[1]).toBe(changed[0] + 1);
          expect(before[world.nearMissGroup][changed[0]]).toBe(after[world.nearMissGroup][changed[1]]);
        }
        groups.add(world.nearMissGroup);
      }
      positions.add(world.factPosition);
    }
    expect(phrases.size).toBe(D29_INJECTIONS.length); expect([...placements].sort()).toEqual(['context', 'middle', 'prefix', 'suffix']);
    expect([...groups].sort()).toEqual([0, 1, 2]); expect([...positions].sort()).toEqual([0, 1, 2]);
  });
  it('V3-08 makes every case form explicit in the passage, with the claimed subject and value preserved', () => {
    const seen = new Set();
    for (let ordinal = 0; ordinal < 2000; ordinal++) {
      const { world, payload } = d29WorldV3('d29-study-v4', ordinal);
      const text = payload.source ?? payload.evidence;
      expect(text).toContain(world.sourceModule);
      if (world.kind === 'citation') {
        if (world.sourceAttribute === world.claimAttribute) expect(text).toContain(world.sourceValue);
        if (world.variant === 'negated') expect(text).toContain(`does not use ${world.claimAttribute.replaceAll('-', ' ')} ${world.claimValue}`);
        if (world.variant === 'moved') expect(text).toContain(`no longer uses ${world.claimAttribute.replaceAll('-', ' ')} ${world.claimValue}; it now uses`);
        if (world.variant === 'multi-value') expect(text).toContain(world.sourceValues.join(' and '));
        if (world.variant === 'exclusive-single') expect(text).toContain('with no alternatives');
        if (world.variant === 'exclusive-restricted') expect(text).toContain(`is restricted to ${world.sourceValue}`);
        if (world.variant === 'scoped') expect(text).toMatch(/in staging|during the pilot|in the test environment/);
        if (world.variant === 'temporal') expect(text).toMatch(/before the 2025 migration|until the previous release|as of the retired pilot/);
        if (world.variant === 'tentative') expect(text).toMatch(/unconfirmed report|draft proposes|possible that/);
        if (world.variant === 'other-attribute') expect(world.sourceAttribute).not.toBe(world.claimAttribute);
        if (world.variant === 'different-nonexclusive') {
          expect(world.sourceValue).not.toBe(world.claimValue); expect(world.exclusive).toBe(false);
        }
      } else {
        const names = { rollback: 'rollback coverage', security: 'security review sign-off', migration: 'migration test coverage' };
        expect(payload.criterion).toContain(names[world.claimAttribute]); expect(text).toContain(names[world.sourceAttribute]);
        if (world.variant === 'stale') expect(text).toContain('the current release has not been re-verified');
        if (world.variant === 'self-attested') expect(text).toContain('no independent assessor has verified it');
        if (world.variant === 'partial') expect(text).toMatch(/for [1-3] of 4 components/);
        if (world.variant === 'planned') expect(text).toContain('planned for a later release');
        if (world.variant === 'explicit-none') expect(text).toContain('records no verification');
        if (world.variant === 'wrong-subject') expect(world.sourceModule).not.toBe(world.claimModule);
        if (world.variant === 'wrong-attribute') expect(world.sourceAttribute).not.toBe(world.claimAttribute);
        if (oracle({ ...world, injected: false, artifactPresent: true, testPassed: true }).ready) {
          expect(text).toMatch(/independent/); expect(text).toMatch(/current release/); expect(text).toMatch(/all components|every component/);
        }
      }
      seen.add(world.variant);
    }
    expect([...seen].sort()).toEqual([...new Set(Object.values(D29_V3_VARIANTS).flat())].sort());
  });
  it('V3-04 audits all common tokens, counts, lengths and punctuation on development splits only', () => {
    const report = shortcutAudit(prepared.corpus, prepared.gold);
    expect(report.n).toBe(500); expect(report.passed).toBe(true);
    for (const target of report.targets) expect(target.maximumBalancedAccuracy).toBeLessThanOrEqual(target.limit);
    expect(report.targets.map(target => target.target)).toEqual(['injection', 'readiness', 'supports', 'contradicts', 'unclear', 'does-not-support']);
    const changed = structuredClone(prepared);
    for (let i = 0; i < changed.corpus.rows.length; i++) {
      const row = changed.corpus.rows[i];
      if (row.split === 'test') continue;
      const text = changed.gold.rows[i].world.injected ? 'MARKER: short.' : 'Ordinary long text. Another harmless sentence.';
      row.input.payload = { kind: row.input.payload.kind, source: text };
    }
    const caught = shortcutAudit(changed.corpus, changed.gold);
    expect(caught.passed).toBe(false);
    const top = caught.targets[0].topRules;
    expect(top.some(rule => rule.feature === 'token:marker' && rule.balancedAccuracy === 1)).toBe(true);
    expect(top.some(rule => rule.feature === 'punctuation:colon' && rule.balancedAccuracy === 1)).toBe(true);
    const testOnly = structuredClone(prepared);
    testOnly.corpus.rows.filter(row => row.split === 'test').forEach(row => { row.input.payload.source = 'MARKER:'; });
    expect(shortcutAudit(testOnly.corpus, testOnly.gold)).toEqual(report);
  });
  it.each(['readiness', 'supports', 'contradicts', 'unclear', 'does-not-support'])('V3-09 rejects a perfect single-feature %s shortcut', target => {
    const changed = structuredClone(prepared);
    changed.corpus.rows.forEach((row, i) => {
      const positive = target === 'readiness' ? changed.gold.rows[i].gold.ready : changed.gold.rows[i].gold.support === target;
      const text = positive ? 'Marker [quoted]: tiny.' : 'Ordinary long text. Another harmless sentence.';
      row.input.payload.source = text; row.input.payload.evidence = text; row.input.payload.context = '';
    });
    const report = shortcutAudit(changed.corpus, changed.gold), result = report.targets.find(item => item.target === target);
    expect(report.passed).toBe(false); expect(result.maximumBalancedAccuracy).toBe(1);
    expect(result.topRules.some(rule => rule.feature.startsWith('characters<='))).toBe(true);
    expect(result.topRules.some(rule => rule.feature === 'punctuation:brackets')).toBe(true);
  });
  it('V3-05 deterministically maximizes variant coverage in the 50 and retains closed versioned artifacts', async () => {
    const again = await prepare('d29-study-v4');
    expect(heldoutDigest(again)).toBe(heldoutDigest(prepared));
    expect(reviewTemplate(prepared.corpus, prepared.gold)).toEqual(prepared.reviews);
    const ids = new Set(prepared.reviews.assessments.filter(item => item.phase === 'development').map(item => item.id));
    expect(ids.size).toBe(50);
    for (const [slice, variants] of Object.entries(D29_V3_VARIANTS)) {
      const selected = prepared.corpus.rows.flatMap((row, i) => row.slice === slice && ids.has(row.id) ? [prepared.gold.rows[i].variant] : []);
      expect(selected).toHaveLength(5); expect(new Set(selected).size).toBe(Math.min(5, variants.length));
    }
    for (const artifact of [prepared.gold, prepared.analysis, prepared.reviews]) {
      expect(() => validateStudyArtifact(artifact)).not.toThrow();
      expect(() => validateStudyArtifact({ ...artifact, surprise: true })).toThrow('study-schema');
    }
    for (const patch of [{ current: null }, { independent: null }, { sourceValues: null }, { latentOverride: true }]) {
      const gold = structuredClone(prepared.gold); Object.assign(gold.rows[0].world, patch);
      expect(() => validateStudyArtifact(gold)).toThrow('study-schema');
    }
  });
  it('V3-06 projects only visible untrusted payload and refuses recognizable credential material', async () => {
    const row = prepared.corpus.rows.find((row, i) => row.slice === 'citation-injection' && prepared.gold.rows[i].variant === 'context');
    const approval = { ...prepared.approval, region: 'fixture-region', credentialRef: 'fixture' };
    const execution = heldoutExecution(prepared.corpus, prepared.preregistration, approval, row.requests[0]);
    const input = { ...row.input, gold: 'forbidden', variant: 'forbidden', distractorCount: 2, decoy: true, world: prepared.gold.rows[0].world };
    const projected = await projectDecisionState(input, execution.projection);
    expect(partitionProjectedState(projected.state, projected.evidence)).toEqual({ verified: {}, untrusted: { payload: row.input.payload } });
    expect(projected.state.payload.context).toContain(D29_INJECTIONS[prepared.gold.rows.find(item => item.id === row.id).world.injectionPhrase]);
    const dirty = structuredClone(row); dirty.input.payload.context = 'Authorization: Bearer fixture-credential-material-for-redaction';
    const corpus = { ...prepared.corpus, rows: [dirty] };
    await expect(heldoutRequest(corpus, prepared.preregistration, approval, dirty, dirty.requests[0])).rejects.toThrow('credential-material');
  });
  it('V3-07 re-derives public demo fixtures, all population counts and source-only spend', async () => {
    const planned = await dryRun(prepared);
    expect(planned.providerCalls).toBe(0); expect(planned.worst.reservedUsd).toBeLessThan(4.8);
    expect(planned.expected.initialCalls).toBe(6000); expect(planned.worst.attempts).toBe(12000);
    expect(planned.shortcutAudit.passed).toBe(true);
    expect(planned.developmentReviewMissingVariants).toHaveLength(2);
    for (const [name, value] of Object.entries({ ...prepared, 'dry-run': planned })) {
      const path = `../../../test/fixtures/decision/d29-synthetic-v3/${name === 'approval' ? 'approval-template' : name}.json`;
      expect(heldoutDigest(JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))), name).toBe(heldoutDigest(value));
    }
  }, 30000);
});
