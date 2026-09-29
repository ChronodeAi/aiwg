// Round-2 review regressions for #2622. Each `F<n>` test reproduces the reviewer's probe for
// finding n; every one of them failed (ready/PROMOTE, a thrown TypeError, or a mislabelled
// decision) on the pre-fix head 5399da557.
import { describe, expect, it } from 'vitest';
import {
  SdlcScreeningValidationError, VERIFIED_QUALIFICATION_INTEGRITY_SOURCES, applySdlcScreeningToGateOutcome,
  artifactPin, buildSdlcScreeningReleaseReport, evaluateSdlcEvidenceScreening, evaluateSdlcScreeningPreregistration,
  qualificationIntegrityAllowlistProblems, sdlcScreeningDecisionArtifacts,
  type SdlcCitationSubject, type SdlcGateEvidencePolicy, type SdlcPhaseCriterionSubject,
  type SdlcScreeningRequest, type SdlcScreeningTrustContext,
} from '../../../src/decision/index.js';
import {
  CRITERION_OPTIONS, G2_REQUIRED, HELDOUT_NOW, MODEL, SUPPORT_OPTIONS, anchored, calibration, citationObservation,
  citationSubject, criterionItem, criterionObservation, criterionSubject, digest, gatePolicy, heldoutRecords, heldoutSamples,
  nativeDistribution, preregistration, request, trust, verifiedIntegrity,
} from './sdlc-screening-fixtures.js';

const withEvidence = (evidence: SdlcPhaseCriterionSubject['evidence']): SdlcPhaseCriterionSubject =>
  ({ ...criterionSubject(false), evidence });
const screenCriterion = (evidence: SdlcPhaseCriterionSubject['evidence'], context = trust(), overrides: Partial<SdlcScreeningRequest> = {}) =>
  evaluateSdlcEvidenceScreening(request(withEvidence(evidence), criterionObservation({}, evidence.map(item => item.id)), overrides), context);
const passing = () => G2_REQUIRED.map(id => criterionItem(id));
const policyTrust = (policy: SdlcGateEvidencePolicy, extra: Partial<SdlcScreeningTrustContext> = {}): SdlcScreeningTrustContext =>
  trust({ gatePolicyPin: artifactPin(policy), gatePolicies: [policy], ...extra });

