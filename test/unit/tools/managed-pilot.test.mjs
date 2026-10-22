import { describe, expect, it } from 'vitest';
import { dimensions, qualificationRows, setupMinutes, summarizePilot, validatePilotPlan } from '../../../tools/testing/managed-pilot.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
function plan() {
  const tasks = Array.from({ length: 40 }, (_, index) => {
    const baseline = index < 10;
    const number = baseline ? index + 1 : index - 9;
    return { id: `${baseline ? 'baseline' : 'managed'}-${number}`, cohort: baseline ? 'BASELINE' : 'MANAGED',
      stratum: `stratum-${(number - 1) % 10}`, conductor: (number + (baseline ? 0 : Math.floor((number - 1) / 10))) % 2 ? 'claude' : 'codex',
      holdout: index >= 30, phase: baseline ? 1 : index >= 30 ? 3 : 2,
      sourceTask: `synthetic-${index}`, sourceDigest: digest, maxAttempts: 2, wallSeconds: 1200,
      workerWallSeconds: 600, reservationUsd: 5, scenario: 'bounded synthetic task' };
  });
  // Two of each conductor in every four-task stratum.
  tasks.slice(10, 20).forEach(task => { task.conductor = task.conductor === 'claude' ? 'codex' : 'claude'; });
  return { revision: 1, liveExecution: 'on-hold', maxConcurrentTasks: 2, maxWorkersPerTask: 1, tasks, reviewers: [
    { id: 'R1', role: 'Technical Reviewer', assignment: 'authorized technical role' },
    { id: 'R2', role: 'Operator Workflow Reviewer', assignment: 'authorized workflow role' },
  ], adjudicator: 'Test Lead', reviewHours: 20, adjudicationHours: 4,
  inference: { baselineUsd: 50, managedUsd: 150, reviewUsd: 16, smokeUsd: 1, totalUsd: 250 },
  routes: ['claude/shell', 'codex/shell', 'muse/shell', 'hermes/shell', 'local/http'] };
}
const scores = () => Object.fromEntries(dimensions.map(key => [key, 2]));
const reviewed = id => ({ id, packetDigest: digest, reviews: ['R1', 'R2'].map(reviewer => ({ reviewer,
  independent: true, toolsUsed: false, packetDigest: digest, dimensions: scores() })) });
const passingGates = () => Object.fromEntries(['eligibility', 'pins', 'dataSafety', 'caps', 'policy',
  'independentReview', 'evidenceComplete', 'managedOwnership', 'noManagedState'].map(key => [key, 'pass']));

describe('EVAL-OG-01 offline managed pilot plan', () => {
  it('freezes 10 baseline and 30 managed tasks with ten holdouts and separate inference ceilings', () => {
    expect(validatePilotPlan(plan()).tasks).toHaveLength(40);
  });
  it.each(['duplicate', 'holdout', 'reviewers', 'budget', 'conductor', 'phase', 'live'])('rejects an invalid %s freeze', vector => {
    const p = plan();
    if (vector === 'duplicate') p.tasks[1].id = p.tasks[0].id;
    if (vector === 'holdout') p.tasks[0].holdout = true;
    if (vector === 'reviewers') p.reviewers[1].id = 'R1';
    if (vector === 'budget') p.inference.managedUsd = 1;
    if (vector === 'conductor') p.tasks[0].conductor = 'codex';
    if (vector === 'phase') p.tasks[0].phase = 2;
    if (vector === 'live') p.liveExecution = 'enabled';
    expect(() => validatePilotPlan(p)).toThrow();
  });
});

