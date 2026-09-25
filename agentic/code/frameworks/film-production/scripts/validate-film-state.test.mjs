import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { validateFilmState } from './validate-film-state.mjs';
const example = JSON.parse(readFileSync(new URL('../examples/production-state.example.json', import.meta.url)));
const fresh = () => structuredClone(example);
const H = c => c.repeat(64);
const deliverable = () => {
  const s = fresh(); s.requested_action = 'deliver';
  const one = s.shots[0]; one.status = 'delivery_ready'; one.checks.temporal_checked = true;
  for (const dimension of ['motion', 'edit', 'delivery']) one.reviews.push({ ...one.reviews[0], dimension, checklist_version: 1 });
  Object.assign(one.events[0], { observed_count: 1, observed_evidence: 'observed at frame 42 of the review render' });
  const two = structuredClone(one); two.id = 'FP-SHOT-002'; two.events[0].id = 'FP-EVENT-002'; s.shots.push(two);
  s.timeline = { id: 'FP-TL-001', version: 'v1', sha256: H('d'), shot_order: ['FP-SHOT-001', 'FP-SHOT-002'] };
  s.cuts = [{ id: 'FP-CUT-001', out_shot: 'FP-SHOT-001', out_version: 'v1', in_shot: 'FP-SHOT-002', in_version: 'v1', carried_states: ['receiver in right hand'], defects: [],
    reviews: [{ method: 'playback', context_seconds: 1, timeline_sha256: H('d'), checklist_version: 1, decision: 'accepted', reviewer: 'synthetic-fixture', reviewer_type: 'agent', evidence: 'played 1 s either side, then frame-stepped the join' }] }];
  s.audio_elements = [{ id: 'FP-CUE-001', kind: 'foley', measured_by: 'ffmpeg astats', qc: 'pass', noise_floor_dbfs: -70, noise_floor_limit_dbfs: -60, spectral_flatness: 0.1, spectral_flatness_limit: 0.3 }];
  const sign = { status: 'locked', subject_sha256: H('d'), reviewer: 'synthetic-fixture', reviewer_type: 'user', evidence: 'recorded sign-off reference' };
  s.locks.picture = { ...sign }; s.locks.sound = { ...sign };
  return s;
};
const errorsOf = s => validateFilmState(s).join('\n');

