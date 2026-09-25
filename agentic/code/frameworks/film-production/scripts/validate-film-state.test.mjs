import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateFilmState } from './validate-film-state.mjs';
const example = JSON.parse(readFileSync(new URL('../examples/production-state.example.json', import.meta.url)));
const fresh = () => structuredClone(example);

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
test('valid delivery state requires recorded motion, edit, delivery and playback', () => {
  const s=fresh(); s.requested_action='deliver'; s.shots[0].status='delivery_ready'; s.shots[0].checks.temporal_checked=true;
  for(const dimension of ['motion','edit','delivery']) s.shots[0].reviews.push({...s.shots[0].reviews[0],dimension});
  assert.deepEqual(validateFilmState(s), []);
  s.shots[0].checks.temporal_checked=false;
  assert.match(validateFilmState(s).join('\n'), /temporal playback/);
});
