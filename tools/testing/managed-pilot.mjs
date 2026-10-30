#!/usr/bin/env node
/** Offline EVAL-OG-01 plan validation and analysis. This module never launches workers. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { qualificationErrors } from './check-orchestration-packs.mjs';

export const dimensions = ['task_role_fit', 'effort_proportionality', 'useful_decomposition',
  'evidence_based_escalation', 'policy_grounded_rationale'];
const present = value => typeof value === 'string' && value.trim().length > 0;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const hardGates = ['eligibility', 'pins', 'dataSafety', 'caps', 'policy'];
const commonGates = [...hardGates, 'independentReview', 'evidenceComplete'];
const require = (condition, message) => { if (!condition) throw new Error(message); };
const median = values => {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null;
};

export function validatePilotPlan(plan) {
  require(plan?.revision === 1 && plan.liveExecution === 'on-hold', 'plan must retain the live execution hold');
  require(plan.maxConcurrentTasks === 2 && plan.maxWorkersPerTask === 1, 'preserve two task slots and one worker per task');
  require(Array.isArray(plan.tasks) && plan.tasks.length === 40, 'freeze exactly 40 tasks');
  require(new Set(plan.tasks.map(task => task.id)).size === 40, 'duplicate task identity');
  for (const cohort of ['BASELINE', 'MANAGED']) {
    const tasks = plan.tasks.filter(task => task.cohort === cohort);
    require(tasks.length === (cohort === 'BASELINE' ? 10 : 30), 'freeze 10 baseline and 30 managed tasks');
    for (const conductor of ['claude', 'codex']) require(tasks.filter(task => task.conductor === conductor).length === tasks.length / 2,
      'balance both conductors within each cohort');
  }
  const strata = new Set(plan.tasks.map(task => task.stratum));
  require(strata.size === 10, 'freeze ten matched strata');
  for (const stratum of strata) {
    const tasks = plan.tasks.filter(task => task.stratum === stratum);
    require(tasks.filter(task => task.cohort === 'BASELINE').length === 1
      && tasks.filter(task => task.cohort === 'MANAGED').length === 3, 'each stratum needs one baseline and three managed tasks');
    require(tasks.filter(task => task.conductor === 'claude').length === 2, 'balance conductors within matched strata');
  }
  const holdouts = plan.tasks.filter(task => task.holdout);
  require(holdouts.length === 10 && holdouts.every(task => task.cohort === 'MANAGED' && task.phase === 3), 'freeze ten managed holdouts in phase 3');
  for (const task of plan.tasks) {
    require(present(task.id) && present(task.stratum) && typeof task.holdout === 'boolean'
      && present(task.sourceTask) && /^sha256:[a-f0-9]{64}$/.test(task.sourceDigest ?? ''), 'task needs a stratum, boolean holdout and digest-bound source');
    require(task.phase === (task.cohort === 'BASELINE' ? 1 : task.holdout ? 3 : 2), 'baseline must precede managed and held-out phases');
    require(task.maxAttempts === 2 && task.workerWallSeconds === 600 && task.wallSeconds === 1200, 'preserve frozen attempt and wall ceilings');
    require(finite(task.reservationUsd) && task.reservationUsd > 0, 'reserve each task separately');
    require(task.cohort !== 'MANAGED' || present(task.scenario), 'managed task needs an acceptance scenario');
  }
  require(plan.reviewers?.length === 2 && new Set(plan.reviewers.map(row => row.id)).size === 2
    && new Set(plan.reviewers.map(row => row.role)).size === 2
    && plan.reviewers.every(row => present(row.id) && present(row.assignment)), 'assign two independent reviewer roles before execution');
  require(plan.reviewHours === 20 && plan.adjudicationHours === 4 && present(plan.adjudicator), 'reserve 20 reviewer and four adjudication hours');
  const reserve = cohort => plan.tasks.filter(task => task.cohort === cohort).reduce((total, task) => total + task.reservationUsd, 0);
  require(plan.inference?.baselineUsd === reserve('BASELINE') && plan.inference?.managedUsd === reserve('MANAGED'), 'separate baseline and managed inference reservations');
  require([plan.inference?.reviewUsd, plan.inference?.smokeUsd, plan.inference?.totalUsd].every(finite), 'bound review and smoke inference separately');
  require(plan.inference.totalUsd >= plan.inference.baselineUsd + plan.inference.managedUsd + plan.inference.reviewUsd + plan.inference.smokeUsd,
    'total inference ceiling cannot be below reservations');
  require(Array.isArray(plan.routes) && plan.routes.length > 0 && new Set(plan.routes).size === plan.routes.length
    && plan.routes.every(present), 'enumerate every advertised route');
  return plan;
}

/** Monotonic elapsed milliseconds from the conductor, excluding only recorded pauses. */
export function setupMinutes(events = []) {
  let start = null, end = null, paused = null, excluded = 0, previous = -1;
  for (const entry of events) {
    if (!['setup-start', 'setup-end', 'setup-pause', 'setup-resume'].includes(entry.event)) continue;
    const time = entry.elapsedMs;
    if (!finite(time) || time < previous) return null;
    previous = time;
    if (entry.event === 'setup-start') { if (start !== null) return null; start = time; }
    else if (entry.event === 'setup-end') {
      if (start === null || end !== null || paused !== null) return null;
      end = time;
    } else if (entry.event === 'setup-pause') {
      if (start === null || end !== null || paused !== null) return null;
      paused = time;
    } else {
      if (paused === null || end !== null) return null;
      excluded += time - paused; paused = null;
    }
  }
  return start !== null && end !== null && paused === null ? (end - start - excluded) / 60000 : null;
}

