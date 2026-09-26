#!/usr/bin/env node
/**
 * Client-side evidence admission gates for Kairos candidate edges.
 *
 * Kairos 2.1.1 does not enforce the ADR-0034 gate stack (unit U34-C is
 * Proposed), so this framework computes it before any edge is written to the
 * node. Input: an evidence bundle (kairos_evidence_bundle/v1). Output: a gate
 * evaluation (kairos_gate_evaluation/v1) with one decision per edge:
 * auto_promote, escalate, hold_candidate, keep_active or auto_demote.
 *
 * Usage: node kairos-gates.mjs <evidence-bundle.json> [--policy <gate-policy.json>]
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True when run as a script; realpath handles symlinked paths such as macOS /tmp. */
function isMainModule() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

const DEFAULT_POLICY_URL = new URL('../config/gate-policy.json', import.meta.url);

export const GATES = [
  ['EA-G1', 'baseline_margin'],
  ['EA-G2', 'proposer_agreement'],
  ['EA-G3', 'fdr_statistic'],
  ['EA-G4', 'block_stability'],
  ['EA-G5', 'walk_forward'],
  ['EA-G6', 'interventional'],
  ['EA-G7', 'hysteresis'],
];

/** What the node enforces today for each client-side gate (Kairos 2.1.1). */
export const KAIROS_ENFORCEMENT = {
  version: '2.1.1',
  gate_stack: 'not_enforced',
  basis: 'ADR-0034 U34-C (gate stack) is Proposed; only U34-A (an LLM may propose, never admit) is Accepted. Kairos has no candidate/active edge status (U34-B ACCEPT-LATER), so a written vector is live for resolution.',
  enforced_by_node: [
    'adaptive admission: learned weight >= 0.618 on a point estimate (src/neural/resolver.py:29-34)',
    'causal admission: parameter match and not blocked by an intervention (src/causal/resolver.py:6-18)',
    'weights below 0.382 collapse to 0 on create (src/server/models/vector.py:54-72)',
  ],
};

const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const signOf = (x) => (x > 0 ? 'positive' : x < 0 ? 'negative' : 'zero');
const time = (v) => (typeof v === 'string' ? Date.parse(v) : Number.NaN);

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Benjamini-Hochberg: the largest p(k) with p(k) <= k/m * q, or -1 when none passes. */
export function bhThreshold(pValues, q, familySize = pValues.length) {
  const m = Math.max(familySize, pValues.length);
  const sorted = [...pValues].filter(num).sort((a, b) => a - b);
  let threshold = -1;
  sorted.forEach((p, i) => {
    if (p <= ((i + 1) / m) * q) threshold = p;
  });
  return { threshold, m };
}

function gate(id, name, status, value, threshold, detail) {
  const pass = status === 'pass' ? true : status === 'not_available' ? null : false;
  return { id, name, status, pass, value, threshold, detail, enforced_by: 'client' };
}

function baselineMargin(edge, policy) {
  const b = edge.baseline_margin;
  const t = policy.baseline_margin;
  const threshold = { min_margin: t.min_margin, strict: t.strict };
  if (!record(b) || !num(b.model) || !num(b.baseline) || typeof b.higher_is_better !== 'boolean') {
    return gate('EA-G1', 'baseline_margin', 'insufficient', null, threshold, 'baseline_margin needs numeric model and baseline and a boolean higher_is_better');
  }
  const margin = b.higher_is_better ? b.model - b.baseline : b.baseline - b.model;
  const ok = t.strict ? margin > t.min_margin : margin >= t.min_margin;
  return gate('EA-G1', 'baseline_margin', ok ? 'pass' : 'fail', { metric: b.metric ?? null, margin }, threshold,
    `model ${b.model} vs naive baseline ${b.baseline} (${b.higher_is_better ? 'higher' : 'lower'} is better)`);
}