describe('EVAL-OG-01 setup and argument measurements', () => {
  it('subtracts only recorded pauses from monotonic setup time', () => {
    expect(setupMinutes([{ event: 'setup-start', elapsedMs: 0 }, { event: 'setup-pause', elapsedMs: 60000 },
      { event: 'setup-resume', elapsedMs: 120000 }, { event: 'setup-end', elapsedMs: 180000 }])).toBe(2);
  });
  it.each([
    [], [{ event: 'setup-start', elapsedMs: 2 }, { event: 'setup-end', elapsedMs: 1 }],
    [{ event: 'setup-pause', elapsedMs: 0 }],
    [{ event: 'setup-start', elapsedMs: 0 }, { event: 'setup-pause', elapsedMs: 1 }, { event: 'setup-end', elapsedMs: 2 }],
    [{ event: 'setup-start', elapsedMs: 0 }, { event: 'setup-end', elapsedMs: Infinity }],
  ].map(events => [events]))('reports invalid or missing setup sequence as unknown: %j', events => {
    expect(setupMinutes(events)).toBeNull();
  });
  it('keeps all blocked tasks in denominators and separates host gates from routing', () => {
    const result = summarizePilot(plan(), [{ id: 'managed-1', outcome: 'host-gate-blocked' }, { id: 'managed-2', outcome: 'routing-blocked' }]);
    expect(result.managed.tasks).toBe(30);
    expect(result.outcomes).toEqual({ 'not-run': 38, 'host-gate-blocked': 1, 'routing-blocked': 1 });
    expect(result.setupTarget).toBe('pending');
    expect(result.argumentEditTarget).toBe('pending');
    expect(result.qualityTarget).toBe('pending');
    expect(result.safety).toMatchObject({ status: 'pending', gatesPending: 320 });
  });
  it('compares exact command bytes across all attempts and reports launched-only reuse separately', () => {
    const result = summarizePilot(plan(), [
      { id: 'managed-1', launches: [{ rendered: 'a --x 雪', executed: 'a --x 雪' }] },
      { id: 'managed-2', launches: [{ rendered: 'a', executed: 'b' }, { rendered: 'a', executed: 'a' }] },
      { id: 'managed-3', launches: [{ rendered: 'a', edited: false }] },
      { id: 'managed-4', protectedPass: true, noDispatchAudit: { independent: true, basis: 'verified-typed-stop' } },
    ]);
    expect(result.managed).toMatchObject({ noArgumentEdits: 2, launchedTasks: 3, launchedExact: 1, argumentEditsUnknown: 27 });
    expect(result.rows.find(row => row.id === 'managed-2').argumentEdits).toBe(true);
  });
  it('does not count unaudited no-dispatch claims', () => {
    expect(summarizePilot(plan(), [{ id: 'managed-1', noDispatchAudit: { independent: true, basis: 'verified-typed-stop' } }])
      .rows.find(row => row.id === 'managed-1').argumentEdits).toBeNull();
  });
  it('reports complete targets and matched conductor/stratum measurements without dropping stops', () => {
    const p = plan();
    const records = p.tasks.map(task => ({ ...reviewed(task.id), outcome: 'routing-blocked', protectedPass: true,
      events: [{ event: 'setup-start', elapsedMs: 0 }, { event: 'setup-end', elapsedMs: task.cohort === 'BASELINE' ? 120000 : 60000 }],
      gates: passingGates(), noDispatchAudit: { independent: true, basis: 'verified-typed-stop' } }));
    const result = summarizePilot(p, records);
    expect(result).toMatchObject({ setupTarget: 'pass', argumentEditTarget: 'pass', qualityTarget: 'pass', setupReductionPercent: 50,
      safety: { status: 'pass' }, managed: { launchedTasks: 0, noArgumentEdits: 30 } });
    expect(result.byConductor.claude.managed.tasks).toBe(15);
    expect(result.byStratum['stratum-0'].managed.tasks).toBe(3);
  });
});