test('synthetic ready shot permits review without authorizing generation', () => {
  assert.deepEqual(validateFilmState(fresh()), []);
});
test('generation while paused is blocked even with budget', () => {
  const s = fresh(); s.production_status = 'paused'; s.requested_action = 'generate';
  s.authority = { generation_allowed: true, currency: 'USD', remaining: 5, next_estimate: 3 };
  assert.match(validateFilmState(s).join('\n'), /active production/);
});
test('old blocking approval cannot clear missing current visual-quality approval', () => {
  const s = fresh(); s.shots[0].reviews[1].shot_version = 'old';
  assert.match(validateFilmState(s).join('\n'), /visual_quality acceptance/);
});
test('known major defect blocks an otherwise approved promotion', () => {
  const s = fresh(); s.shots[0].defects.push({ id: 'double-handle', severity: 'major', status: 'open' });
  assert.match(validateFilmState(s).join('\n'), /unresolved blocking defect/);
});
test('recorded second receiver fails object-count regression check', () => {
  const s = fresh(); s.shots[0].checks.object_counts[0].observed = 2;
  assert.match(validateFilmState(s).join('\n'), /object count mismatch/);
});
test('a blocking guide cannot be promoted as the primary quality master', () => {
  const s = fresh(); s.assets[0].role = 'blocking_guide';
  assert.match(validateFilmState(s).join('\n'), /accepted quality master/);
});
test('stale input hash and missing asset are rejected', () => {
  const s = fresh(); s.shots[0].input_assets[0].sha256 = 'b'.repeat(64);
  assert.match(validateFilmState(s).join('\n'), /stale input hash/);
  s.shots[0].input_assets[0].id = 'missing';
  assert.match(validateFilmState(s).join('\n'), /unknown input/);
});
test('current rejection overrides earlier acceptance for the same dimension', () => {
  const s = fresh(); s.shots[0].reviews.push({ ...s.shots[0].reviews[1], decision: 'rejected' });
  assert.match(validateFilmState(s).join('\n'), /visual_quality acceptance/);
});
test('motion acceptance requires playback and motion evidence', () => {
  const s = fresh(); s.shots[0].status = 'accepted';
  const errors = validateFilmState(s).join('\n');
  assert.match(errors, /temporal playback/); assert.match(errors, /motion acceptance/);
});
test('estimate outside authority fails without spending', () => {
  const s = fresh(); s.requested_action = 'generate';
  s.authority = { generation_allowed: true, currency: 'USD', remaining: 2, next_estimate: 3 };
  assert.match(validateFilmState(s).join('\n'), /exceeds remaining/);
});
test('candidate can retain a known defect but cannot deliver', () => {
  const s = fresh(); s.shots[0].status = 'held'; s.shots[0].defects.push({ id: 'contact', severity: 'blocker', status: 'open' });
  assert.deepEqual(validateFilmState(s), []);
  s.requested_action = 'deliver'; assert.match(validateFilmState(s).join('\n'), /delivery_ready/);
});
test('malformed top-level and collection data returns diagnostics', () => {
  assert.ok(validateFilmState(null).length); assert.ok(validateFilmState({}).length);
  const s = fresh(); s.assets.push(null); s.shots.push(null); assert.ok(validateFilmState(s).length);
});
test('null shots return diagnostics for generation and delivery instead of throwing', () => {
  for (const requested_action of ['generate', 'deliver']) {
    const s = fresh(); s.requested_action = requested_action; s.shots = [null];
    assert.doesNotThrow(() => validateFilmState(s));
    assert.match(validateFilmState(s).join('\n'), /shot must be an object/);
  }
});
test('required authority and nested record shapes are checked even while held', () => {
  for (const mutate of [
    s => delete s.authority,
    s => { s.authority.generation_allowed = 'false'; },
    s => { s.authority.remaining = -1; },
    s => { s.assets = [[]]; },
    s => { s.shots[0].reviews = [null]; },
    s => { s.shots[0].input_assets = [null]; },
    s => { s.shots[0].defects = [null]; },
    s => { s.shots[0].checks = null; },
    s => { s.shots[0].checks.object_counts = [null]; },
  ]) {
    const s = fresh(); s.shots[0].status = 'held'; mutate(s);
    assert.doesNotThrow(() => validateFilmState(s));
    assert.ok(validateFilmState(s).length > 0);
  }
});
test('swapping a source invalidates prior acceptance even when shot version is unchanged', () => {
  const s = fresh();
  s.assets[0].sha256 = 'b'.repeat(64); s.shots[0].input_assets[0].sha256 = s.assets[0].sha256;
  assert.match(validateFilmState(s).join('\n'), /stale visual_quality review input hashes/);
});
test('adding or removing an input requires a new matching review', () => {
  const s = fresh();
  s.assets.push({...s.assets[0], id:'new-reference'});
  s.shots[0].input_assets.push({id:'new-reference',sha256:s.assets[1].sha256,usage:'identity_reference'});
  assert.match(validateFilmState(s).join('\n'), /review input hashes/);
  const removed = fresh();
  removed.shots[0].reviews.forEach(r => {r.input_hashes['removed-reference']='b'.repeat(64);});
  assert.match(validateFilmState(removed).join('\n'), /review input hashes/);
});
test('explicit user review cannot be satisfied by an agent review', () => {
  const s = fresh(); s.shots[0].required_user_dimensions = ['visual_quality'];
  assert.match(validateFilmState(s).join('\n'), /current user visual_quality acceptance evidence missing/);
  s.shots[0].reviews.push({...s.shots[0].reviews[1], reviewer_type:'user', reviewer:'recorded-user', evidence:'recorded user response reference'});
  assert.deepEqual(validateFilmState(s), []);
});
test('no user review gate is introduced when no such requirement was recorded', () => {
  const s = fresh(); delete s.shots[0].required_user_dimensions;
  assert.deepEqual(validateFilmState(s), []);
});
test('agent acceptance cannot erase a current user rejection', () => {
  const s=fresh(); s.shots[0].required_user_dimensions=['visual_quality'];
  s.shots[0].reviews.push({...s.shots[0].reviews[1],reviewer_type:'user',decision:'rejected'});
  s.shots[0].reviews.push({...s.shots[0].reviews[1],reviewer_type:'agent',decision:'accepted'});
  assert.match(validateFilmState(s).join('\n'), /current user visual_quality acceptance evidence missing/);
});
test('stale user acceptance cannot approve changed inputs', () => {
  const s=fresh(); s.shots[0].required_user_dimensions=['visual_quality'];
  s.shots[0].reviews.push({...s.shots[0].reviews[1],reviewer_type:'user',input_hashes:{'FP-ASSET-MASTER':'b'.repeat(64)}});
  s.shots[0].reviews.push({...s.shots[0].reviews[1],reviewer_type:'agent'});
  assert.match(validateFilmState(s).join('\n'), /current user visual_quality acceptance evidence missing/);
});
test('open minor defects may promote only with their residual disclosed', () => {
  const s=fresh(); const defect={id:'grain',severity:'minor',status:'open'}; s.shots[0].defects.push(defect);
  assert.match(validateFilmState(s).join('\n'), /minor defect disclosure/);
  defect.disclosure='Minor grain remains visible in the background crop.';
  assert.deepEqual(validateFilmState(s), []);
});
test('accepted exceptions require current disposition and explicit reason and authority', () => {
  const s=fresh(); const defect={id:'intentional-distortion',severity:'major',status:'accepted_exception'}; s.shots[0].defects.push(defect);
  assert.match(validateFilmState(s).join('\n'), /exception reason and authority/);
  Object.assign(defect,{shot_version:'v1',disposition_evidence:'review record reference',disposition_reviewer:'recorded-user',exception_reason:'Explicit intentional dream distortion',authority_reference:'recorded user decision reference',exception_basis:'intentional'});
  assert.deepEqual(validateFilmState(s), []);
  defect.shot_version='old'; assert.match(validateFilmState(s).join('\n'), /stale defect disposition/);
});
test('resolved defect requires evidence instead of a bare status change', () => {
  const s=fresh(); s.shots[0].defects.push({id:'contact',severity:'major',status:'resolved'});
  assert.match(validateFilmState(s).join('\n'), /defect disposition evidence/);
});
test('delivery requires delivery_ready shots with motion, edit, delivery and playback', () => {
  const s = deliverable();
  assert.deepEqual(validateFilmState(s), []);
  s.shots[0].checks.temporal_checked = false;
  assert.match(errorsOf(s), /temporal playback/);
});
test('delivery requires valid picture and sound locks', () => {
  const s = deliverable(); delete s.locks.sound;
  assert.match(errorsOf(s), /valid sound lock/);
  const p = deliverable(); p.locks.picture.status = 'open';
  const errors = errorsOf(p);
  assert.match(errors, /valid picture lock/); assert.match(errors, /sound lock requires a valid picture lock/);
});
test('generation requires a coverage lock, and only an authorized waiver replaces it', () => {
  const s = fresh(); s.requested_action = 'generate';
  s.authority = { generation_allowed: true, currency: 'USD', remaining: 5, next_estimate: 1 };
  assert.deepEqual(validateFilmState(s), []);
  s.locks.coverage.status = 'open';
  assert.match(errorsOf(s), /coverage lock/);
  s.locks.coverage = { status: 'waived' };
  assert.match(errorsOf(s), /waiver needs reason and authority_reference/);
  Object.assign(s.locks.coverage, { reason: 'single-shot piece', authority_reference: 'recorded user decision reference' });
  assert.deepEqual(validateFilmState(s), []);
});
test('eliding a required beat is a scope change needing authority', () => {
  const s = fresh(); Object.assign(s.beats[0], { treatment: 'elided', event_refs: [] });
  assert.match(errorsOf(s), /scope change/);
  s.beats[0].scope_change = { reason: 'shown by sound only', authority_reference: 'recorded user decision reference' };
  assert.deepEqual(validateFilmState(s), []);
  const missing = fresh(); missing.beats[0].event_refs = ['FP-SHOT-001#nope'];
  assert.match(errorsOf(missing), /unknown event/);
});
test('accepted motion needs a recorded event walk with matching counts', () => {
  const s = deliverable(); delete s.shots[0].events[0].observed_evidence;
  assert.match(errorsOf(s), /walk not recorded/);
  const doubled = deliverable(); doubled.shots[0].events[0].observed_count = 2;
  assert.match(errorsOf(doubled), /event count mismatch FP-EVENT-001/);
  doubled.shots[0].defects.push({ id: 'double', severity: 'major', status: 'accepted_exception', affects_event: 'FP-EVENT-001', shot_version: 'v1',
    disposition_evidence: 'review record reference', disposition_reviewer: 'recorded-user', exception_reason: 'intentional repeated gag', authority_reference: 'recorded user decision reference', exception_basis: 'intentional' });
  assert.deepEqual(validateFilmState(doubled), []);
});
test('a defect on a required beat event cannot ship as a disclosed minor residual', () => {
  const s = deliverable();
  s.shots[0].defects.push({ id: 'offscreen', severity: 'minor', status: 'open', affects_event: 'FP-EVENT-001', disclosure: 'action happens off-screen' });
  assert.match(errorsOf(s), /cannot ship as a minor residual/);
});
test('a still-image cut review cannot pass picture lock', () => {
  const s = deliverable(); s.cuts[0].reviews.push({ ...s.cuts[0].reviews[0], method: 'stills' });
  assert.match(errorsOf(s), /still-image review cannot pass a cut/);
  const short = deliverable(); short.cuts[0].reviews[0].context_seconds = 0.2;
  assert.match(errorsOf(short), /at least 1 s context/);
});
test('every adjacent timeline pair needs exactly one cut record', () => {
  const s = deliverable(); s.cuts = [];
  assert.match(errorsOf(s), /exactly one cut record required for FP-SHOT-001>FP-SHOT-002/);
});
test('a changed timeline makes locks and cut reviews stale', () => {
  const s = deliverable(); s.timeline.sha256 = H('e');
  const errors = errorsOf(s);
  assert.match(errors, /picture lock: stale against current timeline/);
  assert.match(errors, /cut FP-CUT-001: review is stale/);
});
test('a changed shot version reopens its cut review', () => {
  const s = deliverable(); s.cuts[0].in_version = 'v0';
  assert.match(errorsOf(s), /shot versions changed since cut review/);
});
test('an escaped defect class makes earlier shot and cut reviews stale', () => {
  const s = deliverable();
  s.checklist = { version: 2, classes: [{ id: 'double-press', source_defect: 'user note reference', added_in_version: 2 }] };
  const errors = errorsOf(s);
  assert.match(errors, /motion review predates checklist version 2/);
  assert.match(errors, /cut FP-CUT-001: review predates checklist version 2/);
});
test('sound lock rejects unapproved beds and noisy clips', () => {
  const s = deliverable(); s.audio_elements.push({ ...s.audio_elements[0], id: 'FP-CUE-BED', kind: 'bed' });
  assert.match(errorsOf(s), /continuous bed needs approval reference/);
  s.audio_elements[1].bed_approval_reference = 'recorded user decision reference';
  assert.deepEqual(validateFilmState(s), []);
  s.audio_elements[0].noise_floor_dbfs = -40;
  assert.match(errorsOf(s), /noise floor missing or above limit/);
  const flat = deliverable(); flat.audio_elements[0].spectral_flatness = 0.6;
  assert.match(errorsOf(flat), /spectral flatness/);
});
test('a conditional lock must close its conditions by the named gate', () => {
  const s = deliverable(); s.locks.picture.conditions = [{ id: 'reshoot-insert', closes_by: 'delivery', status: 'open' }];
  assert.match(errorsOf(s), /picture lock condition reshoot-insert must close before delivery/);
  Object.assign(s.locks.picture.conditions[0], { status: 'closed', closure_evidence: 'review record reference' });
  assert.deepEqual(validateFilmState(s), []);
});
test('a required user lock cannot be signed by the agent', () => {
  const s = deliverable(); s.required_user_locks = ['sound']; s.locks.sound.reviewer_type = 'agent';
  assert.match(errorsOf(s), /sound lock: user sign-off required/);
});
const fixture = path => JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url)));
const invalidExpectations = {
  'missing-shot-events.json': /schema: \/shots\/1 must have required property 'events'/,
  'stills-cut-review.json': /still-image review cannot pass a cut/,
  'generation-without-coverage-lock.json': /coverage lock/,
  'unapproved-bed.json': /continuous bed needs approval reference/,
};
test('the example and every valid fixture pass schema and gate checks', () => {
  assert.deepEqual(validateFilmState(example), []);
  for (const name of readdirSync(new URL('../fixtures/valid/', import.meta.url))) assert.deepEqual(validateFilmState(fixture(`valid/${name}`)), [], name);
});
test('every invalid fixture fails for its documented reason', () => {
  const names = readdirSync(new URL('../fixtures/invalid/', import.meta.url));
  assert.deepEqual(names.sort(), Object.keys(invalidExpectations).sort());
  for (const name of names) assert.match(errorsOf(fixture(`invalid/${name}`)), invalidExpectations[name], name);
});
test('schema shape errors are reported, not just gate errors', () => {
  const s = fresh(); s.shots[0].events[0].expected_count = 'one';
  assert.match(errorsOf(s), /schema: \/shots\/0\/events\/0\/expected_count must be integer/);
});