function proposerAgreement(edge, policy) {
  const t = policy.proposer_agreement;
  const proposers = Array.isArray(edge.proposers) ? edge.proposers.filter(record) : [];
  const consulted = new Set(proposers.map((p) => p.family).filter(Boolean));
  const agreeing = new Set(proposers.filter((p) => p.proposes === true && p.sign === edge.sign).map((p) => p.family).filter(Boolean));
  const value = { consulted: consulted.size, agreeing: agreeing.size, families: [...agreeing].sort() };
  if (consulted.size < t.min_families_consulted) {
    return gate('EA-G2', 'proposer_agreement', 'insufficient', value, t, `${consulted.size} proposer families consulted; ${t.min_families_consulted} required`);
  }
  const ok = agreeing.size >= t.min_families_agreeing;
  return gate('EA-G2', 'proposer_agreement', ok ? 'pass' : 'fail', value, t, `${agreeing.size} of ${consulted.size} families propose the edge with sign ${edge.sign}`);
}

function fdrStatistic(edge, policy, bh) {
  const s = edge.statistic;
  const t = policy.fdr;
  const threshold = { method: t.method, q: t.q, bh_threshold: bh.threshold, m: bh.m };
  if (!record(s) || !num(s.p_value) || typeof s.name !== 'string' || typeof s.data_provenance !== 'string') {
    return gate('EA-G3', 'fdr_statistic', 'insufficient', null, threshold, 'statistic needs name, data_provenance and a numeric p_value');
  }
  const allowed = t.allowed_statistics[s.data_provenance] ?? [];
  if (!allowed.includes(s.name)) {
    return gate('EA-G3', 'fdr_statistic', 'fail', { name: s.name, p_value: s.p_value }, threshold,
      `statistic ${s.name} is not allowed for ${s.data_provenance} data (allowed: ${allowed.join(', ') || 'none'})`);
  }
  const ok = bh.threshold >= 0 && s.p_value <= bh.threshold;
  return gate('EA-G3', 'fdr_statistic', ok ? 'pass' : 'fail', { name: s.name, p_value: s.p_value }, threshold,
    ok ? `p ${s.p_value} within the Benjamini-Hochberg cut over ${bh.m} hypotheses` : `p ${s.p_value} above the Benjamini-Hochberg cut over ${bh.m} hypotheses`);
}

function blockStability(edge, policy) {
  const t = policy.block_stability;
  const blocks = Array.isArray(edge.blocks) ? edge.blocks.filter((b) => record(b) && num(b.effect)) : [];
  if (blocks.length < t.min_blocks) {
    return gate('EA-G4', 'block_stability', 'insufficient', { blocks: blocks.length }, t, `${blocks.length} blocks with a numeric effect; ${t.min_blocks} required`);
  }
  const same = blocks.filter((b) => signOf(b.effect) === edge.sign).length;
  const fraction = same / blocks.length;
  const flipped = [];
  if (t.forbid_regime_majority_flip) {
    const regimes = new Map();
    for (const b of blocks) {
      if (!b.regime) continue;
      const r = regimes.get(b.regime) ?? { same: 0, total: 0 };
      r.total += 1;
      if (signOf(b.effect) === edge.sign) r.same += 1;
      regimes.set(b.regime, r);
    }
    for (const [regime, r] of regimes) if (r.total >= 2 && r.same * 2 < r.total) flipped.push(regime);
  }
  const ok = fraction >= t.min_same_sign_fraction && flipped.length === 0;
  const detail = flipped.length > 0
    ? `effect sign flips in regime(s) ${flipped.sort().join(', ')}`
    : `${same} of ${blocks.length} blocks share sign ${edge.sign}`;
  return gate('EA-G4', 'block_stability', ok ? 'pass' : 'fail', { same_sign_fraction: fraction, flipped_regimes: flipped }, t, detail);
}

