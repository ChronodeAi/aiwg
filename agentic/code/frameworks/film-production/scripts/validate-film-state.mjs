#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const promotion = new Set(['motion_ready', 'accepted', 'delivery_ready']);
const dimensions = new Set(['story', 'blocking', 'visual_quality', 'performance', 'motion', 'edit', 'delivery']);
const hash = /^[a-f0-9]{64}$/;
const text = value => typeof value === 'string' && value.trim().length > 0;
const list = value => Array.isArray(value) ? value : [];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => typeof value === 'string' && hash.test(value);

/** Check recorded evidence. This does not inspect media or grant authority. */
export function validateFilmState(state) {
  const errors = [];
  const require = (ok, message) => { if (!ok) errors.push(message); };
  if (!record(state)) return ['state must be an object'];
  require(state.schemaVersion === 1, 'schemaVersion must be 1');
  require(text(state.project_id), 'project_id is required');
  require(['active', 'paused', 'complete'].includes(state.production_status), 'invalid production_status');
  require(['none', 'prepare', 'generate', 'deliver'].includes(state.requested_action), 'invalid requested_action');
  require(Array.isArray(state.assets), 'assets must be an array');
  require(Array.isArray(state.shots), 'shots must be an array');
  require(record(state.authority), 'authority must be an object');
  const a = record(state.authority) ? state.authority : {};
  require(typeof a.generation_allowed === 'boolean', 'generation_allowed must be boolean');
  require(text(a.currency), 'generation currency is required');
  require(Number.isFinite(a.remaining) && a.remaining >= 0, 'remaining budget must be nonnegative');
  require(Number.isFinite(a.next_estimate) && a.next_estimate >= 0, 'next estimate must be nonnegative');
  if (state.requested_action === 'generate') {
    require(state.production_status === 'active', 'generation requires active production');
    require(a.generation_allowed === true, 'generation authority is missing');
    require(a.next_estimate <= a.remaining, 'estimate exceeds remaining budget');
    require(list(state.shots).some(s => record(s) && s.status === 'motion_ready'), 'generation requires a motion_ready shot');
  }
  const assets = new Map();
  for (const asset of list(state.assets)) {
    if (!record(asset)) { errors.push('asset must be an object'); continue; }
    require(text(asset.id) && !assets.has(asset.id), 'asset IDs must be nonempty and unique');
    require(text(asset.version), `${asset.id}: version required`);
    require(sha256(asset.sha256), `${asset.id}: invalid SHA256`);
    require(text(asset.path) && text(asset.role), `${asset.id}: path and role required`);
    require(['candidate', 'accepted', 'rejected'].includes(asset.quality_status), `${asset.id}: invalid quality_status`);
    assets.set(asset.id, asset);
  }
  const ids = new Set();
  for (const shot of list(state.shots)) {
    if (!record(shot)) { errors.push('shot must be an object'); continue; }
    const prefix = shot.id || 'shot';
    require(text(shot.id) && !ids.has(shot.id), 'shot IDs must be nonempty and unique');
    ids.add(shot.id);
    require(text(shot.version), `${prefix}: version required`);
    require(['candidate', 'held', ...promotion].includes(shot.status), `${prefix}: invalid status`);
    for (const field of ['input_assets', 'required_dimensions', 'reviews', 'defects']) require(Array.isArray(shot[field]), `${prefix}: ${field} must be an array`);
    if (shot.required_user_dimensions !== undefined) require(Array.isArray(shot.required_user_dimensions), `${prefix}: required_user_dimensions must be an array`);
    const inputIds = new Set();
    for (const ref of list(shot.input_assets)) {
      if (!record(ref)) { errors.push(`${prefix}: input must be an object`); continue; }
      require(text(ref.id) && !inputIds.has(ref.id), `${prefix}: input IDs must be nonempty and unique`);
      inputIds.add(ref.id);
      require(sha256(ref.sha256), `${prefix}: invalid input SHA256`);
      const asset = assets.get(ref?.id);
      require(Boolean(asset), `${prefix}: unknown input ${ref?.id}`);
      require(asset && ref.sha256 === asset.sha256, `${prefix}: stale input hash ${ref?.id}`);
      require(['primary_image', 'identity_reference', 'blocking_only', 'exact_layer', 'audio'].includes(ref?.usage), `${prefix}: invalid input usage`);
      if (promotion.has(shot.status)) {
        require(asset && asset.quality_status !== 'rejected', `${prefix}: rejected input ${ref?.id}`);
        if (ref?.usage === 'primary_image') require(asset?.quality_status === 'accepted' && asset?.role !== 'blocking_guide', `${prefix}: primary image must be accepted quality master`);
      }
    }
    for (const dimension of [...list(shot.required_dimensions), ...list(shot.required_user_dimensions)]) require(dimensions.has(dimension), `${prefix}: unknown dimension ${dimension}`);
    for (const review of list(shot.reviews)) {
      if (!record(review)) { errors.push(`${prefix}: review must be an object`); continue; }
      require(dimensions.has(review.dimension), `${prefix}: invalid review dimension`);
      require(text(review.shot_version), `${prefix}: review shot_version required`);
      require(['accepted', 'rejected', 'pending'].includes(review.decision), `${prefix}: invalid review decision`);
      require(['agent', 'user', 'automated'].includes(review.reviewer_type), `${prefix}: invalid reviewer_type`);
      require(text(review.reviewer) && text(review.evidence), `${prefix}: reviewer and evidence required`);
      require(record(review.input_hashes) && Object.values(review.input_hashes).every(sha256), `${prefix}: review input_hashes required`);
    }
    for (const defect of list(shot.defects)) {
      if (!record(defect)) { errors.push(`${prefix}: defect must be an object`); continue; }
      require(text(defect?.id), `${prefix}: defect ID required`);
      require(['blocker', 'major', 'minor'].includes(defect?.severity), `${prefix}: invalid defect severity`);
      require(['open', 'resolved', 'accepted_exception'].includes(defect?.status), `${prefix}: invalid defect status`);
      if (defect.status !== 'open') {
        require(text(defect.disposition_evidence) && text(defect.disposition_reviewer), `${prefix}: defect disposition evidence required`);
        require(defect.shot_version === shot.version, `${prefix}: stale defect disposition`);
      }
      if (defect.status === 'accepted_exception') {
        require(text(defect.exception_reason) && text(defect.authority_reference), `${prefix}: accepted exception reason and authority reference required`);
        require(['intentional', 'accepted_scope'].includes(defect.exception_basis), `${prefix}: accepted exception must record intentional or accepted_scope basis`);
      }
    }
    require(record(shot.checks), `${prefix}: checks must be an object`);
    require(typeof shot.checks?.spatial_checked === 'boolean' && typeof shot.checks?.temporal_checked === 'boolean', `${prefix}: checks must contain boolean spatial_checked and temporal_checked`);
    require(Array.isArray(shot.checks?.object_counts), `${prefix}: object_counts must be an array`);
    const countedIds = new Set();
    for (const item of list(shot.checks?.object_counts)) {
      if (!record(item)) { errors.push(`${prefix}: object count must be an object`); continue; }
      require(text(item.id) && !countedIds.has(item.id), `${prefix}: object count IDs must be nonempty and unique`);
      countedIds.add(item.id);
      require(Number.isInteger(item.expected) && item.expected >= 0 && Number.isInteger(item.observed) && item.observed >= 0, `${prefix}: object counts must be nonnegative integers`);
    }
    if (!promotion.has(shot.status)) continue;
    const needed = new Set([...list(shot.required_dimensions), ...list(shot.required_user_dimensions), 'blocking', 'visual_quality']);
    if (shot.status === 'accepted') needed.add('motion');
    if (shot.status === 'delivery_ready') { needed.add('motion'); needed.add('edit'); needed.add('delivery'); }
    require(list(shot.input_assets).some(ref => ref?.usage === 'primary_image'), `${prefix}: primary_image required for promotion`);
    for (const dimension of needed) {
      const reviews = list(shot.reviews).filter(r => r?.dimension === dimension && r.shot_version === shot.version);
      const latest = reviews.at(-1);
      require(latest?.decision === 'accepted' && text(latest?.reviewer) && text(latest?.evidence), `${prefix}: current ${dimension} acceptance evidence missing`);
      const matchesInputs = review => record(review?.input_hashes) && list(shot.input_assets).every(ref => record(ref) && review.input_hashes[ref.id] === ref.sha256) && Object.keys(review.input_hashes).length === inputIds.size;
      require(matchesInputs(latest), `${prefix}: stale ${dimension} review input hashes`);
      if (list(shot.required_user_dimensions).includes(dimension)) {
        const userReview = reviews.filter(r => r.reviewer_type === 'user').at(-1);
        require(userReview?.decision === 'accepted' && matchesInputs(userReview), `${prefix}: current user ${dimension} acceptance evidence missing`);
      }
    }
    require(!list(shot.defects).some(d => ['blocker', 'major'].includes(d?.severity) && d.status === 'open'), `${prefix}: unresolved blocking defect`);
    for (const defect of list(shot.defects)) {
      if (defect?.severity === 'minor' && defect.status === 'open') require(text(defect.disclosure), `${prefix}: open minor defect disclosure required`);
    }
    require(shot.checks?.spatial_checked === true, `${prefix}: spatial review required`);
    if (shot.status !== 'motion_ready') require(shot.checks?.temporal_checked === true, `${prefix}: temporal playback required`);
    require(Array.isArray(shot.checks?.object_counts) && shot.checks.object_counts.length > 0, `${prefix}: object count checks required`);
    for (const item of list(shot.checks?.object_counts)) {
      require(record(item) && item.observed === item.expected, `${prefix}: object count mismatch ${item?.id}`);
    }
  }
  if (state.requested_action === 'deliver') require(list(state.shots).length > 0 && list(state.shots).every(s => record(s) && s.status === 'delivery_ready'), 'delivery requires delivery_ready shots');
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node validate-film-state.mjs <state.json>');
    const errors = validateFilmState(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.log(JSON.stringify({ valid: errors.length === 0, scope: 'recorded evidence only; no visual inspection or authorization', errors }, null, 2));
    process.exitCode = errors.length ? 1 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
