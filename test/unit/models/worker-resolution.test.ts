import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveWorkerPlan } from '../../../src/models/resolver.js';
import { WORKER_DISPATCH_ENABLE_COMMAND, WORKER_DISPATCH_READINESS_COMMAND } from '../../../src/models/worker-dispatch-offer.js';
import { assertWorkerSelectionAllowed, validateWorkerPolicyRoute, workerModelKey, mergeWorkerSelection, DEFAULT_WORKER_SELECTION } from '../../../src/models/provider-policy.js';
import { workerConfigDigest, workerActivationDigests } from '../../../src/config/aiwg-config.js';
import { buildWrapperRouteEnvelope } from '../../../src/models/wrapper-route.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

const resolve = (f: ReturnType<typeof workerResolutionFixture>) => resolveWorkerPlan(f.snapshot, f.request);
const rows = (f: ReturnType<typeof workerResolutionFixture>) => f.snapshot.catalog.discovery!.instances!.codex.models;
const codes = (plan: ReturnType<typeof resolve>) => [...plan.diagnostics, ...plan.exclusions.flatMap(e => e.diagnostics)].map(d => d.code);

const routeInput = (f: ReturnType<typeof workerResolutionFixture>, index = 0) => ({
  policy: f.snapshot.models.defaults.workerSelection!, role: 'coding', inferenceProvider: 'vendor',
  apiModelId: rows(f)[index].apiModelId!, selectedModel: rows(f)[index].id, effort: 'medium',
  identityEvidence: 'runtime-configured' as const, observation: rows(f)[index].worker!, now: new Date(f.request.now),
});