describe('SDLC screening round-2 review regressions (#2622)', () => {
  it('control: a fully verified criterion bundle is the only advisory-ready baseline', () => {
    expect(screenCriterion(passing())?.route).toBe('ADVISORY_READY');
  });

  it('F1: rejects duplicate evidence IDs instead of letting a later passing version win (probe C)', () => {
    const receipt = screenCriterion([...passing().filter(item => item.id !== 'test:security'),
      criterionItem('test:security', { passed: false, version: '1' }), criterionItem('test:security', { passed: true, version: '2' })]);
    expect(receipt).toMatchObject({ route: 'FAIL', deterministic: { status: 'fail',
      findings: [{ reason: 'duplicate-evidence-id', id: 'test:security' }] } });
  });

  it('F2: inspects every bundle item, so extra failed or foreign evidence blocks ready (probes A, B)', () => {
    const extraFailed = screenCriterion([...passing(), criterionItem('artifact:extra', { passed: false })]);
    expect(extraFailed?.route).toBe('REVIEW');
    expect(extraFailed?.deterministic.findings).toContainEqual({ reason: 'artifact-missing', id: 'artifact:extra', status: 'review' });
    const extraExpired = screenCriterion([...passing(), criterionItem('artifact:extra', { expiresAtEpochMs: 500 })]);
    expect(extraExpired?.deterministic.findings).toContainEqual({ reason: 'evidence-expired', id: 'artifact:extra', status: 'review' });
    const foreign = screenCriterion([...passing(), criterionItem('artifact:g3')]);
    expect(foreign?.route).toBe('REVIEW');
    expect(foreign?.deterministic.findings).toContainEqual({ reason: 'foreign-evidence', id: 'artifact:g3', status: 'review' });
  });

  it('F3: the gate policy comes only from the host-pinned artifact; a caller cannot narrow it (probe E)', () => {
    const narrowed = gatePolicy(['artifact:threat-model']);
    const onlyArtifact = [criterionItem('artifact:threat-model')];
    // Inline request policy (the old attack surface) is an unsupported request field.
    const inline = evaluateSdlcEvidenceScreening({ ...request(withEvidence(onlyArtifact),
      criterionObservation({}, ['artifact:threat-model'])), gatePolicy: narrowed } as SdlcScreeningRequest, trust());
    expect(inline).toMatchObject({ route: 'FAIL', deterministic: { findings: [{ reason: 'invalid-request' }] } });
    // A request pin naming the narrowed policy does not match the trusted pin.
    expect(screenCriterion(onlyArtifact, trust(), { gatePolicyPin: artifactPin(narrowed) })).toMatchObject({
      route: 'REVIEW', deterministic: { findings: [{ reason: 'gate-policy-mismatch' }] } });
    // A tampered registry entry under the trusted pin fails assertArtifactPin.
    expect(screenCriterion(onlyArtifact, trust({ gatePolicies: [narrowed] }))).toMatchObject({
      route: 'REVIEW', deterministic: { findings: [{ reason: 'gate-policy-untrusted' }] } });
    expect(evaluateSdlcEvidenceScreening(request(withEvidence(onlyArtifact), criterionObservation({}, ['artifact:threat-model'])))).toMatchObject({
      route: 'REVIEW', deterministic: { findings: [{ reason: 'gate-policy-untrusted' }] }, gatePolicy: null });
    // With the trusted policy the omitted required evidence is reported.
    const trusted = screenCriterion(onlyArtifact);
    expect(trusted?.route).toBe('REVIEW');
    expect(trusted?.deterministic.findings.filter(item => item.reason === 'required-evidence-missing').map(item => item.id))
      .toEqual(G2_REQUIRED.filter(id => id !== 'artifact:threat-model'));
  });

  it('F4: malformed expiry and structurally broken requests produce receipts, never exceptions (probe D)', () => {
    for (const expiresAtEpochMs of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, '2000' as unknown as number]) {
      const receipt = screenCriterion(passing().map(item => item.id === 'approval:release' ? { ...item, expiresAtEpochMs } : item));
      expect(receipt, String(expiresAtEpochMs)).toMatchObject({ route: 'FAIL',
        deterministic: { findings: [{ reason: 'invalid-evidence', id: 'approval:release' }] } });
    }
    const broken: Array<[string, SdlcScreeningRequest, SdlcScreeningTrustContext | undefined]> = [
      ['missing requirementIds', request({ ...criterionSubject(false), requirementIds: undefined as never }, criterionObservation()), trust()],
      ['null evidence', request({ ...criterionSubject(false), evidence: null as never }, criterionObservation()), trust()],
      ['null citation evidence', request({ ...citationSubject(), evidence: [null] as never }, citationObservation()), trust()],
      ['null subject', request(null as never, criterionObservation()), trust()],
      ['null inventory', request(criterionSubject(false), criterionObservation(), { inventory: null as never }), trust()],
      ['empty inventory', request(criterionSubject(false), criterionObservation(), { inventory: {
        claimIds: [], requirementIds: [], sourceIds: [], locators: [], criterionIds: [], evidenceIds: [] } }), trust()],
      ['null evidenceSubjects', request(criterionSubject(false), criterionObservation()), (() => {
        const policy = gatePolicy();
        (policy.spec as { evidenceSubjects: unknown }).evidenceSubjects = null;
        return policyTrust(policy);
      })()],
      ['null observation', request(criterionSubject(false), undefined, { observation: null as never }), trust()],
      ['null trust policies', request(criterionSubject(false), criterionObservation()), { ...trust(), gatePolicies: [null as never] }],
    ];
    for (const [label, input, context] of broken) {
      let receipt: ReturnType<typeof evaluateSdlcEvidenceScreening> = null;
      expect(() => { receipt = evaluateSdlcEvidenceScreening(input, context); }, label).not.toThrow();
      expect(receipt, label).not.toBeNull();
      expect(receipt!.route, label).not.toBe('ADVISORY_READY');
      expect(receipt!.deterministic.status, label).not.toBe('pass');
    }
  });

  it('F5: held-out quality comes from per-sample records; caller-asserted precision cannot promote (probe J)', () => {
    const plan = preregistration();
    // Probe J asserted precisionBps 300 in a report. Reports are now computed, so an asserted field is rejected.
    const asserted = { ...heldoutRecords(), support: { n: 30, precisionBps: 9_500, recallBps: 9_500 } };
    expect(evaluateSdlcScreeningPreregistration(plan, anchored(plan), asserted as never, HELDOUT_NOW)).toMatchObject({
      decision: 'fail', reasons: expect.arrayContaining(['heldout-records-invalid']) });
    // A candidate whose support labels are mostly wrong gets low computed precision and cannot promote.
    const wrong = heldoutSamples().map((sample, index) => sample.kind === 'citation' && index % 4 !== 0
      ? { ...sample, candidate: { ...sample.candidate, support: 'supports' as const } } : sample);
    const result = evaluateSdlcScreeningPreregistration(plan, anchored(plan), heldoutRecords(wrong), HELDOUT_NOW);
    expect(result.heldout?.classes.support.precisionBps).toBe(2_500);
    const release = buildSdlcScreeningReleaseReport({ preregistration: plan, trustedPreregistrationDigest: anchored(plan),
      heldout: heldoutRecords(wrong), integrity: verifiedIntegrity(), nowEpochMs: HELDOUT_NOW });
    expect(release.decision).toBe('HOLD');
    expect(release.reasons).toContain('quality-not-non-inferior');
    // A regressed candidate (baseline right, candidate wrong) is recorded as paired evidence and held.
    const regressed = heldoutSamples().map((sample, index) => sample.kind === 'phase-criterion' && !sample.gold.ready && index % 3 === 0
      ? { ...sample, candidate: { ...sample.candidate, route: 'ADVISORY_READY' as const, readyProbability: 0.9 } } : sample);
    const regression = evaluateSdlcScreeningPreregistration(plan, anchored(plan), heldoutRecords(regressed), HELDOUT_NOW);
    expect(regression.heldout?.paired.baselineOnly).toBeGreaterThan(0);
    expect(regression.reasons).toEqual(expect.arrayContaining(['false-ready-bound-exceeded']));
    expect(regression.decision).toBe('fail');
  });

  it('F6: any injection answer other than a confident "no" routes to review', () => {
    const route = (injection: 'yes' | 'no' | 'unclear', confidenceBps: number) => evaluateSdlcEvidenceScreening(
      request(citationSubject(), citationObservation({ injection, confidenceBps })), trust());
    for (const confidenceBps of [0, 5_000, 7_999, 8_000, 10_000]) {
      expect(route('unclear', confidenceBps)?.route).toBe('REVIEW');
      expect(route('yes', confidenceBps)?.route).toBe('REVIEW');
    }
    // With an otherwise accepted support answer, the injection rule is what routes to review.
    expect(route('unclear', 10_000)).toMatchObject({ route: 'REVIEW', semantic: { reason: 'prompt-injection-flagged' } });
    expect(route('no', 7_999)?.route).toBe('REVIEW');
    expect(route('no', 8_000)?.route).toBe('ADVISORY_READY');
    // The published ruleset routes anything above P(injection) = 0.2 to review; "unclear" is encoded as 1.
    const rule = sdlcScreeningDecisionArtifacts().rulesets.find(item => item.metadata.id === 'sdlc-screening.citation')!
      .spec.rules.find(item => item.id === 'injection-review')!;
    expect(rule.when).toMatchObject({ op: 'gt', right: 0.2 });
  });

  it('F7: post-hoc, unanchored or slice-incomplete held-out evidence cannot promote (probes J2, J3)', () => {
    const plan = preregistration();
    const run = (records = heldoutRecords(), options: { plan?: typeof plan; trusted?: `sha256:${string}`; now?: number } = {}) =>
      evaluateSdlcScreeningPreregistration(options.plan ?? plan, options.trusted ?? anchored(options.plan ?? plan), records, options.now ?? HELDOUT_NOW);
    const { evaluatedAt: _omitted, ...noDate } = heldoutRecords();
    expect(run(noDate as never).reasons).toContain('heldout-evaluated-at-invalid');
    expect(run(heldoutRecords(undefined, 'not-a-date')).reasons).toContain('heldout-evaluated-at-invalid');
    expect(run(heldoutRecords(undefined, '2026-09-01T00:00:00.000Z')).reasons).toContain('heldout-not-after-preregistration');
    expect(run(heldoutRecords(undefined, '2026-12-01T00:00:00.000Z')).reasons).toContain('heldout-evaluated-in-future');
    const future = preregistration({ frozenAt: '2099-01-01T00:00:00.000Z' });
    expect(run(heldoutRecords(undefined, '2100-01-01T00:00:00.000Z'), { plan: future }).reasons).toContain('preregistration-frozen-in-future');
    // Post-hoc loosening: the plan edited after freezing no longer matches the anchored digest.
    expect(run(heldoutRecords(), { plan: preregistration({ maximumFalseReadyRateBps: 10_000 }), trusted: anchored(plan) }).reasons)
      .toContain('preregistration-digest-mismatch');
    // Empty or missing preregistered slices.
    const oneSlice = heldoutSamples().map(sample => ({ ...sample, slice: 'citation:repo' }));
    const sliceResult = run(heldoutRecords(oneSlice));
    expect(sliceResult.reasons).toEqual(expect.arrayContaining(['slice-support-missing:citation:web',
      'slice-support-missing:gate:blocking', 'gate-blocking-slice-support-missing']));
    expect(() => run(heldoutRecords(), { plan: preregistration({ slices: [] }) })).toThrow('slices');
    for (const result of [run(noDate as never), sliceResult]) expect(result.decision).not.toBe('pass');
  });

  it('F8: calibration compatibility is resolved through the registry and only native distributions are accepted', () => {
    const screen = (context: SdlcScreeningTrustContext, observation = citationObservation()) =>
      evaluateSdlcEvidenceScreening(request(citationSubject(), observation), context);
    expect(screen(trust({ calibration: null }))).toMatchObject({ route: 'REVIEW', semantic: { reason: 'calibration-missing' } });
    expect(screen(trust({ calibration: calibration({ model: 'other-model' }) }))).toMatchObject({
      route: 'REVIEW', semantic: { reason: 'calibration-model-mismatch' } });
    const forged = { ...calibration()!, registry: { resolve: () => ({ action: 'allow', actualModel: MODEL }) } as never };
    expect(screen(trust({ calibration: forged }))).toMatchObject({ route: 'REVIEW', semantic: { reason: 'calibration-invalid' } });
    const { supportDistribution: _dropped, ...noDistribution } = citationObservation();
    expect(screen(trust(), noDistribution)).toMatchObject({ route: 'REVIEW', semantic: { reason: 'distribution-missing' } });
    expect(screen(trust(), citationObservation({ supportDistribution: { supports: 0.95 } }))).toMatchObject({
      route: 'REVIEW', semantic: { reason: 'distribution-invalid' } });
    // A confident label with a native distribution that disagrees is not accepted.
    expect(screen(trust(), citationObservation({ supportDistribution: nativeDistribution(SUPPORT_OPTIONS, 'unclear', 9_000) }))?.route)
      .toBe('REVIEW');
    const { distributions: _none, ...criterionNoDistribution } = criterionObservation();
    expect(evaluateSdlcEvidenceScreening(request(criterionSubject(false), criterionNoDistribution), trust())).toMatchObject({
      route: 'REVIEW', semantic: { reason: 'distribution-missing:relevance' } });
  });

  it('F9: omitted content is unverified and trust/sensitivity come from the trusted policy', () => {
    const { content: _content, ...withoutContent } = citationSubject().evidence[0];
    const omitted = evaluateSdlcEvidenceScreening(request({ ...citationSubject(), evidence: [withoutContent] }, citationObservation()), trust());
    expect(omitted).toMatchObject({ route: 'REVIEW', deterministic: { findings: [{ reason: 'content-unverified' }] } });
    const untrustedPolicy = gatePolicy();
    untrustedPolicy.spec.evidenceSubjects['source:atlas'] = { kind: 'citation', claimId: 'claim:port', sourceId: 'source:atlas',
      locator: 'doc:atlas#port', trust: 'untrusted', sensitivity: 'internal' };
    const spoofed = evaluateSdlcEvidenceScreening(request(citationSubject(), citationObservation(),
      { gatePolicyPin: artifactPin(untrustedPolicy) }), policyTrust(untrustedPolicy));
    expect(spoofed?.route).toBe('REVIEW');
    expect(spoofed?.reviewReasons).toEqual(expect.arrayContaining(['evidence-trust-mismatch', 'evidence-untrusted']));
    const unowned = gatePolicy();
    delete unowned.spec.evidenceSubjects['source:atlas'];
    expect(evaluateSdlcEvidenceScreening(request(citationSubject(), citationObservation(), { gatePolicyPin: artifactPin(unowned) }),
      policyTrust(unowned))?.reviewReasons).toEqual(expect.arrayContaining(['subject-isolation-violated', 'evidence-untrusted']));
  });

  it('F10: integrity is an allowlist; unknown or mismatched mode/state/source cannot pass', () => {
    for (const [mode, source] of Object.entries(VERIFIED_QUALIFICATION_INTEGRITY_SOURCES)) {
      expect(qualificationIntegrityAllowlistProblems(verifiedIntegrity({ integrity_mode: mode, trusted_score_source: source }))).toEqual([]);
    }
    expect(qualificationIntegrityAllowlistProblems(verifiedIntegrity({ integrity_mode: 'bogus', trusted_score_source: 'whatever' })))
      .toContain('integrity-mode-not-allowlisted');
    expect(qualificationIntegrityAllowlistProblems(verifiedIntegrity({ integrity_mode: 'locked', trusted_score_source: 'fresh-workspace' })))
      .toContain('untrusted-score-source');
    expect(qualificationIntegrityAllowlistProblems(verifiedIntegrity({ integrity_state: 'weak-signal' }))).toContain('integrity-not-verified');
    expect(qualificationIntegrityAllowlistProblems({ ...verifiedIntegrity(), compromise_labels: 'none' })).toEqual(['integrity-invalid']);
    const plan = preregistration();
    const release = (integrity: unknown) => buildSdlcScreeningReleaseReport({ preregistration: plan,
      trustedPreregistrationDigest: anchored(plan), heldout: heldoutRecords(), integrity: integrity as never, nowEpochMs: HELDOUT_NOW });
    expect(release(verifiedIntegrity({ integrity_mode: 'bogus', trusted_score_source: 'whatever' }))).toMatchObject({
      decision: 'HOLD', reasons: expect.arrayContaining(['integrity-mode-not-allowlisted']) });
    expect(release({ ...verifiedIntegrity(), release_gate: null })).toMatchObject({
      decision: 'HOLD', reasons: expect.arrayContaining(['integrity-invalid']) });
  });

  it('F11: validates mode, integer counts and bps, and labels decisions by explicit reason codes', () => {
    expect(() => evaluateSdlcEvidenceScreening(request(criterionSubject(false), criterionObservation(), { mode: 'bogus' as never }), trust()))
      .toThrow(SdlcScreeningValidationError);
    expect(() => applySdlcScreeningToGateOutcome({ status: 'fail' }, 'bogus' as never)).toThrow(SdlcScreeningValidationError);
    const plan = preregistration();
    expect(() => evaluateSdlcScreeningPreregistration({ ...plan, minimumSliceSupport: 1.5 }, anchored(plan), null, HELDOUT_NOW)).toThrow('minimums');
    expect(() => evaluateSdlcScreeningPreregistration({ ...plan, maximumFalseReadyRateBps: 10_001 }, anchored(plan), null, HELDOUT_NOW))
      .toThrow('basis points');
    const fractional = heldoutSamples().map((sample, index) => index === 0 ? { ...sample, candidate: { ...sample.candidate, calls: 1.5 } } : sample);
    expect(evaluateSdlcScreeningPreregistration(plan, anchored(plan), heldoutRecords(fractional), HELDOUT_NOW).reasons)
      .toContain('heldout-records-invalid');
    // A false-support bound breach is a failure, not insufficient evidence, even though the code mentions "support".
    const falseSupport = heldoutSamples().map(sample => sample.kind === 'citation' && sample.gold.support === 'unclear'
      ? { ...sample, candidate: { ...sample.candidate, route: 'ADVISORY_READY' as const, support: 'supports' as const } } : sample);
    const result = evaluateSdlcScreeningPreregistration(plan, anchored(plan), heldoutRecords(falseSupport), HELDOUT_NOW);
    expect(result.reasons).toContain('false-support-bound-exceeded');
    expect(result.decision).toBe('fail');
  });

  it('property: no evidence defect yields ADVISORY_READY under any bounded response or confidence', () => {
    const confidences = [0, 5_000, 7_999, 8_000, 10_000];
    const criterionDefects: Record<string, () => SdlcPhaseCriterionSubject['evidence']> = {
      'failed-required': () => passing().map(item => item.id === 'test:security' ? { ...item, passed: false } : item),
      'missing-required': () => passing().filter(item => item.id !== 'approval:release'),
      'not-present': () => passing().map(item => item.id === 'artifact:threat-model' ? { ...item, present: false } : item),
      'spoofed-not-required': () => passing().map(item => item.id === 'sig:artifact' ? { ...item, required: false, passed: false } : item),
      duplicated: () => [...passing(), criterionItem('test:security', { version: '2' })],
      foreign: () => [...passing(), criterionItem('artifact:g3')],
      'extra-failed': () => [...passing(), criterionItem('artifact:extra', { passed: false })],
      expired: () => passing().map(item => item.id === 'approval:release' ? { ...item, expiresAtEpochMs: 1_000 } : item),
      'nan-expiry': () => passing().map(item => item.id === 'approval:release' ? { ...item, expiresAtEpochMs: Number.NaN } : item),
      'unknown-id': () => [...passing(), criterionItem('artifact:invented')],
    };
    let readyControls = 0;
    for (const [defect, evidence] of [['none', passing] as const, ...Object.entries(criterionDefects)]) {
      const subject = withEvidence(evidence());
      for (const relevance of CRITERION_OPTIONS.relevance) for (const completeness of CRITERION_OPTIONS.completeness)
      for (const contradiction of CRITERION_OPTIONS.contradiction) for (const ambiguity of CRITERION_OPTIONS.ambiguity)
      for (const reviewerAttention of CRITERION_OPTIONS.reviewerAttention) for (const confidenceBps of confidences) {
        const receipt = evaluateSdlcEvidenceScreening(request(subject, criterionObservation(
          { relevance, completeness, contradiction, ambiguity, reviewerAttention, confidenceBps }, subject.evidence.map(item => item.id))), trust());
        if (defect === 'none') { if (receipt?.route === 'ADVISORY_READY') readyControls++; continue; }
        if (receipt?.route === 'ADVISORY_READY' || receipt?.deterministic.status === 'pass') {
          throw new Error(`${defect}: ${relevance}/${completeness}/${contradiction}/${ambiguity}/${reviewerAttention}/${confidenceBps} was ready`);
        }
      }
    }
    // Non-vacuous: without a defect exactly the all-positive, confident responses are ready.
    expect(readyControls).toBe(2);

    const citationPolicy = (owner: Partial<{ trust: 'untrusted' | 'verified'; sensitivity: 'restricted' | 'internal' }>) => {
      const policy = gatePolicy();
      policy.spec.evidenceSubjects['source:atlas'] = { kind: 'citation', claimId: 'claim:port', sourceId: 'source:atlas',
        locator: 'doc:atlas#port', trust: 'verified', sensitivity: 'internal', ...owner };
      return policy;
    };
    const { content: _content, ...noContent } = citationSubject().evidence[0];
    const citationDefects: Record<string, [SdlcCitationSubject, SdlcGateEvidencePolicy]> = {
      'not-retrieved': [citationSubject({ retrieved: false }), gatePolicy()],
      'locator-missing': [citationSubject({ locatorExists: false }), gatePolicy()],
      'provenance-unverified': [citationSubject({ provenanceVerified: false }), gatePolicy()],
      'publication-unauthorized': [citationSubject({ publicationAuthorized: false }), gatePolicy()],
      'content-omitted': [{ ...citationSubject(), evidence: [noContent] }, gatePolicy()],
      'digest-mismatch': [citationSubject({ contentDigest: digest('7') }), gatePolicy()],
      'caller-trust-spoof': [citationSubject(), citationPolicy({ trust: 'untrusted' })],
      restricted: [citationSubject({ sensitivity: 'restricted' }), citationPolicy({ sensitivity: 'restricted' })],
    };
    let citationReady = 0;
    for (const [defect, [subject, policy]] of [['none', [citationSubject(), gatePolicy()]] as const, ...Object.entries(citationDefects)]) {
      const context = policyTrust(policy);
      for (const support of SUPPORT_OPTIONS) for (const injection of ['yes', 'no', 'unclear'] as const)
      for (const supportStrengthBps of [0, 7_999, 8_000, 10_000]) for (const confidenceBps of confidences) {
        const receipt = evaluateSdlcEvidenceScreening(request(subject, citationObservation({ support, injection, supportStrengthBps, confidenceBps }),
          { gatePolicyPin: artifactPin(policy) }), context);
        if (defect === 'none') { if (receipt?.route === 'ADVISORY_READY') citationReady++; continue; }
        if (receipt?.route === 'ADVISORY_READY' || receipt?.deterministic.status === 'pass') {
          throw new Error(`${defect}: ${support}/${injection}/${supportStrengthBps}/${confidenceBps} was ready`);
        }
      }
    }
    // supports + confident "no" + strength >= 8000 + confidence >= 8000: 2 strengths x 2 confidences.
    expect(citationReady).toBe(4);
  });
});
