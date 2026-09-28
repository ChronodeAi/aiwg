import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SaxesParser, type SaxesTag } from 'saxes';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DECISION_INTEROP_DMN_NAMESPACE as DMN,
  DECISION_INTEROP_PROFILE_VERSION as PROFILE,
  importDmnDecisionTable, exportDmnDecisionTable, evaluateDmnProfile, exportOpaDecisionLog,
  type DmnHitPolicy, type OpaInteropEnvelope,
} from '../../../src/decision/interop.js';
import { composeRuleset } from '../../../src/decision/compose.js';
import type { DecisionResult, RulesetResult } from '../../../src/decision/types.js';
import { DecisionReviewService, FileDecisionReviewStore, ReviewAccessError, type ReviewAuthorization, type ReviewScope } from '../../../src/decision/review/index.js';

const AIWG = 'https://aiwg.io/spec/decision-interop/v1';
const pin = { id: 'fixture', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` as const };
const depPin = { id: 'stored', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` as const };
const reviewDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(reviewDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const row = (id: string, order: number, condition = '"guest"', outcome = '"allow"') =>
  `<rule id="${id}" aiwg:order="${order}"><inputEntry><text>${condition}</text></inputEntry><outputEntry><text>${outcome}</text></outputEntry></rule>`;
function table(rows = row('r1', 1), hitPolicy: DmnHitPolicy = 'FIRST', aggregation?: string): string {
  return `<definitions xmlns="${DMN}" xmlns:aiwg="${AIWG}" id="definitions" name="Definition" namespace="https://example.test/profile">
    <decision id="decision" name="Decision"><decisionTable id="decision-table" hitPolicy="${hitPolicy}"${aggregation ? ` aggregation="${aggregation}"` : ''}>
      <input id="input-role"><inputExpression typeRef="string"><text>/role</text></inputExpression></input>
      <output id="output-outcome" name="outcome"/>${rows}
    </decisionTable></decision></definitions>`;
}
function storedResult(): RulesetResult {
  return {
    apiVersion: 'decision.aiwg.io/v1alpha2', kind: 'RulesetResult',
    metadata: { id: 'run', version: '1.0.0', description: 'stored result' },
    spec: { ruleset: pin, binding: pin, runId: 'run', invocationId: 'invocation', status: 'completed', reason: 'none',
      outcome: false, matchedRules: ['deny'], evaluations: {} },
  };
}
function envelope(): OpaInteropEnvelope {
  return { profileVersion: PROFILE, bundle: { name: 'authz', revision: 'rev-1', digest: pin.digest },
    decisionId: 'decision-1', policyPath: 'authz/allow', input: {}, result: false };
}
function reviewEvidence(): DecisionResult {
  return {
    apiVersion: 'decision.aiwg.io/v1alpha2', kind: 'DecisionResult',
    metadata: { id: 'evidence', version: '1.0.0', description: 'successful computation requiring review' },
    spec: { decision: pin, ruleset: pin, binding: pin, alias: 'stored', runId: 'run', invocationId: 'invocation',
      status: 'success', reason: 'none', value: 'guest', uncertainty: null,
      acceptance: { policyVersion: '1.0.0', uncertaintyProfile: 'fixture', disposition: 'review', matchedRule: null,
        reason: 'default', values: {} }, attempts: [] },
  };
}
function acceptedDependencyEvidence(alias = 'stored'): DecisionResult {
  return {
    apiVersion: 'decision.aiwg.io/v1alpha2', kind: 'DecisionResult',
    metadata: { id: 'dependency-evidence', version: '1.0.0', description: 'accepted dependency evidence' },
    spec: { decision: depPin, ruleset: pin, binding: pin, alias, runId: 'run', invocationId: 'invocation',
      status: 'success', reason: 'none', value: 'guest', uncertainty: null,
      acceptance: { policyVersion: '1.0.0', uncertaintyProfile: 'fixture', disposition: 'act', matchedRule: null,
        reason: 'accepted', values: {} }, attempts: [] },
  };
}

// Independent review cases: successful parsing must not weaken predicates or invent
// interoperability. This file deliberately does not mock the parser or composer.
describe('INTOP review regressions: hostile import and native equivalence', () => {
  it('preserves CDATA literal conditions instead of converting them to wildcards', () => {
    const mapping = importDmnDecisionTable(table(row('admin-only', 1, '<![CDATA["admin"]]>')));
    expect(evaluateDmnProfile(mapping, { role: 'guest' })).toMatchObject({ status: 'defaulted', matchedRules: [] });
    expect(evaluateDmnProfile(mapping, { role: 'admin' })).toMatchObject({ status: 'completed', outcome: 'allow' });
  });

  it.each([
    '<informationRequirement><requiredDecision href="#decision"/></informationRequirement>',
    '<totallyUnsupported semantic="deny"/>',
    '<businessKnowledgeModel id="hidden-logic" name="Hidden"/>',
  ])('rejects unmapped/cyclic decision children: %s', child => {
    expect(() => importDmnDecisionTable(table().replace('<decisionTable', `${child}<decisionTable`))).toThrow();
  });

  it('rejects an AIWG namespace document masquerading as DMN', () => {
    expect(() => importDmnDecisionTable(table().replace(`xmlns="${DMN}"`, `xmlns="${AIWG}"`))).toThrow();
  });

  it('rejects duplicate rule IDs before ANY can lose a conflicting outcome', () => {
    expect(() => importDmnDecisionTable(table(row('same', 1, '"guest"', '"allow"')
      + row('same', 2, '"guest"', '"deny"'), 'ANY'))).toThrow();
  });

  it.each([
    ['UNIQUE', undefined, '"allow"', '"deny"'],
    ['ANY', undefined, '"allow"', '"deny"'],
    ['ANY', undefined, '"same"', '"same"'],
    ['COLLECT', 'SUM', '1', '3'],
    ['COLLECT', 'COUNT', '1', '3'],
    ['COLLECT', 'MIN', '1', '3'],
    ['COLLECT', 'MAX', '1', '3'],
  ] as const)('preserves %s/%s semantics in the normalized native ruleset', (hit, aggregate, a, b) => {
    const mapping = importDmnDecisionTable(table(row('a', 1, '"guest"', a) + row('b', 2, '"guest"', b), hit, aggregate));
    const input = { role: 'guest' };
    const native = composeRuleset(mapping.spec.normalizedRuleset, input, {});
    const expected = hit === 'UNIQUE' || (hit === 'ANY' && a !== b)
      ? { status: 'error', reason: 'conflicting-outcomes', matchedRules: ['a', 'b'] }
      : { status: 'completed', reason: 'none', matchedRules: ['a', 'b'],
        outcome: hit === 'ANY' ? 'same' : ({ SUM: 4, COUNT: 2, MIN: 1, MAX: 3 } as const)[aggregate!] };
    expect(native).toEqual(expected);
    expect(evaluateDmnProfile(mapping, input)).toEqual(expected);
  });

  it.each(['FIRST', 'UNIQUE', 'ANY', 'RULE ORDER', 'COLLECT'] as const)('does not treat review evidence as accepted evidence for %s', hit => {
    const xml = table(row('allow', 1), hit)
      .replace('<decision id="decision" name="Decision"><decisionTable', '<decision id="stored" name="Stored evidence"/><decision id="decision" name="Decision"><informationRequirement><requiredDecision href="#stored"/></informationRequirement><decisionTable');
    const mapping = importDmnDecisionTable(xml, { externalDecisionPins: { stored: depPin } });
    expect(evaluateDmnProfile(mapping, { role: 'guest' }, { stored: reviewEvidence() })).toMatchObject({
      status: 'review', matchedRules: [],
    });
  });

  it('rejects required evidence whose stored alias does not match the required dependency alias', () => {
    const xml = table(row('allow', 1))
      .replace('<decision id="decision" name="Decision"><decisionTable', '<decision id="stored" name="Stored evidence"/><decision id="decision" name="Decision"><informationRequirement><requiredDecision href="#stored"/></informationRequirement><decisionTable');
    const mapping = importDmnDecisionTable(xml, { externalDecisionPins: { stored: depPin } });
    expect(evaluateDmnProfile(mapping, { role: 'guest' }, { stored: acceptedDependencyEvidence('wrongAlias') })).toMatchObject({
      status: 'review', reason: 'evaluation-failed', matchedRules: [],
    });
  });

  it('replays stored evidence without a model call but still denies unauthorized downstream action execution', async () => {
    const xml = table(row('allow', 1))
      .replace('<decision id="decision" name="Decision"><decisionTable', '<decision id="stored" name="Stored evidence"/><decision id="decision" name="Decision"><informationRequirement><requiredDecision href="#stored"/></informationRequirement><decisionTable');
    const mapping = importDmnDecisionTable(xml, { externalDecisionPins: { stored: depPin } });
    const modelCall = vi.fn();
    const replay = evaluateDmnProfile(mapping, { role: 'guest' }, { stored: acceptedDependencyEvidence('stored') });
    expect(replay).toMatchObject({ status: 'completed', outcome: 'allow', matchedRules: ['allow'] });
    expect(modelCall).not.toHaveBeenCalled();

    const dir = await mkdtemp(join(tmpdir(), 'interop-review-auth-')); reviewDirs.push(dir);
    const tenant = { tenantId: 'tenant-interop', projectId: 'project-interop' };
    const actor = (id: string, role: string): ReviewScope => ({ ...tenant, actor: { id, roles: [role], authorityContext: 'interop-review-auth/v1' } });
    const authorization: ReviewAuthorization = {
      authorize: (scope, operation) => operation === 'create' ? scope.actor.roles.includes('requester') : !scope.actor.roles.includes('requester'),
      eligible: scope => scope.actor.roles.includes('reviewer') || scope.actor.roles.includes('executor'),
      eligibleApproval: (_scope, _review, _proposal, decision) => decision.reviewer.roles.includes('reviewer'),
      authorizeAction: () => false,
    };
    const service = new DecisionReviewService(new FileDecisionReviewStore(dir, new Uint8Array(32).fill(6)), authorization, () => 1_000);
    await service.create(actor('requester', 'requester'), {
      reviewId: 'interop-replay-action', sourceReceipt: { id: 'ruleset-result', digest: pin.digest }, evidencePins: [depPin],
      policyPins: [pin], reasonCodes: ['interop-replay-allow'], riskTier: 'low', presentation: { outcome: replay.outcome },
      action: { kind: 'fixture-action', decision: replay.outcome }, rationale: 'replayed deterministic allow still needs action auth',
      expiresAtEpochMs: 10_000, continuationId: 'continuation', resumeToken: 'resume-token',
    });
    await service.decide(actor('reviewer', 'reviewer'), 'interop-replay-action', 'approve', 'approved for auth check');
    const executor = vi.fn(async () => ({ delivered: true }));
    await expect(service.resume(actor('executor', 'executor'), 'interop-replay-action', 'resume-token', executor))
      .rejects.toBeInstanceOf(ReviewAccessError);
    expect(executor).not.toHaveBeenCalled();
  });

  it('rejects archive or compressed-looking binary input as non-XML without fetching remote resources', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network must not be used'));
    const gzipMagicBytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]).toString('latin1');
    expect(() => importDmnDecisionTable(gzipMagicBytes)).toThrow(/parse|root|empty|namespace|unsupported|disallowed character/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('enforces the parse-time bound deterministically before producing a mapping', () => {
    const now = vi.spyOn(performance, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(25);
    expect(() => importDmnDecisionTable(table(), { bounds: { maxParseMs: 1 } })).toThrow(/parse exceeded 1ms/);
    expect(now).toHaveBeenCalled();
  });

  it('bounds CDATA text by the same byte limit as ordinary text', () => {
    expect(() => importDmnDecisionTable(table(row('r', 1, `<![CDATA["${'x'.repeat(200)}"]]>`)),
      { bounds: { maxTextBytes: 100 } })).toThrow();
  });

  it('does not copy sensitive source expressions into rejection messages', () => {
    let error: unknown;
    try { importDmnDecisionTable(table(row('r', 1, 'contains("SECRET_CANARY",role)'))); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('SECRET_CANARY');
  });

  it('does not claim signature verification from a bare trustedSource boolean', () => {
    const mapping = importDmnDecisionTable(table(), { trustedSource: true });
    expect(mapping.spec.source.signature.state).not.toBe('verified');
    expect(mapping.spec).toMatchObject({ dryRun: true, activation: 'requires-review-publish' });
  });
});

describe('INTOP review regressions: supported export and standards constraints', () => {
  it('uses globally unique XML IDs in exported DMN (required by official xs:ID)', () => {
    const exported = exportDmnDecisionTable(importDmnDecisionTable(table()));
    const ids: string[] = [];
    const parser = new SaxesParser({ xmlns: true });
    parser.on('opentag', (tag: SaxesTag) => {
      const attr = tag.attributes.id;
      if (attr) ids.push(typeof attr === 'string' ? attr : attr.value);
    });
    parser.write(exported).close();
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('round-trips a supported table whose only input conditions are dash', () => {
    const mapping = importDmnDecisionTable(table(row('unconditional', 1, '-')));
    const again = importDmnDecisionTable(exportDmnDecisionTable(mapping));
    expect(again.spec.normalizedRuleset.spec).toEqual(mapping.spec.normalizedRuleset.spec);
    expect(evaluateDmnProfile(again, { role: 'guest' })).toMatchObject({ status: 'completed', outcome: 'allow' });
  });

  it('evaluates and round-trips supported compound outputs', () => {
    const xml = table().replace('<output id="output-outcome" name="outcome"/>',
      '<output id="output-outcome" name="outcome"/><output id="output-second" name="second"/>')
      .replace('</rule>', '<outputEntry><text>"audit"</text></outputEntry></rule>');
    const mapping = importDmnDecisionTable(xml);
    expect(evaluateDmnProfile(mapping, { role: 'guest' })).toMatchObject({ status: 'completed', outcome: { outcome: 'allow', second: 'audit' } });
    const again = importDmnDecisionTable(exportDmnDecisionTable(mapping));
    expect(again.spec.normalizedRuleset.spec).toEqual(mapping.spec.normalizedRuleset.spec);
  });

  it('keeps independent normative XSD files pinned for offline external validation', () => {
    const root = 'test/fixtures/decision/interop-review/';
    const manifest = JSON.parse(readFileSync(`${root}schema-provenance.json`, 'utf8')) as {
      files: Array<{ name: string; source: string; sha256: string }>;
    };
    expect(manifest.files).toHaveLength(4);
    for (const file of manifest.files) {
      expect(file.source).toMatch(/^https:\/\/www\.omg\.org\/spec\/DMN\//);
      expect(createHash('sha256').update(readFileSync(root + file.name)).digest('hex')).toBe(file.sha256);
    }
    // Hash checks are not advertised as actual XSD validation. validate-dmn.py
    // performs the separate standards check when Python/lxml is available.
  });
});

describe('INTOP review regressions: sanitized and truthful OPA logs', () => {
  it('does not leak sensitive values merely because their object keys look harmless', () => {
    const data = envelope();
    data.input = { message: 'Bearer SECRET_CANARY', url: 'file:///home/private/LOCATOR_CANARY', email: 'PERSON_CANARY@example.test' };
    const serialized = JSON.stringify(exportOpaDecisionLog(storedResult(), data));
    for (const canary of ['SECRET_CANARY', 'LOCATOR_CANARY', 'PERSON_CANARY']) expect(serialized).not.toContain(canary);
  });

  it('does not leak a sensitive scalar input', () => {
    const data = envelope(); data.input = 'Bearer SCALAR_SECRET_CANARY';
    expect(JSON.stringify(exportOpaDecisionLog(storedResult(), data))).not.toContain('SCALAR_SECRET_CANARY');
  });

  it('does not export unapproved free-form input by default', () => {
    const data = envelope(); data.input = { notes: 'UNAPPROVED_NARRATIVE_CANARY' };
    expect(JSON.stringify(exportOpaDecisionLog(storedResult(), data))).not.toContain('UNAPPROVED_NARRATIVE_CANARY');
  });

  it('preserves an explicit null outcome instead of replacing it with status text', () => {
    const stored = storedResult(); stored.spec.status = 'defaulted'; stored.spec.reason = 'no-match'; stored.spec.outcome = null;
    const data = envelope(); data.result = null;
    expect(exportOpaDecisionLog(stored, data).result).toBeNull();
  });

  it('never attaches stored policy lineage to a contradictory permissive outcome', () => {
    const data = envelope(); data.result = true;
    // Either refusing a mismatched envelope or deriving from the authoritative
    // stored outcome is valid. Returning the contradictory outcome is not.
    let exported: ReturnType<typeof exportOpaDecisionLog> | undefined;
    let error: unknown;
    try { exported = exportOpaDecisionLog(storedResult(), data); } catch (caught) { error = caught; }
    if (error !== undefined) expect(error).toBeInstanceOf(Error);
    else expect(exported!.result).toBe(false);
  });

  it('applies control-plane override validation before exporting allowlisted OPA inputs', () => {
    const data = envelope();
    data.input = { provider: 'evil' };
    data.inputProjectionAllowlist = ['/provider'];
    expect(() => exportOpaDecisionLog(storedResult(), data)).toThrow(/control|provider/i);
  });

  it('serializes bundles as the OPA object keyed by bundle name', () => {
    const exported = exportOpaDecisionLog(storedResult(), envelope());
    expect(Array.isArray(exported.bundles)).toBe(false);
    expect(exported.bundles).toMatchObject({ authz: { revision: 'rev-1' } });
  });
});