describe('Consolidated review regressions for #2883', () => {
  it('names the operator data policy key and warns about unreported output', () => {
    const f = workerResolutionFixture();
    const input = { ...routeInput(f), context: f.request.context };
    input.observation.dataUse = { processing: 'unknown', productImprovement: null, retentionDays: null };
    input.observation.maxOutputTokens = null;
    const diagnostics = validateWorkerPolicyRoute(input);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'OG_DATA_POLICY',
      message: expect.stringContaining('models.json defaults.workerSelection.dataPolicy.allowUnknown') }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'OG_MODEL_UNAPPROVED',
      blocking: false, message: expect.stringContaining('Output limit is unreported; only the context window was checked') }));
    input.policy.dataPolicy = { ...input.policy.dataPolicy, allowUnknown: true };
    expect(validateWorkerPolicyRoute(input).map(d => d.code)).toEqual(['OG_MODEL_UNAPPROVED']);
  });

  it('denies a contributor-named selected model even when it differs from apiModelId (requireExactModel false)', () => {
    const f = workerResolutionFixture();
    rows(f)[0].id = 'synthetic-contributor';
    rows(f)[0].apiModelId = 'synthetic/a%b';
    f.snapshot.config.parallelism!.groups!.workers.members[0].model = 'synthetic-contributor';
    const policy = f.snapshot.models.defaults.workerSelection!;
    policy.guards = { ...policy.guards, requireExactModel: false };
    const route = { ...routeInput(f), selectedModel: 'synthetic-contributor' };
    expect(validateWorkerPolicyRoute(route)).toContainEqual(expect.objectContaining({ code: 'OG_MODEL_UNAPPROVED' }));
    const plan = resolve(f);
    expect(plan.eligible.some(tuple => tuple.model === 'synthetic-contributor')).toBe(false);
    expect(() => assertWorkerSelectionAllowed({ inferenceProvider: 'vendor', model: 'synthetic-contributor', effort: { support: 'explicit', value: 'medium' } },
      { now: Date.parse(f.request.now), policy, role: 'coding', modelObservation: rows(f)[0].worker })).toThrow('denied model');
  });

  it.each(['synthetic-contributor', 'CONTRIBUTOR:model', 'synthetic/contributor.v1'])('excludes contributor model %s consistently with the invocation guard', model => {
    const f = workerResolutionFixture();
    rows(f)[0].id = rows(f)[0].apiModelId = model;
    f.snapshot.config.parallelism!.groups!.workers.members[0].model = model;
    const policy = f.snapshot.models.defaults.workerSelection!;
    expect(policy.guards!.deniedModels).not.toContain(workerModelKey('vendor', model));
    const plan = resolve(f);
    expect(plan.selected?.member).toBe('alternate');
    expect(plan.eligible.some(tuple => tuple.model === model)).toBe(false);
    expect(plan.exclusions.filter(tuple => tuple.model === model)).toHaveLength(2);
    expect(plan.exclusions.filter(tuple => tuple.model === model).every(tuple =>
      tuple.diagnostics.some(d => d.code === 'OG_MODEL_UNAPPROVED'))).toBe(true);
    expect(validateWorkerPolicyRoute(routeInput(f))).toContainEqual(expect.objectContaining({ code: 'OG_MODEL_UNAPPROVED' }));
    expect(() => assertWorkerSelectionAllowed({ inferenceProvider: 'vendor', model, effort: { support: 'explicit', value: 'medium' } },
      { now: Date.parse(f.request.now), policy, role: 'coding', modelObservation: rows(f)[0].worker })).toThrow('denied model');
    const selected = plan.selected!;
    expect(() => assertWorkerSelectionAllowed({ inferenceProvider: selected.inferenceProvider, model: selected.model,
      effort: { support: 'explicit', value: selected.effort } },
    { now: Date.parse(f.request.now), policy, role: 'coding', modelObservation: rows(f)[1].worker })).not.toThrow();
  });

  it.each(['shell', 'mcp'] as const)('intersects requested transport with resolved %s permissions', transport => {
    const f = workerResolutionFixture();
    const group = f.snapshot.config.parallelism!.groups!.workers;
    group.execution = { transport };
    const profile = f.snapshot.registry.providers.codex.workerAdapter!.invocationProfiles!['fixture-shell'];
    const mcp = { serverRef: 'fixture-server', tool: 'fixture-worker', inputSchemaDigest: workerConfigDigest('input'),
      outputSchemaDigest: workerConfigDigest('output'), sessionIsolation: 'per-call' as const, cancel: 'uncertain' as const };
    f.snapshot.installations.codex.mcp = mcp;
    profile.mcp = mcp;
    profile.transport = transport;
    expect(resolve(f).selected).toMatchObject({ transport, permissions: { transport } });
    f.request.transport = transport;
    expect(resolve(f).selected).toMatchObject({ transport, permissions: { transport } });
    f.request.transport = transport === 'shell' ? 'mcp' : 'shell';
    profile.transport = f.request.transport; // Qualification cannot grant a transport denied by the group.
    const plan = resolve(f);
    expect(plan.selected).toBeNull();
    expect(plan.eligible).toEqual([]);
    expect(plan.exclusions.flatMap(e => e.diagnostics)).toContainEqual(expect.objectContaining({
      code: 'OG_POLICY_RELAXATION', pointer: '/request/transport',
    }));
    if (transport === 'shell') {
      delete group.execution;
      expect(codes(resolve(f))).toContain('OG_POLICY_RELAXATION');
    }
  });

  it.each([0, 409, 410, 500])('keeps the context safety floor for supplied margin %s', safetyMargin => {
    const f = workerResolutionFixture();
    f.request.context.safetyMargin = safetyMargin;
    expect(resolve(f).selected?.context.safetyMargin).toBe(Math.max(410, safetyMargin));
    f.request.context.inputTokens = 2287; // Total is 4097 with the required 410-token floor.
    expect(resolve(f).selected).toBeNull();
  });

  it('uses catalog row IDs for required-role coverage and still rejects ambiguous matches', () => {
    const f = workerResolutionFixture();
    const group = f.snapshot.config.parallelism!.groups!.workers;
    group.requiredRoles = ['coding'];
    f.snapshot.models.defaults.workerSelection!.guards!.requireExactModel = false;
    rows(f).forEach((row, index) => { row.apiModelId = `exact-api-${index}`; });
    expect(resolve(f).status).toBe('eligible');
    rows(f).push(...structuredClone(rows(f)));
    expect(resolve(f).selected).toBeNull();
  });

  it('guards retirement comparisons against both null and undefined', () => {
    const f = workerResolutionFixture();
    const input = routeInput(f);
    input.observation.retiredAt = null;
    expect(validateWorkerPolicyRoute(input)).toEqual([]);
    delete (input.observation as Partial<typeof input.observation>).retiredAt;
    expect(validateWorkerPolicyRoute(input)).toContainEqual(expect.objectContaining({ code: 'OG_ADAPTER_UNQUALIFIED' }));
    input.observation.retiredAt = f.request.now;
    expect(validateWorkerPolicyRoute(input)).toContainEqual(expect.objectContaining({ code: 'OG_MODEL_UNAPPROVED', pointer: '/worker/lifecycle' }));
    // Missing retirement is schema-rejected today; also pin the requested defensive presence check.
    const source = readFileSync(new URL('../../../src/models/provider-policy.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/observation\.retiredAt !== null && Date\.parse/);
  });

  it('revalidates the recorded substitution with the original wrapper pin', () => {
    const f = workerResolutionFixture();
    const wrapperPin = 'retired-pin';
    f.snapshot.models.agentOverrides['aiwg-model-coding-worker'] = { 'model-override': wrapperPin };
    f.request.substitution = { group: 'workers', member: 'alternate', model: 'synthetic-alternate', effort: 'medium', rationale: 'Approved replacement' };
    const plan = resolve(f);
    expect(plan.selected?.member).toBe('alternate');
    const input = { ...routeInput(f, 1), wrapperPin, substitution: plan.choice!.substitution! };
    expect(validateWorkerPolicyRoute(input)).toEqual([]);
    for (const substitution of [undefined, { ...input.substitution, model: 'other' },
      { ...input.substitution, effort: 'high' }, { ...input.substitution, rationale: ' ' }]) {
      expect(validateWorkerPolicyRoute({ ...input, substitution })).toContainEqual(expect.objectContaining({ code: 'OG_PIN_MISMATCH' }));
    }
    input.policy.guards!.deniedModels = [workerModelKey('vendor', input.apiModelId)];
    expect(validateWorkerPolicyRoute(input)).toContainEqual(expect.objectContaining({ code: 'OG_MODEL_UNAPPROVED' }));
  });

  it('documents why deterministic routing cannot bypass worker premium authority', () => {
    const f = workerResolutionFixture();
    rows(f).forEach(row => { row.worker!.pricing.costClass = 'premium'; });
    f.request.authority = { deterministic: true, routine: true, maxAutoTier: 3 };
    expect(resolve(f).selected).toBeNull();
    f.request.authority.premiumAuthorized = true;
    expect(resolve(f).status).toBe('eligible');
    // This finding requests documentation of behavior that already worked.
    const source = readFileSync(new URL('../../../src/models/resolver.ts', import.meta.url), 'utf8');
    expect(source).toContain('// Worker candidates always invoke a model; deterministic/routine hints must not bypass premium authority.');
  });
});