describe('EVAL-OG-01 independent choice scoring and cost uncertainty', () => {
  it('requires every dimension disagreement to be adjudicated with evidence, never averaged', () => {
    const record = reviewed('managed-1');
    record.reviews[1].dimensions.task_role_fit = 1;
    let row = summarizePilot(plan(), [record]).rows.find(row => row.id === record.id);
    expect(row).toMatchObject({ scores: null, unresolved: true, disagreements: ['task_role_fit'] });
    record.adjudication = { adjudicator: 'Test Lead', dimensions: scores(), evidence: ['fixture:choice'], reasons: { task_role_fit: 'Task constraints support fit.' } };
    row = summarizePilot(plan(), [record]).rows.find(row => row.id === record.id);
    expect(row).toMatchObject({ qualityPass: true, unresolved: false });
  });
  it.each(['packet', 'tools', 'independence', 'duplicate'])('leaves %s review evidence unscored', vector => {
    const record = reviewed('managed-1');
    if (vector === 'packet') record.reviews[0].packetDigest = 'different';
    if (vector === 'tools') record.reviews[0].toolsUsed = true;
    if (vector === 'independence') record.reviews[0].independent = false;
    if (vector === 'duplicate') record.reviews.push(record.reviews[0]);
    expect(summarizePilot(plan(), [record]).managed.scored).toBe(0);
  });
  it('never accepts a choice with a zero dimension even if its total is eight', () => {
    const record = reviewed('managed-1');
    record.reviews.forEach(review => { review.dimensions.task_role_fit = 0; });
    expect(summarizePilot(plan(), [record]).managed.qualityPass).toBe(0);
  });
  it('retains missing and retry usage as unknown and separates estimates, measurements and reservations', () => {
    const result = summarizePilot(plan(), [{ id: 'managed-1', launches: [{}, {}], usage: [
      { scope: 'conductor', quality: 'measured', tokens: 10, costUsd: 1, source: 'fixture:conductor' },
      { scope: 'worker', attempt: 1, quality: 'estimated', tokens: 20, costUsd: 2, source: 'fixture:estimate' },
    ] }]);
    expect(result.usage).toMatchObject({ items: 42, unknownCostItems: 40, totalCostUsd: null,
      subsets: { measured: { items: 1, costUsd: 1 }, estimated: { items: 1, costUsd: 2 }, unknown: { items: 40, costUsd: null } } });
    expect(result.reservations.managedUsd).toBe(150);
  });
  it('rejects unknown usage disguised as zero and unexpected or duplicated task results', () => {
    expect(() => summarizePilot(plan(), [{ id: 'managed-1', usage: [{ scope: 'conductor', quality: 'unknown', tokens: 0, costUsd: 0 }] }])).toThrow(/unknown usage/);
    expect(() => summarizePilot(plan(), [{ id: 'outside' }])).toThrow(/outside frozen/);
    expect(() => summarizePilot(plan(), [{ id: 'managed-1' }, { id: 'managed-1' }])).toThrow(/duplicate/);
  });

  it('retains failed reviewer inference and reports safety separately from high choice scores', () => {
    const record = { ...reviewed('managed-1'), gates: { eligibility: 'fail' }, reviewAttempts: [{ reviewer: 'R1', attempt: 1 }] };
    const result = summarizePilot(plan(), [record]);
    expect(result.managed.qualityPass).toBe(1);
    expect(result.safety).toMatchObject({ status: 'fail', violations: [{ id: 'managed-1', gate: 'eligibility' }] });
    expect(result.rows.find(row => row.id === record.id).usage).toContainEqual(expect.objectContaining({ scope: 'reviewer', quality: 'unknown' }));
    expect(result.rows.find(row => row.id === record.id).usage.filter(item => item.scope === 'reviewer')).toHaveLength(2);
  });
  it('rejects duplicate usage snapshots instead of counting them as independent spend', () => {
    const item = { scope: 'conductor', quality: 'measured', tokens: 10, costUsd: 1, source: 'fixture:usage' };
    expect(() => summarizePilot(plan(), [{ id: 'managed-1', usage: [item, item] }])).toThrow(/duplicate usage/);
  });
  it('reports cost per accepted outcome only for the fully measured accepted subset', () => {
    const records = ['measured', 'estimated'].map((quality, index) => ({ id: `managed-${index + 1}`, accepted: true,
      protectedPass: true, outcome: 'completed', gates: passingGates(), wallSeconds: 10,
      usage: [{ scope: 'conductor', quality, costUsd: index + 1, tokens: null, source: 'fixture:usage' }] }));
    const result = summarizePilot(plan(), records);
    expect(result.managed).toMatchObject({ accepted: 2, measuredAcceptedSubset: { tasks: 1, costUsd: 1, costPerAcceptedUsd: 1 } });
    expect(result.usage.totalCostUsd).toBeNull();
    records[0].gates.managedOwnership = 'fail';
    expect(summarizePilot(plan(), records).managed.accepted).toBe(1);
  });
  it('rejects acceptance when recorded attempts or wall time exceed frozen caps', () => {
    for (const extra of [{ launches: [{}, {}, {}] }, { wallSeconds: 1201 }]) {
      const result = summarizePilot(plan(), [{ id: 'managed-1', accepted: true, protectedPass: true, gates: passingGates(), ...extra }]);
      expect(result.managed.accepted).toBe(0);
      expect(result.safety.violations).toContainEqual({ id: 'managed-1', gate: 'caps' });
    }
  });
});

describe('managed pilot advertised qualification coverage', () => {
  it('retains every advertised route and additional observations, including missing and blocked rows', () => {
    const routes = qualificationRows(plan().routes, [{ id: 'extra/bridge', qualification: 'unqualified', result: 'blocked', reason: 'unsupported controls' }]);
    expect(routes).toHaveLength(6);
    expect(routes.every(row => row.status === 'blocked')).toBe(true);
    expect(routes.find(row => row.id === 'local/http').qualification).toBe('missing');
  });
  it('refuses synthetic or unscoped qualification and preserves the reason', () => {
    const result = qualificationRows(['codex/shell'], [{ id: 'codex/shell', qualification: 'qualified', result: 'passed', evidence: { kind: 'synthetic' } }]);
    expect(result[0].status).toBe('blocked');
    expect(result[0].reason).toContain('scoped live evidence');
  });
  it('reports scoped live qualification without broadening it to another transport', () => {
    const routes = qualificationRows(['codex/shell', 'codex/bridge'], [{ id: 'codex/shell', qualification: 'qualified', result: 'passed', evidence: {
      kind: 'live', version: 'synthetic-version', account: 'opaque-account-ref', profile: 'fixture-profile', transport: 'shell', reportRef: 'fixture:report',
    } }]);
    expect(routes.map(row => [row.id, row.status])).toEqual([['codex/bridge', 'blocked'], ['codex/shell', 'qualified']]);
  });
  it('blocks a report whose transport disagrees with the advertised route', () => {
    expect(qualificationRows(['codex/shell'], [{ id: 'codex/shell', qualification: 'qualified', result: 'passed', evidence: {
      kind: 'live', version: 'synthetic-version', account: 'opaque-ref', profile: 'fixture-profile', transport: 'mcp', reportRef: 'fixture:report',
    } }])[0]).toMatchObject({ status: 'blocked', reason: expect.stringContaining('transport differs') });
  });
});
