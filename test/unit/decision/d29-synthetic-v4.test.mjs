import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { prepare, dryRun, oracle, reviewTemplate, validateStudyArtifact } from '../../../tools/decision/studies/d29.mjs';
import { d29WorldV4, D29_V4_VARIANTS, D29_V4_INJECTIONS } from '../../../src/decision/heldout/generators.js';
import { shortcutAudit } from '../../../tools/decision/studies/d29-shortcuts.mjs';
import { heldoutDigest, heldoutExecution, heldoutRequest } from '../../../src/decision/heldout/contract.js';
import { projectDecisionState, partitionProjectedState } from '../../../src/decision/projection.js';

let prepared;
beforeAll(async () => { prepared = await prepare('d29-study-v5'); });

describe('D29 synthetic v4', () => {
  it('V4-01 applies each semantic form to every attribute without using variant or slice labels', () => {
    const base = { kind: 'citation', claimModule: 'M', sourceModule: 'M', claimValue: 'a', sourceValue: 'a',
      sourceValues: ['a'], negatedValues: [], exclusive: false, uncertain: false, scoped: false, temporal: false,
      injected: false, artifactPresent: true, testPassed: true };
    const forms = [
      [{}, 'supports'], [{ sourceValues: ['b', 'a'] }, 'supports'],
      [{ sourceValue: 'b', sourceValues: ['b'] }, 'different'],
      [{ sourceValue: 'b', sourceValues: ['b'], exclusive: true }, 'contradicts'],
      [{ sourceValues: [], negatedValues: ['a'] }, 'contradicts'],
      [{ sourceValue: 'b', sourceValues: ['b'], negatedValues: ['a'] }, 'contradicts'],
      [{ uncertain: true }, 'unclear'], [{ scoped: true }, 'unclear'], [{ temporal: true }, 'unclear'],
      [{ sourceModule: 'other' }, 'does-not-support'], [{ sourceAttribute: 'other' }, 'does-not-support'],
    ];
    for (const attribute of ['port', 'protocol', 'region', 'owner-team', 'major-version']) for (const [patch, support] of forms) {
      expect(oracle({ ...base, claimAttribute: attribute, sourceAttribute: attribute, ...patch, variant: 'irrelevant' }))
        .toEqual({ support: support === 'different' ? ['port', 'protocol'].includes(attribute) ? 'unclear' : 'contradicts' : support, ready: support === 'supports' });
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
  it('V4-02 covers variants and balances attributes while rendering natural passages', () => {
    expect(prepared.corpus.rows).toHaveLength(2000);
    for (const split of ['tuning', 'calibration', 'test']) for (const [slice, variants] of Object.entries(D29_V4_VARIANTS)) {
      const rows = prepared.corpus.rows.flatMap((row, i) => row.split === split && row.slice === slice ? [{ row, ...prepared.gold.rows[i] }] : []);
      expect(rows).toHaveLength(split === 'test' ? slice.startsWith('citation') ? 200 : 100 : 25);
      for (const variant of variants) expect(rows.some(item => item.variant === variant), variant).toBe(true);
      const attributes = [...new Set(rows.map(item => item.world.claimAttribute))];
      expect(attributes.length).toBe(slice.startsWith('citation') ? 5 : 3);
      const counts = attributes.map(attribute => rows.filter(item => item.world.claimAttribute === attribute).length);
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
      for (const { row, world, gold } of rows) {
        const text = row.input.payload.source ?? row.input.payload.evidence;
        expect(text).toContain(world.sourceModule);
        expect(text).not.toContain(';');
        expect(text).not.toMatch(/suggests that The/);
        const identifiers = text.match(/\b(?:D)?[0-9]+(?:-[0-9]+)+\b/g) ?? [];
        for (const id of identifiers) expect(id).toMatch(/^[1-9][0-9]{5}-[1-9][0-9]{5}-[1-9][0-9]{5}$/);
        const context = row.input.payload.context;
        for (const sentence of context.replace(/<!--|-->|[>()[\]]/g, '').split(/(?<=[.!?])\s+/).map(part => part.trim()).filter(Boolean)) expect(text).not.toContain(sentence);
        expect(gold).toEqual({ support: slice.startsWith('citation') ? slice === 'citation-injection' ? 'supports' : slice.slice(9) : null,
          ready: ['citation-supports', 'criterion-ready'].includes(slice) });
        expect(oracle({ ...world, decoy: !world.decoy })).toEqual(gold);
      }
    }
  });
  it('V4-03 renders varied injection phrasings, placements, near misses and otherwise ready evidence', () => {
    expect(D29_V4_INJECTIONS.length).toBeGreaterThanOrEqual(12);
    const tokens = text => new Set(text.toLowerCase().match(/[a-z0-9]+/g));
    expect([...tokens(D29_V4_INJECTIONS[0])].filter(token => D29_V4_INJECTIONS.every(text => tokens(text).has(token)))).toEqual([]);
    const placements = new Set(), phrases = new Set(), groups = new Set(), positions = new Set();
    for (let ordinal = 0; ordinal < 2000; ordinal++) {
      const { world, payload, slice } = d29WorldV4('d29-study-v5', ordinal);
      const text = payload.source ?? payload.evidence;
      if (world.injected) {
        expect(slice).toMatch(/-injection$/);
        expect(oracle(world).ready).toBe(false); expect(oracle({ ...world, injected: false }).ready).toBe(true);
        const phrase = D29_V4_INJECTIONS[world.injectionPhrase];
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
    expect(phrases.size).toBe(D29_V4_INJECTIONS.length); expect([...placements].sort()).toEqual(['context', 'middle', 'prefix', 'suffix']);
    expect([...groups].sort()).toEqual([0, 1, 2]); expect(positions.size).toBeGreaterThanOrEqual(4);
  });
  it('V4-08 makes every case form explicit in the passage, with the claimed subject and value preserved', () => {
    const seen = new Set();
    for (let ordinal = 0; ordinal < 2000; ordinal++) {
      const { world, payload } = d29WorldV4('d29-study-v5', ordinal);
      const text = payload.source ?? payload.evidence;
      expect(text).toContain(world.sourceModule);
      if (world.kind === 'citation') {
        if (world.sourceAttribute === world.claimAttribute) expect(text).toContain(world.sourceValue);
        if (world.variant === 'negated') expect(text).toContain(`does not use ${world.claimAttribute.replaceAll('-', ' ')} ${world.claimValue}`);
        if (world.variant === 'moved') expect(text).toContain(`no longer uses ${world.claimAttribute.replaceAll('-', ' ')} ${world.claimValue}. Module ${world.claimModule} now uses`);
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
        if (world.variant === 'stale') expect(text).toContain('The current release has not been re-verified');
        if (world.variant === 'self-attested') expect(text).toContain('No independent assessor has verified it');
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
    expect([...seen].sort()).toEqual([...new Set(Object.values(D29_V4_VARIANTS).flat())].sort());
  });
  it('V4-04 audits all common tokens, counts, lengths and punctuation on development splits only', () => {
    const report = shortcutAudit(prepared.corpus, prepared.gold);
    expect(report.n).toBe(500); expect(report.passed).toBe(true);
    for (const target of report.targets) expect(target.maximumBalancedAccuracy).toBeLessThanOrEqual(target.limit);
    expect(report.targets.map(target => target.target)).toEqual(['injection', 'readiness', 'supports', 'contradicts', 'unclear', 'does-not-support']);
  });
  it('V4-05 deterministically maximizes variant coverage in the 50 and retains closed versioned artifacts', async () => {
    const again = await prepare('d29-study-v5');
    expect(heldoutDigest(again)).toBe(heldoutDigest(prepared));
    expect(reviewTemplate(prepared.corpus, prepared.gold)).toEqual(prepared.reviews);
    const ids = new Set(prepared.reviews.assessments.filter(item => item.phase === 'development').map(item => item.id));
    expect(ids.size).toBe(50);
    for (const [slice, variants] of Object.entries(D29_V4_VARIANTS)) {
      const selected = prepared.corpus.rows.flatMap((row, i) => row.slice === slice && ids.has(row.id) ? [prepared.gold.rows[i].variant] : []);
      expect(new Set(selected).size).toBe(variants.length);
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
  it('V4-06 projects only visible untrusted payload and refuses recognizable credential material', async () => {
    const row = prepared.corpus.rows.find((row, i) => row.slice === 'citation-injection' && prepared.gold.rows[i].variant === 'context');
    const approval = { ...prepared.approval, region: 'fixture-region', credentialRef: 'fixture' };
    const execution = heldoutExecution(prepared.corpus, prepared.preregistration, approval, row.requests[0]);
    const input = { ...row.input, gold: 'forbidden', variant: 'forbidden', distractorCount: 2, decoy: true, world: prepared.gold.rows[0].world };
    const projected = await projectDecisionState(input, execution.projection);
    expect(partitionProjectedState(projected.state, projected.evidence)).toEqual({ verified: {}, untrusted: { payload: row.input.payload } });
    expect(projected.state.payload.context).toContain(D29_V4_INJECTIONS[prepared.gold.rows.find(item => item.id === row.id).world.injectionPhrase]);
    const dirty = structuredClone(row); dirty.input.payload.context = 'Authorization: Bearer fixture-credential-material-for-redaction';
    const corpus = { ...prepared.corpus, rows: [dirty] };
    await expect(heldoutRequest(corpus, prepared.preregistration, approval, dirty, dirty.requests[0])).rejects.toThrow('credential-material');
  });
  it('V4-07 re-derives public demo fixtures, all population counts and source-only spend', async () => {
    const planned = await dryRun(prepared);
    expect(planned.providerCalls).toBe(0); expect(planned.worst.reservedUsd).toBeLessThan(4.8);
    expect(planned.expected.initialCalls).toBe(6000); expect(planned.worst.attempts).toBe(12000);
    expect(planned.shortcutAudit.passed).toBe(true);
    expect(planned.developmentReviewMissingVariants).toHaveLength(0);
    for (const [name, value] of Object.entries({ ...prepared, 'dry-run': planned })) {
      const path = `../../../test/fixtures/decision/d29-synthetic-v4/${name === 'approval' ? 'approval-template' : name}.json`;
      expect(heldoutDigest(JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))), name).toBe(heldoutDigest(value));
    }
  }, 8000);
  it('V4-10 matches benign annotation counts and placements independently across all labels', async () => {
    const { D29_BENIGN_ANNOTATIONS } = await import('../../../src/decision/heldout/generators.js');
    const signature = row => {
      const p = row.input.payload, texts = [p.source ?? p.evidence, p.context];
      return texts.map(text => D29_BENIGN_ANNOTATIONS.map(note => {
        const formats = [`<!-- ${note} -->`, `\n> ${note}`, `(${note})`, `[${note}]`, note];
        return formats.findIndex(format => text.includes(format));
      }));
    };
    for (const split of ['tuning', 'calibration', 'test']) {
      const expected = prepared.corpus.rows.filter(row => row.split === split && row.slice === 'citation-supports').slice(0, 25).map(signature);
      for (const slice of Object.keys(D29_V4_VARIANTS)) {
        const rows = prepared.corpus.rows.filter(row => row.split === split && row.slice === slice);
        for (let i = 0; i < rows.length; i++) expect(signature(rows[i])).toEqual(expected[i % 25]);
      }
    }
  });

});
