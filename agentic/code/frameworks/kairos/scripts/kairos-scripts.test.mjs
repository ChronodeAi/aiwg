import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bhThreshold, evaluateBundle } from './kairos-gates.mjs';
import { fileableErrors, fingerprintOf, validateRecord } from './kairos-records.mjs';

const load = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const policy = load('../config/gate-policy.json');
const bundle = () => structuredClone(load('../examples/evidence-bundle.example.json'));
const evaluate = (b) => evaluateBundle(b, policy, { recordedAt: '2026-09-26T12:00:00Z' });
const edge = (result, id) => result.edges.find((e) => e.edge_id === id);
const gate = (e, id) => e.gates.find((g) => g.id === id);
const PROMOTE = 'edge-evm.leader-signal.causes.follower-fill';
const DISAGREE = 'edge-evm.gas-spike.causes.fill-slippage';
const HOLD = 'edge-evm.funding-rate.causes.leader-exit';

test('example bundle: promote after K passes, escalate on disagreement, hold weak evidence', () => {
  const r = evaluate(bundle());
  assert.equal(edge(r, PROMOTE).decision, 'auto_promote');
  assert.equal(edge(r, DISAGREE).decision, 'escalate');
  assert.deepEqual(edge(r, DISAGREE).escalation_reasons, ['gate_disagreement']);
  assert.equal(edge(r, HOLD).decision, 'hold_candidate');
  assert.equal(gate(edge(r, HOLD), 'EA-G6').status, 'not_available');
  assert.equal(gate(edge(r, HOLD), 'EA-G6').pass, null);
});

test('Benjamini-Hochberg keeps the largest p(k) under k/m*q and honours a larger family', () => {
  assert.deepEqual(bhThreshold([0.01, 0.02, 0.03, 0.2], 0.05), { threshold: 0.03, m: 4 });
  assert.equal(bhThreshold([0.03], 0.05, 1).threshold, 0.03);
  assert.equal(bhThreshold([0.03], 0.05, 10).threshold, -1);
});

test('a new candidate needs K consecutive passing evaluations before promotion', () => {
  const b = bundle();
  edge(b, PROMOTE).history = [{ all_required_pass: true }];
  const e = edge(evaluate(b), PROMOTE);
  assert.equal(gate(e, 'EA-G7').pass, false);
  assert.equal(e.decision, 'hold_candidate');
  assert.equal(e.history_entry.all_required_pass, true);
});

test('walk-forward rejects look-ahead and evaluation on a proposal source', () => {
  const lookAhead = bundle();
  edge(lookAhead, PROMOTE).walk_forward.windows[1].train_end = '2026-07-20T00:00:00Z';
  assert.match(gate(edge(evaluate(lookAhead), PROMOTE), 'EA-G5').detail, /look-ahead/);

  const circular = bundle();
  const e = edge(circular, PROMOTE);
  e.walk_forward.windows[0].snapshot_sha256 = e.proposal_sources_sha256[0];
  const g = gate(edge(evaluate(circular), PROMOTE), 'EA-G5');
  assert.equal(g.pass, false);
  assert.match(g.detail, /circular/);
});

test('a statistic not allowed for the data provenance fails the FDR gate', () => {
  const b = bundle();
  edge(b, PROMOTE).statistic.name = 'welch_t';
  assert.match(gate(edge(evaluate(b), PROMOTE), 'EA-G3').detail, /not allowed for observational/);
});

test('block stability fails when one regime flips sign by majority', () => {
  const b = bundle();
  edge(b, PROMOTE).blocks = [
    { regime: 'calm', effect: 0.02 }, { regime: 'calm', effect: 0.03 }, { regime: 'calm', effect: 0.01 },
    { regime: 'calm', effect: 0.02 }, { regime: 'calm', effect: 0.02 }, { regime: 'calm', effect: 0.02 },
    { regime: 'stress', effect: -0.01 }, { regime: 'stress', effect: -0.02 }, { regime: 'stress', effect: 0.01 },
  ];
  const g = gate(edge(evaluate(b), PROMOTE), 'EA-G4');
  assert.equal(g.pass, false);
  assert.deepEqual(g.value.flipped_regimes, ['stress']);
});

test('live-money edges escalate only when the evidence would otherwise promote them', () => {
  const passing = bundle();
  edge(passing, PROMOTE).touches_live_money = true;
  const e = edge(evaluate(passing), PROMOTE);
  assert.equal(e.decision, 'escalate');
  assert.deepEqual(e.escalation_reasons, ['live_money_or_policy']);

  const failing = bundle();
  edge(failing, HOLD).touches_live_money = true;
  assert.equal(edge(evaluate(failing), HOLD).decision, 'hold_candidate');
});

test('active edges escalate on a sign flip and demote after K consecutive failures', () => {
  const flip = bundle();
  Object.assign(edge(flip, PROMOTE), { current_status: 'active', active_sign: 'negative' });
  assert.deepEqual(edge(evaluate(flip), PROMOTE).escalation_reasons, ['sign_flip_on_active_edge']);

  const decay = bundle();
  Object.assign(edge(decay, HOLD), { current_status: 'active', history: [{ all_required_pass: false }, { all_required_pass: false }] });
  assert.equal(edge(evaluate(decay), HOLD).decision, 'auto_demote');
  edge(decay, HOLD).history = [{ all_required_pass: false }];
  assert.equal(edge(evaluate(decay), HOLD).decision, 'keep_active');
});

test('record examples validate and the finding is fileable', () => {
  for (const name of ['review-packet', 'finding', 'connection-record', 'edge-proposal']) {
    assert.deepEqual(validateRecord(load(`../examples/${name}.example.json`)), [], name);
  }
  assert.deepEqual(fileableErrors(load('../examples/finding.example.json')), []);
});

test('findings: fingerprint is recomputed and filing needs open status with a real difference', () => {
  const f = load('../examples/finding.example.json');
  assert.equal(fingerprintOf(f).fingerprint, f.fingerprint);
  const withSignatures = { ...f, assertion_signatures: ['resolve:nonempty:$.trace'] };
  assert.notEqual(fingerprintOf(withSignatures).fingerprint, f.fingerprint);
  assert.match(validateRecord({ ...f, expected: 'something else' }).join('\n'), /does not match the recomputed/);
  assert.match(fileableErrors({ ...f, status: 'wont_file', triage_note: 'known' }).join('\n'), /only open findings/);
  const same = { ...f, observed: f.expected };
  assert.match(fileableErrors(same).join('\n'), /identical/);
  assert.match(validateRecord({ ...f, status: 'filed' }).join('\n'), /issue/);
});

test('connection records and packets refuse credentials and unsigned approvals', () => {
  const c = load('../examples/connection-record.example.json');
  c.auth.token_source = 'Authorization: Bearer eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJkaWQ6cHJpdnkifQ.c2lnbmF0dXJlLXZhbHVl';
  assert.match(validateRecord(c).join('\n'), /JWT/);

  const p = load('../examples/review-packet.example.json');
  p.decision.outcome = 'approve';
  assert.match(validateRecord(p).join('\n'), /human_go_signoff/);
});