function walkForward(edge, policy) {
  const t = policy.walk_forward;
  const wf = edge.walk_forward;
  const windows = record(wf) && Array.isArray(wf.windows) ? wf.windows.filter(record) : [];
  if (windows.length < t.min_windows || typeof wf?.higher_is_better !== 'boolean') {
    return gate('EA-G5', 'walk_forward', 'insufficient', { windows: windows.length }, t, `${windows.length} walk-forward windows; ${t.min_windows} required, with higher_is_better`);
  }
  const problems = [];
  const proposalHashes = new Set(Array.isArray(edge.proposal_sources_sha256) ? edge.proposal_sources_sha256 : []);
  let previousTestStart = Number.NEGATIVE_INFINITY;
  let wins = 0;
  let marginSum = 0;
  windows.forEach((w, i) => {
    const trainEnd = time(w.train_end);
    const testStart = time(w.test_start);
    const testEnd = time(w.test_end);
    if (![trainEnd, testStart, testEnd].every(Number.isFinite)) problems.push(`window ${i}: train_end, test_start and test_end must be ISO timestamps`);
    else {
      if (!(trainEnd < testStart)) problems.push(`window ${i}: look-ahead (train_end is not before test_start)`);
      if (!(testStart <= testEnd)) problems.push(`window ${i}: test_start after test_end`);
      if (testStart < previousTestStart) problems.push(`window ${i}: windows are not in time order`);
      previousTestStart = testStart;
    }
    if (typeof w.snapshot_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(w.snapshot_sha256)) problems.push(`window ${i}: snapshot_sha256 missing (point-in-time data must be hashed)`);
    else if (t.require_disjoint_from_proposal_sources && proposalHashes.has(w.snapshot_sha256)) problems.push(`window ${i}: evaluation snapshot was a proposal source (circular)`);
    if (!num(w.model) || !num(w.baseline)) problems.push(`window ${i}: model and baseline must be numeric`);
    else {
      const margin = wf.higher_is_better ? w.model - w.baseline : w.baseline - w.model;
      marginSum += margin;
      if (margin > 0) wins += 1;
    }
  });
  const winFraction = wins / windows.length;
  const meanMargin = marginSum / windows.length;
  if (winFraction < t.min_win_fraction) problems.push(`model beats the naive baseline in ${wins} of ${windows.length} windows`);
  if (t.require_positive_mean_margin && !(meanMargin > 0)) problems.push(`mean margin ${meanMargin} is not positive`);
  const ok = problems.length === 0;
  return gate('EA-G5', 'walk_forward', ok ? 'pass' : 'fail', { windows: windows.length, win_fraction: winFraction, mean_margin: meanMargin }, t,
    ok ? `out-of-sample win fraction ${winFraction.toFixed(2)} across ${windows.length} point-in-time windows` : problems.join('; '));
}

function interventional(edge, policy) {
  const t = policy.interventional;
  const iv = edge.interventional;
  if (!record(iv) || iv.available !== true) {
    return gate('EA-G6', 'interventional', 'not_available', null, t,
      'no randomized intervention data; recorded as a product gap: Kairos observation receipts carry no propensity or randomness_key (API.md:796-797)');
  }
  const problems = [];
  if (!Number.isInteger(iv.n_treated) || !Number.isInteger(iv.n_control) || iv.n_treated < t.min_units_per_arm || iv.n_control < t.min_units_per_arm) {
    problems.push(`each arm needs at least ${t.min_units_per_arm} units`);
  }
  if (!num(iv.p_value) || iv.p_value > t.alpha) problems.push(`p ${iv.p_value} above alpha ${t.alpha}`);
  if (!num(iv.effect) || signOf(iv.effect) !== edge.sign) problems.push(`interventional effect sign ${num(iv.effect) ? signOf(iv.effect) : 'unknown'} contradicts proposed sign ${edge.sign}`);
  const ok = problems.length === 0;
  return gate('EA-G6', 'interventional', ok ? 'pass' : 'fail', { design: iv.design ?? null, effect: iv.effect ?? null, p_value: iv.p_value ?? null }, t,
    ok ? `${iv.design ?? 'randomized intervention'} confirms sign ${edge.sign}` : problems.join('; '));
}

function hysteresis(edge, policy, currentPass) {
  const k = policy.hysteresis.k_consecutive;
  const history = Array.isArray(edge.history) ? edge.history.filter(record).map((h) => h.all_required_pass === true) : [];
  history.push(currentPass);
  let run = 0;
  for (let i = history.length - 1; i >= 0 && history[i]; i -= 1) run += 1;
  let failRun = 0;
  for (let i = history.length - 1; i >= 0 && !history[i]; i -= 1) failRun += 1;
  const ok = run >= k;
  const g = gate('EA-G7', 'hysteresis', ok ? 'pass' : 'fail', { consecutive_passes: run }, { k_consecutive: k },
    `${run} consecutive evaluation(s) with every other required gate passing; ${k} required`);
  return { gate: g, failRun, k };
}

function disagreement(gates, pairs) {
  const byId = new Map(gates.map((g) => [g.id, g]));
  return pairs.some(([a, b]) => {
    const ga = byId.get(a);
    const gb = byId.get(b);
    return typeof ga?.pass === 'boolean' && typeof gb?.pass === 'boolean' && ga.pass !== gb.pass;
  });
}