describe('T-OG-01 S1 resolution, synthetic evidence and no side effects', () => {
  it.each([false, undefined])('explains dispatch off (%s) with shared enable and readiness commands (#3070)', workerDispatch => {
    const f = workerResolutionFixture();
    f.snapshot.config.parallelism!.worker_dispatch = workerDispatch;
    const plan = resolve(f);
    expect(plan.status).toBe('disabled');
    expect(plan.selected).toBeNull();
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({
      code: 'OG_CONFIG_REFERENCE', pointer: '/parallelism/worker_dispatch',
      message: expect.stringContaining('parallelism.worker_dispatch'),
    }));
    expect(plan.diagnostics[0].message).toContain(WORKER_DISPATCH_ENABLE_COMMAND);
    expect(plan.diagnostics[0].message).toContain(WORKER_DISPATCH_READINESS_COMMAND);
  });

  it('R01 reproduces eligibility/order, canonical identities, origins and context terms', () => {
    const f = workerResolutionFixture();
    const before = structuredClone(f);
    const plan = resolve(f);
    expect(plan.status, JSON.stringify(plan.exclusions)).toBe('eligible');
    expect(plan.eligible.map(t => [t.member, t.effort])).toEqual([
      ['primary', 'medium'], ['primary', 'high'], ['alternate', 'medium'], ['alternate', 'high'],
    ]);
    expect(plan.selected?.modelKey).toBe('vendor/synthetic%2Fa%25b');
    expect(plan.selected?.context).toMatchObject({ safetyMargin: 410, total: 2010, fits: true, estimator: 'synthetic-upper-bound-v1' });
    expect(plan.selected?.effectiveMaxParallel).toBe(2);
    expect(plan.origins?.['/defaults/workerSelection/guards/deniedEfforts'][0].contribution).toEqual(['ultra']);
    expect(resolve(f)).toEqual(plan);
    expect(f).toEqual(before);
  });

  it('R02 accepts a conductor alternate with rationale and rejects an ineligible choice', () => {
    const f = workerResolutionFixture();
    f.request.choice = { group: 'workers', member: 'alternate', model: 'synthetic-alternate', effort: 'high', rationale: 'Independent bounded review capacity' };
    expect(resolve(f).choice).toEqual({ source: 'conductor', rationale: f.request.choice.rationale });
    expect(resolve(f).selected?.member).toBe('alternate');
    f.request.choice.rationale = ' ';
    expect(resolve(f).selected).toBeNull();
    f.request.choice.rationale = 'Cannot authorize a denied effort';
    f.request.choice.effort = 'ultra';
    expect(resolve(f).selected).toBeNull();
  });

  it.each(['config', 'models', 'catalog', 'profiles', 'constraints', 'user-digest'] as const)('R03 invalidates changed %s and incomplete expected digests', field => {
    const f = workerResolutionFixture();
    f.request.expectedDigests = resolve(f).digests;
    expect(resolve(f).status).toBe('eligible');
    if (field === 'config') f.snapshot.config.parallelism!.max_parallel_subagents = 3;
    if (field === 'models') f.snapshot.models.defaults.tier = 'premium';
    if (field === 'catalog') rows(f)[0].worker!.fetchedAt = '2026-10-07T00:00:01Z';
    if (field === 'profiles') f.snapshot.installations.codex.cliVersion = '1.0.1';
    if (field === 'constraints') f.snapshot.constraints = { maxParallel: 1 };
    if (field === 'user-digest') f.snapshot.modelDigests.userModelsDigest = workerConfigDigest({ changed: true });
    expect(resolve(f).selected).toBeNull();
    expect(codes(resolve(f))).toContain('OG_CONFIG_REFERENCE');
    f.request.expectedDigests = {};
    expect(resolve(f).status).toBe('blocked');
  });

  it.each([
    ['ultra', (f: any) => { f.request.effort = 'ultra'; }, 'OG_EFFORT_DENIED'],
    ['self-delegating alias', (f: any) => { rows(f).forEach(r => { r.worker!.efforts[0].selfDelegates = true; r.worker!.efforts[1].selfDelegates = null; }); }, 'OG_EFFORT_DENIED'],
    ['contributor data', (f: any) => { rows(f).forEach(r => { r.worker!.dataUse.productImprovement = true; }); }, 'OG_DATA_POLICY'],
    ['unknown processing', (f: any) => { rows(f).forEach(r => { r.worker!.dataUse.processing = 'unknown'; }); }, 'OG_DATA_POLICY'],
    ['unknown class', (f: any) => { f.request.dataClass = 'missing'; }, 'OG_DATA_POLICY'],
    ['null effort', (f: any) => { f.request.effort = null; }, 'OG_EFFORT_DENIED'],
    ['unknown support', (f: any) => { rows(f).forEach(r => { r.worker!.effortSupport = 'unknown'; r.worker!.efforts = []; r.reasoningEfforts = []; }); }, 'OG_EFFORT_DENIED'],
    ['hidden', (f: any) => { rows(f).forEach(r => { r.worker!.visibility = 'hidden'; }); }, 'OG_MODEL_UNAPPROVED'],
    ['stale', (f: any) => { f.request.now = '2026-10-15T00:00:00Z'; }, 'OG_ADAPTER_UNQUALIFIED'],
    ['sunset', (f: any) => { rows(f).forEach(r => { r.worker!.sunsetAt = f.request.now; }); }, 'OG_MODEL_UNAPPROVED'],
    ['alias', (f: any) => { rows(f).forEach(r => { r.apiModelId = 'exact-other'; }); }, 'OG_PIN_MISMATCH'],
    ['unknown identity', (f: any) => { f.snapshot.installations.codex.identityEvidence = 'unknown'; }, 'OG_ADAPTER_UNQUALIFIED'],
    ['account drift', (f: any) => { f.snapshot.installations.codex.accountScope = 'other'; }, 'OG_ADAPTER_UNQUALIFIED'],
    ['runtime drift', (f: any) => { f.snapshot.installations.codex.cliVersion = '2.0.0'; }, 'OG_ADAPTER_UNQUALIFIED'],
    ['endpoint drift', (f: any) => { f.snapshot.installations.codex.endpointFingerprint = 'other'; }, 'OG_ADAPTER_UNQUALIFIED'],
    ['doc-only adapter', (f: any) => { f.snapshot.registry.providers.codex.workerAdapter.qualification.status = 'unqualified'; }, 'OG_ADAPTER_UNQUALIFIED'],
    ['missing profile', (f: any) => { f.snapshot.installations.codex.profile = 'missing'; }, 'OG_ADAPTER_UNQUALIFIED'],
    ['unknown inference provider', (f: any) => { rows(f).forEach(r => { delete r.llmProvider; }); }, 'OG_ADAPTER_UNQUALIFIED'],
  ])('R04 blocks %s with an exclusion', (_name, mutate, code) => {
    const f = workerResolutionFixture();
    expect(resolve(f).status).toBe('eligible');
    mutate(f);
    expect(resolve(f).status, JSON.stringify(resolve(f))).toBe('blocked');
    expect(codes(resolve(f))).toContain(code);
  });

  it.each(['briefTokens', 'inputTokens', 'toolOutputAllowance', 'reservedOutput', 'safetyMargin'] as const)('R05 bounds context term %s', term => {
    const f = workerResolutionFixture();
    f.request.context[term] = 4097;
    expect(resolve(f).selected).toBeNull();
    f.request.context[term] = -1;
    expect(resolve(f).selected).toBeNull();
  });
  it('checks only the context window when output is unreported, preserving null', () => {
    const f = workerResolutionFixture();
    rows(f).forEach(row => { row.worker!.maxOutputTokens = null; });
    f.request.context = { estimator: 'exact-v1', briefTokens: 1024, inputTokens: 1024, toolOutputAllowance: 614, reservedOutput: 1024 };
    const plan = resolve(f);
    expect(plan.selected?.context).toMatchObject({ total: 4096, fits: true, qualifiedMaxOutputTokens: null });
    expect(plan.selected?.diagnostics).toContainEqual(expect.objectContaining({ blocking: false,
      pointer: '/worker/maxOutputTokens', message: expect.stringContaining('only the context window was checked') }));
    f.request.context.reservedOutput++;
    expect(resolve(f).selected).toBeNull();
    f.request.context.reservedOutput = 1;
    rows(f).forEach(row => { row.worker!.contextTokens = null; });
    expect(resolve(f).selected).toBeNull();
  });

  it('R06 enforces exact context/output boundaries and blocks unknown limits', () => {
    const f = workerResolutionFixture();
    f.request.context = { estimator: 'exact-v1', briefTokens: 1024, inputTokens: 1024, toolOutputAllowance: 614, reservedOutput: 1024 };
    expect(resolve(f).selected?.context.total).toBe(4096);
    f.request.context.reservedOutput++;
    expect(resolve(f).selected).toBeNull();
    f.request.context.reservedOutput = 1;
    rows(f).forEach(row => { row.worker!.contextTokens = null; });
    expect(resolve(f).selected).toBeNull();
  });

  it('R07 retains wrapper and task pins until an exact substitution is authorized', () => {
    const f = workerResolutionFixture();
    f.snapshot.models.agentOverrides['aiwg-model-coding-worker'] = { 'model-override': 'retired-pin' };
    expect(codes(resolve(f))).toContain('OG_PIN_MISMATCH');
    expect(resolve(f).selected).toBeNull();
    f.request.substitution = { group: 'workers', member: 'alternate', model: 'synthetic-alternate', effort: 'medium', rationale: 'Explicit replacement for retired pin' };
    expect(resolve(f).selected?.member).toBe('alternate');
    expect(resolve(f).choice?.substitution).toEqual(f.request.substitution);
    rows(f)[1].worker!.dataUse.productImprovement = true;
    expect(resolve(f).selected).toBeNull();
  });

  it('R08 applies canonical denials across installations and current revocations', () => {
    const f = workerResolutionFixture();
    f.snapshot.models.defaults.workerSelection!.guards!.deniedModels = [workerModelKey('vendor', 'synthetic/a%b')];
    expect(resolve(f).eligible.every(t => t.member === 'alternate')).toBe(true);
    f.snapshot.constraints = { revokedModels: [workerModelKey('vendor', 'synthetic-alternate')] };
    expect(resolve(f).selected).toBeNull();
  });

  it('R09 uses the existing premium authority rather than a recommendation', () => {
    const f = workerResolutionFixture();
    rows(f).forEach(r => { r.worker!.pricing.costClass = 'premium'; });
    expect(resolve(f).selected).toBeNull();
    expect(resolve(f).exclusions.flatMap(e => e.diagnostics)).toContainEqual(expect.objectContaining({
      pointer: '/request/authority', message: expect.stringContaining('--authorize-premium') }));
    f.request.authority = { premiumAuthorized: true, maxAutoTier: 3 };
    expect(resolve(f).status).toBe('eligible');
    f.request.authority.maxAutoTier = 2;
    expect(resolve(f).selected).toBeNull();
  });

  it('R10 keeps attestation distinct from runtime configuration', () => {
    const f = workerResolutionFixture();
    expect(resolve(f).selected?.identityEvidence).toBe('runtime-configured');
    f.snapshot.models.defaults.workerSelection!.guards!.minimumIdentityEvidence = 'backend-attested';
    expect(resolve(f).selected).toBeNull();
    f.snapshot.installations.codex.identityEvidence = 'backend-attested';
    expect(resolve(f).selected).toBeNull();
    f.snapshot.registry.providers.codex.workerAdapter!.capabilities.modelPin = 'observed';
    expect(resolve(f).selected?.identityEvidence).toBe('backend-attested');
  });

  it('R11 permits qualified local no-control effort only for an allowed role', () => {
    const f = workerResolutionFixture();
    const guidance = f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding;
    Object.assign(guidance, { initialEffort: null, effortLadder: [], allowNotApplicableEffort: true });
    rows(f).forEach(r => { r.worker!.effortSupport = 'not-applicable'; r.worker!.efforts = []; r.reasoningEfforts = []; });
    expect(resolve(f).selected?.effort).toBeNull();
    expect(resolve(f).status).toBe('eligible');
    rows(f).forEach(r => { r.worker!.qualification.roles = ['efficiency']; });
    expect(resolve(f).status).toBe('blocked');
  });

  it('R12 shares eligibility with activated managed callers and rejects stale activation', () => {
    const f = workerResolutionFixture();
    f.snapshot.config.parallelism!.worker_dispatch = false;
    expect(resolve(f).status).toBe('disabled');
    f.snapshot.config.parallelism!.worker_dispatch = true;
    f.snapshot.config.parallelism!.worker_mode = 'managed';
    expect(resolve(f).diagnostics.some(d => d.pointer === '/parallelism/activation')).toBe(true);
    f.snapshot.config.parallelism!.activation = { revision: 1, snapshotRef: 'fixture:snapshot',
      ...workerActivationDigests(f.snapshot.config), ...f.snapshot.modelDigests };
    expect(resolve(f).diagnostics.some(d => d.pointer === '/parallelism/activation')).toBe(false);
    expect(resolve(f).status).toBe('eligible');
    expect(resolve(f).selected?.member).toBe('primary');
    f.snapshot.modelDigests.userModelsDigest = workerConfigDigest({ changed: true });
    expect(resolve(f).diagnostics.some(d => d.pointer === '/parallelism/activation')).toBe(true);
  });

  it('R13 uses complete existing merge algebra and carries restriction origins', () => {
    const f = workerResolutionFixture();
    const merged = mergeWorkerSelection([
      { source: 'built', authority: 'builtin', digest: workerConfigDigest(null), policy: { ...DEFAULT_WORKER_SELECTION, ...f.projectPolicy } },
      { source: 'user', authority: 'user', digest: workerConfigDigest('user'), policy: { guards: { deniedEfforts: ['high'], allowedVisibility: ['listed'], denySelfDelegation: true, requireExactModel: true, minimumIdentityEvidence: 'backend-attested' }, dataPolicy: { allowUnknown: false, allowProductImprovement: false, maxRetentionDays: 0 } } },
      { source: 'project', authority: 'project', digest: workerConfigDigest('project'), policy: { guards: { deniedEfforts: [], allowedVisibility: [], denySelfDelegation: false, requireExactModel: false, minimumIdentityEvidence: 'runtime-configured' }, dataPolicy: { allowUnknown: true, allowProductImprovement: true, maxRetentionDays: 10 } } },
    ]);
    expect(merged.diagnostics.length).toBe(6);
    f.snapshot.models.defaults.workerSelection = merged.policy;
    f.snapshot.models.workerPolicyOrigins = merged.origins;
    expect(resolve(f).selected).toBeNull();
    expect(merged.policy.guards).toMatchObject({ deniedEfforts: ['high'], allowedVisibility: [], denySelfDelegation: true, requireExactModel: true, minimumIdentityEvidence: 'backend-attested' });
    expect(merged.policy.dataPolicy).toMatchObject({ allowUnknown: false, allowProductImprovement: false, maxRetentionDays: 0 });
  });

  it('R16 checks declared required roles while optional roles block only when requested', () => {
    const f = workerResolutionFixture();
    expect(resolve(f).status).toBe('eligible');
    f.request = { ...f.request, taskClass: 'review' };
    expect(resolve(f).status).toBe('blocked');
    f.request.taskClass = 'implementation';
    const group = f.snapshot.config.parallelism!.groups!.workers;
    group.requiredRoles = ['reasoning'];
    group.members[0].roles.push('reasoning');
    expect(resolve(f).status).toBe('blocked');
    f.snapshot.models.defaults.workerSelection!.roleGuidance!.reasoning = {
      groups: ['workers'], tier: 'standard', initialEffort: 'medium', effortLadder: ['medium'],
    };
    expect(resolve(f).status).toBe('eligible');
    rows(f).forEach(row => { row.worker!.qualification.roles = ['coding']; });
    expect(resolve(f).status).toBe('blocked');
  });

  it('R17 intersects all current ceilings and exposes default permissions as guidance', () => {
    const f = workerResolutionFixture();
    f.snapshot.config.parallelism!.admission = { modelCaps: { [workerModelKey('vendor', 'synthetic/a%b')]: 1 } };
    f.request.maxParallel = 10;
    expect(resolve(f).selected?.effectiveMaxParallel).toBe(1);
    expect(resolve(f).selected?.permissions).toMatchObject({ isolation: 'worktree', sandbox: 'workspace-write', approval: 'never', network: 'deny', receipts: 'optional' });
    f.snapshot.constraints = { maxParallel: 0 };
    expect(resolve(f).selected).toBeNull();
  });

  it.each(['/family', '/contextTokens', '/maxOutputTokens', '/llmProvider', '/qualification'])('R18 blocks conflicting selection fact %s', field => {
    const f = workerResolutionFixture();
    rows(f).forEach(row => { row.worker!.conflicts = [{ field, evidence: [
      { value: 'a', source: 'fixture:a', pointer: field, observedAt: f.request.now, digest: workerConfigDigest('a') },
      { value: 'b', source: 'fixture:b', pointer: field, observedAt: f.request.now, digest: workerConfigDigest('b') },
    ] }]; });
    expect(resolve(f).selected).toBeNull();
    expect(codes(resolve(f))).toContain('OG_MODEL_UNAPPROVED');
  });

  it('R19 preserves explicit first-layer widening, data-class narrowing and empty denials', () => {
    const f = workerResolutionFixture();
    const merged = mergeWorkerSelection([
      { source: 'builtin', authority: 'builtin', digest: workerConfigDigest(null), policy: { ...DEFAULT_WORKER_SELECTION, ...f.projectPolicy } },
      { source: 'project', authority: 'project', digest: workerConfigDigest('project'), policy: {
        guards: { allowedVisibility: ['listed', 'hidden'] }, dataClasses: { private: { allowedProcessing: [] } },
      } },
    ]);
    expect(merged.diagnostics).toEqual([]);
    f.snapshot.models.defaults.workerSelection = merged.policy;
    rows(f).forEach(row => { row.worker!.visibility = 'hidden'; });
    expect(resolve(f).status).toBe('eligible');
    f.request.dataClass = 'private';
    expect(resolve(f).selected).toBeNull();
    expect(codes(resolve(f))).toContain('OG_DATA_POLICY');
  });

  it('R20 intersects project, trusted and task budget/attempt ceilings without admission', () => {
    const f = workerResolutionFixture();
    f.snapshot.config.parallelism!.budgets = { perRun: { tokens: 9000, costUsd: 3 }, perTask: { tokens: 5000, wallSeconds: 120 } };
    f.snapshot.config.parallelism!.retry = { maxAttempts: 4 };
    f.snapshot.constraints = { ceilings: { tokens: 4000, costUsd: 2, wallSeconds: 90, maxAttempts: 3 } };
    f.request.ceilings = { tokens: 8000, costUsd: 1, wallSeconds: 60, maxAttempts: 10 };
    expect(resolve(f).ceilings).toEqual({ tokens: 4000, costUsd: 1, wallSeconds: 60, maxAttempts: 3 });
    expect(resolve(f).status).toBe('eligible');
    f.snapshot.config.parallelism!.budgets.enforcement = 'hard';
    expect(resolve(f).selected).toBeNull();
    expect(codes(resolve(f))).toContain('OG_BUDGET_UNMEASURABLE');
    f.snapshot.registry.providers.codex.workerAdapter!.capabilities.hardBudget = ['tokens', 'cost', 'wall-time'];
    expect(resolve(f).status).toBe('eligible');
    f.request.ceilings.maxAttempts = 0;
    expect(resolve(f).selected).toBeNull();
  });
});