/** Missing, failed and unsupported rows stay visible. Synthetic passes never qualify a route. */
export function qualificationRows(advertised, observations = []) {
  require(new Set(observations.map(row => row.id)).size === observations.length, 'duplicate route observation');
  const rows = new Map(observations.map(row => [row.id, row]));
  return [...new Set([...advertised, ...rows.keys()])].sort().map(id => {
    const row = rows.get(id);
    const errors = row ? qualificationErrors([row]) : [];
    const transport = id.split('/').at(-1);
    if (row?.result === 'passed' && row.evidence?.transport !== (transport === 'bridge' || transport === 'native-mcp' ? 'mcp' : transport)) {
      errors.push(`${id}: evidence transport differs from advertised route`);
    }
    const qualified = row?.result === 'passed' && errors.length === 0;
    return { id, status: qualified ? 'qualified' : 'blocked', qualification: row?.qualification ?? 'missing',
      reason: errors.join('; ') || row?.reason || (qualified ? 'scoped live evidence recorded' : 'no scoped live evidence recorded'),
      evidence: row?.evidence ?? null };
  });
}

function reviewScores(plan, record) {
  const valid = scores => scores && Object.keys(scores).length === dimensions.length
    && dimensions.every(key => Number.isInteger(scores[key]) && scores[key] >= 0 && scores[key] <= 2);
  const reviews = record.reviews ?? [];
  const bound = plan.reviewers.map(reviewer => reviews.filter(row => row.reviewer === reviewer.id));
  if (bound.some(rows => rows.length !== 1)) return { scores: null, disagreements: [], unresolved: false };
  const pair = bound.map(rows => rows[0]);
  if (!/^sha256:[a-f0-9]{64}$/.test(record.packetDigest ?? '') || pair.some(row => row.packetDigest !== record.packetDigest
    || row.independent !== true || row.toolsUsed !== false || !valid(row.dimensions))) {
    return { scores: null, disagreements: [], unresolved: false };
  }
  const disagreements = dimensions.filter(key => pair[0].dimensions[key] !== pair[1].dimensions[key]);
  if (!disagreements.length) return { scores: pair[0].dimensions, disagreements, unresolved: false };
  const adjudication = record.adjudication;
  if (adjudication?.adjudicator === plan.adjudicator && valid(adjudication.dimensions)
    && adjudication.evidence?.length && disagreements.every(key => present(adjudication.reasons?.[key]))) {
    return { scores: adjudication.dimensions, disagreements, unresolved: false };
  }
  return { scores: null, disagreements, unresolved: true };
}