/** Evaluate one evidence bundle against a gate policy. Pure: reads nothing and writes nothing. */
export function evaluateBundle(bundle, policy, { recordedAt = new Date().toISOString(), bundleText = JSON.stringify(bundle), policyText = JSON.stringify(policy) } = {}) {
  if (!record(bundle) || bundle.schema !== 'kairos_evidence_bundle/v1' || !Array.isArray(bundle.edges)) {
    throw new Error('input must be a kairos_evidence_bundle/v1 object with an edges array');
  }
  const pValues = bundle.edges.map((e) => e?.statistic?.p_value).filter(num);
  const bh = bhThreshold(pValues, policy.fdr.q, Number.isInteger(bundle.fdr_family_size) ? bundle.fdr_family_size : pValues.length);
  const edges = bundle.edges.map((edge) => {
    if (!record(edge) || typeof edge.edge_id !== 'string' || !['positive', 'negative'].includes(edge.sign)) {
      throw new Error('every edge needs an edge_id and a sign of positive or negative');
    }
    const evidence = [
      baselineMargin(edge, policy),
      proposerAgreement(edge, policy),
      fdrStatistic(edge, policy, bh),
      blockStability(edge, policy),
      walkForward(edge, policy),
      interventional(edge, policy),
    ];
    const currentPass = evidence.every((g) => g.pass !== false);
    const hyst = hysteresis(edge, policy, currentPass);
    const gates = [...evidence, hyst.gate];
    const allRequiredPass = gates.every((g) => g.pass !== false);

    const reasons = [];
    const active = edge.current_status === 'active';
    if (disagreement(gates, policy.escalation.gate_disagreement_pairs)) reasons.push('gate_disagreement');
    if (active && edge.active_sign && edge.active_sign !== edge.sign) reasons.push('sign_flip_on_active_edge');
    if (allRequiredPass && !active) {
      if (edge.touches_live_money === true || edge.policy_touching === true) reasons.push('live_money_or_policy');
      if (edge.new_node_type === true) reasons.push('new_node_type');
      if (edge.signing_or_capital_policy === true) reasons.push('signing_or_capital_policy');
    }

    let decision;
    if (reasons.length > 0) decision = 'escalate';
    else if (active) decision = hyst.failRun >= hyst.k ? 'auto_demote' : 'keep_active';
    else decision = allRequiredPass ? 'auto_promote' : 'hold_candidate';

    return {
      edge_id: edge.edge_id,
      sign: edge.sign,
      current_status: edge.current_status ?? 'none',
      decision,
      escalation_reasons: reasons,
      current_evaluation_pass: currentPass,
      all_required_pass: allRequiredPass,
      history_entry: { evaluated_at: recordedAt, all_required_pass: currentPass },
      gates,
    };
  });
  return {
    schema: 'kairos_gate_evaluation/v1',
    recorded_at: recordedAt,
    evidence_sha256: sha256(bundleText),
    policy_sha256: sha256(policyText),
    data_snapshot: bundle.data_snapshot ?? null,
    fdr: { method: policy.fdr.method, q: policy.fdr.q, m: bh.m, bh_threshold: bh.threshold },
    kairos_enforcement: KAIROS_ENFORCEMENT,
    edges,
  };
}

function main(argv) {
  const args = argv.slice(2);
  const policyIndex = args.indexOf('--policy');
  const policyPath = policyIndex >= 0 ? args[policyIndex + 1] : null;
  const bundlePath = args.find((a, i) => !a.startsWith('--') && (policyIndex < 0 || i !== policyIndex + 1));
  if (!bundlePath) {
    process.stderr.write('usage: kairos-gates.mjs <evidence-bundle.json> [--policy <gate-policy.json>]\n');
    return 2;
  }
  const bundleText = readFileSync(bundlePath, 'utf8');
  const policyText = readFileSync(policyPath ?? DEFAULT_POLICY_URL, 'utf8');
  const result = evaluateBundle(JSON.parse(bundleText), JSON.parse(policyText), { bundleText, policyText });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (isMainModule()) {
  try {
    process.exitCode = main(process.argv);
  } catch (error) {
    process.stderr.write(`kairos-gates: ${error.message}\n`);
    process.exitCode = 1;
  }
}