describe('T-OG-07 observed lineage and conductor-neutral wrapper facts', () => {
  it('R14 blocks same/unknown observed family even across CLI names', () => {
    const f = workerResolutionFixture();
    f.request.requireDifferentFamily = true;
    f.request.reviewOf = { ...structuredClone(rows(f)[0].worker!), cliId: 'muse' };
    expect(resolve(f).selected).toBeNull();
    rows(f)[1].worker!.family = 'independent-family';
    expect(resolve(f).selected?.member).toBe('alternate');
    rows(f)[1].worker!.family = 'unknown';
    expect(resolve(f).selected).toBeNull();
    f.request.reviewOf.family = 'unknown';
    expect(resolve(f).diagnostics).not.toHaveLength(0);
  });

  it('R15 exposes the same facts through two conductor wrappers without bypassing enforcement', () => {
    const f = workerResolutionFixture();
    const make = (provider: 'claude' | 'codex') => buildWrapperRouteEnvelope({ provider, complex: true,
      capability: { type: 'agent', name: 'fixture', id: 'fixture:agent', source: { path: 'fixture', scope: 'packaged', provenance: 'corpus' } },
      assignment: 'Bounded synthetic work', launchMechanism: 'manual', worker: f });
    expect(make('claude').worker).toEqual(make('codex').worker);
    expect(make('claude').model).toBeNull();
    expect(make('claude').launch.target).toBe('aiwg-model-coding-worker');
    f.request.effort = 'ultra';
    expect(make('codex').launch.target).toBeNull();
    expect(make('codex').worker?.selected).toBeNull();
  });
});