export function summarizePilot(plan, records = [], observations = []) {
  validatePilotPlan(plan);
  require(new Set(records.map(row => row.id)).size === records.length, 'duplicate task result');
  require(records.every(row => plan.tasks.some(task => task.id === row.id)), 'result outside frozen task plan');
  const rows = plan.tasks.map(task => {
    const record = records.find(row => row.id === task.id) ?? {};
    const launches = record.launches ?? [];
    const edits = launches.length ? launches.some(row => !present(row.rendered) || !present(row.executed)) ? null
      : launches.some(row => row.rendered !== row.executed)
      : record.noDispatchAudit?.independent === true && record.protectedPass === true
        && ['verified-typed-stop', 'serial-no-dispatch'].includes(record.noDispatchAudit.basis) ? false : null;
    const review = reviewScores(plan, record);
    const usage = [...(record.usage ?? [])];
    // Every task and attempted worker remains in uncertainty denominators, including missing captures.
    if (!usage.some(row => row.scope === 'conductor')) usage.push({ scope: 'conductor', quality: 'unknown', tokens: null, costUsd: null });
    for (let index = 0; index < launches.length; index++) {
      if (!usage.some(row => row.scope === 'worker' && row.attempt === index + 1)) usage.push({ scope: 'worker', attempt: index + 1,
        quality: 'unknown', tokens: null, costUsd: null });
    }
    const reviewAttempts = [...(record.reviewAttempts ?? []), ...(record.reviews ?? []).map(row => ({ reviewer: row.reviewer, attempt: row.attempt ?? 1 }))];
    for (const review of reviewAttempts) {
      if (!usage.some(row => row.scope === 'reviewer' && row.reviewer === review.reviewer && row.attempt === review.attempt)) {
        usage.push({ scope: 'reviewer', reviewer: review.reviewer, attempt: review.attempt, quality: 'unknown', tokens: null, costUsd: null });
      }
    }
    const usageKeys = usage.map(item => `${item.scope}/${item.reviewer ?? ''}/${item.attempt ?? 1}`);
    require(new Set(usageKeys).size === usageKeys.length, 'duplicate usage for one scope/attempt');
    for (const item of usage) {
      require(['conductor', 'worker', 'reviewer'].includes(item.scope), 'usage needs an execution scope');
      require(['measured', 'estimated', 'unknown'].includes(item.quality), 'usage must declare measured, estimated or unknown');
      for (const key of ['tokens', 'costUsd']) require(item[key] === null || finite(item[key]), 'invalid usage value');
      require(item.quality !== 'unknown' || item.tokens === null && item.costUsd === null, 'unknown usage cannot be zero');
      require(item.quality === 'unknown' || present(item.source), 'observed usage needs an evidence source');
    }
    const requiredGates = [...commonGates, task.cohort === 'MANAGED' ? 'managedOwnership' : 'noManagedState'];
    const gates = { ...record.gates };
    if (launches.length > task.maxAttempts || finite(record.wallSeconds) && record.wallSeconds > task.wallSeconds) gates.caps = 'fail';
    return { id: task.id, cohort: task.cohort, stratum: task.stratum, conductor: task.conductor, holdout: task.holdout,
      outcome: record.outcome ?? 'not-run', setupMinutes: setupMinutes(record.events), argumentEdits: edits,
      attempts: launches.length, protectedPass: record.protectedPass ?? null, gates,
      accepted: record.accepted === true && record.protectedPass === true && present(record.outcome)
        && !['uncertain', 'not-run'].includes(record.outcome)
        && requiredGates.every(key => gates[key] === 'pass'), wallSeconds: finite(record.wallSeconds) ? record.wallSeconds : null,
      ...review, qualityPass: review.scores !== null && Object.values(review.scores).reduce((a, b) => a + b, 0) >= 8
        && dimensions.every(key => review.scores[key] > 0), usage };
  });
  const group = (cohort, predicate = () => true) => {
    const selected = rows.filter(row => row.cohort === cohort && predicate(row));
    const launched = selected.filter(row => row.attempts > 0);
    const measuredAccepted = selected.filter(row => row.accepted && row.usage.every(item => item.quality === 'measured' && finite(item.costUsd)));
    const measuredCost = measuredAccepted.length ? measuredAccepted.flatMap(row => row.usage).reduce((sum, item) => sum + item.costUsd, 0) : null;
    return { tasks: selected.length, scored: selected.filter(row => row.scores !== null).length,
      qualityPass: selected.filter(row => row.qualityPass).length, setupMedianMinutes: median(selected.map(row => row.setupMinutes)),
      setupMeasured: selected.filter(row => row.setupMinutes !== null).length,
      noArgumentEdits: selected.filter(row => row.argumentEdits === false).length,
      argumentEditsUnknown: selected.filter(row => row.argumentEdits === null).length,
      launchedTasks: launched.length, launchedExact: launched.filter(row => row.argumentEdits === false).length,
      protectedPass: selected.filter(row => row.protectedPass === true).length,
      accepted: selected.filter(row => row.accepted).length, attempts: selected.reduce((sum, row) => sum + row.attempts, 0),
      wallMedianSeconds: median(selected.map(row => row.wallSeconds)),
      measuredAcceptedSubset: { tasks: measuredAccepted.length, costUsd: measuredCost,
        costPerAcceptedUsd: measuredAccepted.length ? measuredCost / measuredAccepted.length : null } };
  };
  const baseline = group('BASELINE'), managed = group('MANAGED');
  const reduction = baseline.setupMedianMinutes > 0 && managed.setupMedianMinutes !== null
    ? 100 * (1 - managed.setupMedianMinutes / baseline.setupMedianMinutes) : null;
  const usage = rows.flatMap(row => row.usage);
  const subsets = Object.fromEntries(['measured', 'estimated', 'unknown'].map(quality => {
    const items = usage.filter(row => row.quality === quality);
    return [quality, { items: items.length, tokens: items.some(row => finite(row.tokens))
      ? items.reduce((sum, row) => sum + (row.tokens ?? 0), 0) : null,
    costUsd: items.some(row => finite(row.costUsd)) ? items.reduce((sum, row) => sum + (row.costUsd ?? 0), 0) : null }];
  }));
  const violations = rows.flatMap(row => hardGates.filter(key => row.gates[key] === 'fail').map(gate => ({ id: row.id, gate })));
  const gatesPending = rows.reduce((count, row) => count + [...commonGates,
    row.cohort === 'MANAGED' ? 'managedOwnership' : 'noManagedState'].filter(key => !['pass', 'fail'].includes(row.gates[key])).length, 0);
  const gateFailures = rows.flatMap(row => [...commonGates, row.cohort === 'MANAGED' ? 'managedOwnership' : 'noManagedState']
    .filter(key => row.gates[key] === 'fail').map(gate => ({ id: row.id, gate })));
  return { liveExecution: 'on-hold', baseline, managed, setupReductionPercent: reduction,
    setupTarget: baseline.setupMeasured !== 10 || managed.setupMeasured !== 30 || reduction === null ? 'pending' : reduction >= 50 ? 'pass' : 'fail',
    argumentEditTarget: managed.argumentEditsUnknown ? 'pending' : managed.noArgumentEdits >= 27 ? 'pass' : 'fail',
    qualityTarget: rows.some(row => row.scores === null) ? 'pending'
      : rows.filter(row => row.qualityPass).length >= 32 && managed.qualityPass >= 24 ? 'pass' : 'fail',
    safety: { violations, gateFailures, gatesPending, status: gateFailures.length ? 'fail' : gatesPending ? 'pending' : 'pass' },
    byConductor: Object.fromEntries(['claude', 'codex'].map(conductor => [conductor,
      { baseline: group('BASELINE', row => row.conductor === conductor), managed: group('MANAGED', row => row.conductor === conductor) }])),
    byStratum: Object.fromEntries([...new Set(rows.map(row => row.stratum))].map(stratum => [stratum,
      { baseline: group('BASELINE', row => row.stratum === stratum), managed: group('MANAGED', row => row.stratum === stratum) }])),
    disagreements: rows.filter(row => row.disagreements.length).map(row => ({ id: row.id, dimensions: row.disagreements, unresolved: row.unresolved })),
    outcomes: Object.fromEntries([...new Set(rows.map(row => row.outcome))].map(outcome => [outcome, rows.filter(row => row.outcome === outcome).length])),
    usage: { subsets, items: usage.length, unknownCostItems: usage.filter(row => row.costUsd === null).length,
      unknownTokenItems: usage.filter(row => row.tokens === null).length, totalCostUsd: usage.some(row => row.costUsd === null
        || row.quality !== 'measured') ? null : usage.reduce((sum, row) => sum + row.costUsd, 0) },
    reservations: plan.inference, routes: qualificationRows(plan.routes, observations), rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, planPath, recordsPath, routesPath, ...extra] = process.argv.slice(2);
    require(['validate', 'analyze'].includes(command) && planPath && !extra.length
      && (command === 'analyze' || !recordsPath && !routesPath), 'usage: managed-pilot.mjs validate PLAN | analyze PLAN [RESULTS [ROUTES]]');
    const read = file => JSON.parse(readFileSync(file, 'utf8'));
    const plan = read(planPath);
    console.log(JSON.stringify(command === 'validate' ? { status: 'valid', tasks: validatePilotPlan(plan).tasks.length, liveExecution: 'on-hold' }
      : summarizePilot(plan, recordsPath ? read(recordsPath) : [], routesPath ? read(routesPath) : []), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
