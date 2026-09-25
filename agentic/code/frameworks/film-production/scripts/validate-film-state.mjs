#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const promotion = new Set(['motion_ready', 'accepted', 'delivery_ready']);
const walked = new Set(['accepted', 'delivery_ready']);
const dimensions = new Set(['story', 'blocking', 'visual_quality', 'performance', 'motion', 'edit', 'delivery']);
const lockNames = ['coverage', 'picture', 'sound'];
const conditionTargets = new Set(['picture', 'sound', 'delivery']);
const treatments = new Set(['shown', 'continuous', 'cut', 'elided']);
const audioKinds = new Set(['dialogue', 'foley', 'effect', 'bed', 'music']);
const hash = /^[a-f0-9]{64}$/;
const text = value => typeof value === 'string' && value.trim().length > 0;
const list = value => Array.isArray(value) ? value : [];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => typeof value === 'string' && hash.test(value);
const count = value => Number.isInteger(value) && value >= 0;

/** Check recorded evidence. This does not inspect media or grant authority. */
export function validateFilmState(state) {
  const errors = [];
  const require = (ok, message) => { if (!ok) errors.push(message); };
  if (!record(state)) return ['state must be an object'];
  require(state.schemaVersion === 2, 'schemaVersion must be 2');
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
  const locks = record(state.locks) ? state.locks : {};
  if (state.locks !== undefined) require(record(state.locks), 'locks must be an object');
  if (state.requested_action === 'generate') {
    require(state.production_status === 'active', 'generation requires active production');
    require(a.generation_allowed === true, 'generation authority is missing');
    require(a.next_estimate <= a.remaining, 'estimate exceeds remaining budget');
    require(list(state.shots).some(s => record(s) && s.status === 'motion_ready'), 'generation requires a motion_ready shot');
    require(['locked', 'waived'].includes(locks.coverage?.status), 'generation requires a locked or waived coverage lock');
  }

  const checklistVersion = record(state.checklist) ? state.checklist.version : 1;
  if (state.checklist !== undefined) {
    require(record(state.checklist) && Number.isInteger(state.checklist.version) && state.checklist.version >= 1, 'checklist.version must be a positive integer');
    for (const item of list(state.checklist?.classes)) {
      require(record(item) && text(item.id) && text(item.source_defect) && Number.isInteger(item.added_in_version) && item.added_in_version <= checklistVersion, 'checklist classes need id, source_defect and added_in_version not above checklist.version');
    }
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

  const checkDefect = (prefix, defect, version, versionField) => {
    if (!record(defect)) { errors.push(`${prefix}: defect must be an object`); return; }
    require(text(defect.id), `${prefix}: defect ID required`);
    require(['blocker', 'major', 'minor'].includes(defect.severity), `${prefix}: invalid defect severity`);
    require(['open', 'resolved', 'accepted_exception'].includes(defect.status), `${prefix}: invalid defect status`);
    if (defect.status !== 'open') {
      require(text(defect.disposition_evidence) && text(defect.disposition_reviewer), `${prefix}: defect disposition evidence required`);
      require(defect[versionField] === version, `${prefix}: stale defect disposition`);
    }
    if (defect.status === 'accepted_exception') {
      require(text(defect.exception_reason) && text(defect.authority_reference), `${prefix}: accepted exception reason and authority reference required`);
      require(['intentional', 'accepted_scope'].includes(defect.exception_basis), `${prefix}: accepted exception must record intentional or accepted_scope basis`);
    }
  };
  const openBlocking = defects => list(defects).some(d => ['blocker', 'major'].includes(d?.severity) && d.status === 'open');

  const shots = new Map();
  for (const shot of list(state.shots)) {
    if (!record(shot)) { errors.push('shot must be an object'); continue; }
    const prefix = shot.id || 'shot';
    require(text(shot.id) && !shots.has(shot.id), 'shot IDs must be nonempty and unique');
    shots.set(shot.id, shot);
    require(text(shot.version), `${prefix}: version required`);
    require(['candidate', 'held', ...promotion].includes(shot.status), `${prefix}: invalid status`);
    for (const field of ['input_assets', 'required_dimensions', 'reviews', 'defects', 'events']) require(Array.isArray(shot[field]), `${prefix}: ${field} must be an array`);
    if (shot.required_user_dimensions !== undefined) require(Array.isArray(shot.required_user_dimensions), `${prefix}: required_user_dimensions must be an array`);
    const inputIds = new Set();
    for (const ref of list(shot.input_assets)) {
      if (!record(ref)) { errors.push(`${prefix}: input must be an object`); continue; }
      require(text(ref.id) && !inputIds.has(ref.id), `${prefix}: input IDs must be nonempty and unique`);
      inputIds.add(ref.id);
      require(sha256(ref.sha256), `${prefix}: invalid input SHA256`);
      const asset = assets.get(ref.id);
      require(Boolean(asset), `${prefix}: unknown input ${ref.id}`);
      require(asset && ref.sha256 === asset.sha256, `${prefix}: stale input hash ${ref.id}`);
      require(['primary_image', 'identity_reference', 'blocking_only', 'exact_layer', 'audio'].includes(ref.usage), `${prefix}: invalid input usage`);
      if (promotion.has(shot.status)) {
        require(asset && asset.quality_status !== 'rejected', `${prefix}: rejected input ${ref.id}`);
        if (ref.usage === 'primary_image') require(asset?.quality_status === 'accepted' && asset?.role !== 'blocking_guide', `${prefix}: primary image must be accepted quality master`);
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
    for (const defect of list(shot.defects)) checkDefect(prefix, defect, shot.version, 'shot_version');
    const eventIds = new Set();
    for (const event of list(shot.events)) {
      if (!record(event)) { errors.push(`${prefix}: event must be an object`); continue; }
      require(text(event.id) && !eventIds.has(event.id), `${prefix}: event IDs must be nonempty and unique`);
      eventIds.add(event.id);
      require(Number.isInteger(event.order) && event.order >= 1, `${prefix}: event ${event.id} order must be a positive integer`);
      require(text(event.target) && text(event.result_state), `${prefix}: event ${event.id} target and result_state required`);
      require(Number.isInteger(event.expected_count) && event.expected_count >= 1, `${prefix}: event ${event.id} expected_count must be at least 1`);
      if (event.observed_count !== undefined) require(count(event.observed_count), `${prefix}: event ${event.id} observed_count must be a nonnegative integer`);
    }
    require(record(shot.checks), `${prefix}: checks must be an object`);
    require(typeof shot.checks?.spatial_checked === 'boolean' && typeof shot.checks?.temporal_checked === 'boolean', `${prefix}: checks must contain boolean spatial_checked and temporal_checked`);
    require(Array.isArray(shot.checks?.object_counts), `${prefix}: object_counts must be an array`);
    const countedIds = new Set();
    for (const item of list(shot.checks?.object_counts)) {
      if (!record(item)) { errors.push(`${prefix}: object count must be an object`); continue; }
      require(text(item.id) && !countedIds.has(item.id), `${prefix}: object count IDs must be nonempty and unique`);
      countedIds.add(item.id);
      require(count(item.expected) && count(item.observed), `${prefix}: object counts must be nonnegative integers`);
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
    require(!openBlocking(shot.defects), `${prefix}: unresolved blocking defect`);
    for (const defect of list(shot.defects)) {
      if (defect?.severity === 'minor' && defect.status === 'open') require(text(defect.disclosure), `${prefix}: open minor defect disclosure required`);
    }
    require(shot.checks?.spatial_checked === true, `${prefix}: spatial review required`);
    if (shot.status !== 'motion_ready') require(shot.checks?.temporal_checked === true, `${prefix}: temporal playback required`);
    require(list(shot.checks?.object_counts).length > 0, `${prefix}: object count checks required`);
    for (const item of list(shot.checks?.object_counts)) require(record(item) && item.observed === item.expected, `${prefix}: object count mismatch ${item?.id}`);
    if (walked.has(shot.status)) {
      require(list(shot.events).length > 0, `${prefix}: event list required for accepted motion`);
      for (const event of list(shot.events)) {
        if (!record(event)) continue;
        const excepted = list(shot.defects).some(d => d?.affects_event === event.id && d.status === 'accepted_exception');
        require(count(event.observed_count) && text(event.observed_evidence), `${prefix}: event ${event.id} walk not recorded`);
        require(excepted || event.observed_count === event.expected_count, `${prefix}: event count mismatch ${event.id}`);
      }
    }
  }

  const eventExists = ref => {
    const [shotId, eventId] = typeof ref === 'string' ? ref.split('#') : [];
    return list(shots.get(shotId)?.events).some(e => e?.id === eventId);
  };
  const requiredEvents = new Set();
  const beatIds = new Set();
  for (const beat of list(state.beats)) {
    if (!record(beat)) { errors.push('beat must be an object'); continue; }
    const prefix = `beat ${beat.id || '?'}`;
    require(text(beat.id) && !beatIds.has(beat.id), 'beat IDs must be nonempty and unique');
    beatIds.add(beat.id);
    require(typeof beat.required === 'boolean', `${prefix}: required must be boolean`);
    require(treatments.has(beat.treatment), `${prefix}: invalid treatment`);
    for (const ref of list(beat.event_refs)) require(eventExists(ref), `${prefix}: unknown event ${ref}`);
    if (!beat.required) continue;
    if (beat.treatment === 'elided') {
      require(text(beat.scope_change?.authority_reference) && text(beat.scope_change?.reason), `${prefix}: eliding a required beat is a scope change needing reason and authority_reference`);
    } else {
      require(list(beat.event_refs).length > 0, `${prefix}: required beat needs at least one event`);
      for (const ref of list(beat.event_refs)) requiredEvents.add(ref);
    }
  }
  for (const shot of shots.values()) {
    for (const defect of list(shot.defects)) {
      if (defect?.severity === 'minor' && defect.status === 'open' && requiredEvents.has(`${shot.id}#${defect.affects_event}`)) {
        errors.push(`${shot.id}: defect on required beat event ${defect.affects_event} cannot ship as a minor residual`);
      }
    }
  }

  const timeline = record(state.timeline) ? state.timeline : null;
  if (state.timeline !== undefined) {
    require(timeline && text(timeline.id) && text(timeline.version) && sha256(timeline.sha256), 'timeline needs id, version and sha256');
    const order = list(timeline?.shot_order);
    require(order.length > 0 && new Set(order).size === order.length, 'timeline.shot_order must be nonempty and unique');
    for (const id of order) require(shots.has(id), `timeline: unknown shot ${id}`);
  }
  const cuts = [];
  for (const cut of list(state.cuts)) {
    if (!record(cut)) { errors.push('cut must be an object'); continue; }
    const prefix = `cut ${cut.id || '?'}`;
    require(text(cut.id), 'cut ID required');
    require(shots.has(cut.out_shot) && shots.has(cut.in_shot), `${prefix}: unknown out_shot or in_shot`);
    require(text(cut.out_version) && text(cut.in_version), `${prefix}: out_version and in_version required`);
    require(list(cut.carried_states).length > 0 && list(cut.carried_states).every(text), `${prefix}: carried_states required`);
    for (const review of list(cut.reviews)) {
      if (!record(review)) { errors.push(`${prefix}: review must be an object`); continue; }
      require(['playback', 'stills'].includes(review.method), `${prefix}: review method must be playback or stills`);
      require(['accepted', 'rejected', 'pending'].includes(review.decision), `${prefix}: invalid review decision`);
      require(['agent', 'user', 'automated'].includes(review.reviewer_type), `${prefix}: invalid reviewer_type`);
      require(text(review.reviewer) && text(review.evidence), `${prefix}: reviewer and evidence required`);
    }
    for (const defect of list(cut.defects)) checkDefect(prefix, defect, timeline?.version, 'timeline_version');
    cuts.push(cut);
  }

  const lockHolds = {};
  const checkConditions = (target) => {
    for (const name of lockNames) {
      for (const condition of list(locks[name]?.conditions)) {
        if (record(condition) && condition.closes_by === target) require(condition.status === 'closed' && text(condition.closure_evidence), `${name} lock condition ${condition.id} must close before ${target}`);
      }
    }
  };
  const requiredUserLocks = list(state.required_user_locks);
  for (const name of requiredUserLocks) require(lockNames.includes(name), `unknown required user lock ${name}`);
  for (const name of lockNames) {
    const lock = locks[name];
    if (lock === undefined) continue;
    const prefix = `${name} lock`;
    if (!record(lock)) { errors.push(`${prefix} must be an object`); continue; }
    require(['open', 'locked', 'waived'].includes(lock.status), `${prefix}: invalid status`);
    for (const condition of list(lock.conditions)) {
      require(record(condition) && text(condition.id) && conditionTargets.has(condition.closes_by) && ['open', 'closed'].includes(condition.status), `${prefix}: conditions need id, closes_by (picture, sound or delivery) and open or closed status`);
    }
    if (lock.status === 'waived') {
      require(text(lock.authority_reference) && text(lock.reason), `${prefix}: waiver needs reason and authority_reference`);
      lockHolds[name] = name === 'coverage';
      require(name === 'coverage', `${prefix}: only the coverage lock can be waived`);
      continue;
    }
    if (lock.status !== 'locked') continue;
    require(text(lock.reviewer) && text(lock.evidence) && ['agent', 'user', 'automated'].includes(lock.reviewer_type), `${prefix}: reviewer, reviewer_type and evidence required`);
    require(sha256(lock.subject_sha256), `${prefix}: subject_sha256 required`);
    if (requiredUserLocks.includes(name)) require(lock.reviewer_type === 'user', `${prefix}: user sign-off required`);
    const before = errors.length;
    if (name === 'picture' || name === 'sound') {
      require(Boolean(timeline), `${prefix}: timeline required`);
      require(timeline && lock.subject_sha256 === timeline.sha256, `${prefix}: stale against current timeline; record a change list and relock`);
    }
    if (name === 'picture') {
      checkConditions('picture');
      const order = list(timeline?.shot_order);
      for (const id of order) {
        const shot = shots.get(id);
        if (!shot) continue;
        require(walked.has(shot.status), `picture lock: shot ${id} must be accepted`);
        const motion = list(shot.reviews).filter(r => r?.dimension === 'motion' && r.shot_version === shot.version).at(-1);
        require(motion?.checklist_version === checklistVersion, `picture lock: shot ${id} motion review predates checklist version ${checklistVersion}`);
      }
      for (const ref of requiredEvents) require(order.includes(ref.split('#')[0]), `picture lock: required beat event ${ref} is not in the timeline`);
      for (let i = 1; i < order.length; i++) {
        const matches = cuts.filter(c => c.out_shot === order[i - 1] && c.in_shot === order[i]);
        const cutId = `${order[i - 1]}>${order[i]}`;
        require(matches.length === 1, `picture lock: exactly one cut record required for ${cutId}`);
        const cut = matches[0];
        if (!cut) continue;
        require(cut.out_version === shots.get(order[i - 1])?.version && cut.in_version === shots.get(order[i])?.version, `cut ${cut.id}: shot versions changed since cut review`);
        const latest = list(cut.reviews).at(-1);
        require(latest?.method !== 'stills', `cut ${cut.id}: still-image review cannot pass a cut`);
        require(latest?.decision === 'accepted' && latest?.method === 'playback' && Number.isFinite(latest?.context_seconds) && latest.context_seconds >= 1, `cut ${cut.id}: accepted playback review with at least 1 s context required`);
        require(latest?.timeline_sha256 === timeline?.sha256, `cut ${cut.id}: review is stale against current timeline`);
        require(latest?.checklist_version === checklistVersion, `cut ${cut.id}: review predates checklist version ${checklistVersion}`);
        require(!openBlocking(cut.defects), `cut ${cut.id}: unresolved blocking defect`);
        for (const defect of list(cut.defects)) if (defect?.severity === 'minor' && defect.status === 'open') require(text(defect.disclosure), `cut ${cut.id}: open minor defect disclosure required`);
      }
    }
    if (name === 'sound') {
      require(lockHolds.picture === true, 'sound lock requires a valid picture lock');
      checkConditions('sound');
      for (const element of list(state.audio_elements)) {
        if (!record(element)) { errors.push('audio element must be an object'); continue; }
        const label = `audio ${element.id || '?'}`;
        require(text(element.id) && audioKinds.has(element.kind), `${label}: id and valid kind required`);
        require(text(element.measured_by), `${label}: measured_by required`);
        require(element.qc === 'pass', `${label}: qc must pass before sound lock`);
        if (element.kind === 'bed') require(text(element.bed_approval_reference), `${label}: continuous bed needs approval reference`);
        require(Number.isFinite(element.noise_floor_dbfs) && Number.isFinite(element.noise_floor_limit_dbfs) && element.noise_floor_dbfs <= element.noise_floor_limit_dbfs, `${label}: noise floor missing or above limit`);
        if (element.spectral_flatness_limit !== undefined) require(Number.isFinite(element.spectral_flatness) && element.spectral_flatness <= element.spectral_flatness_limit, `${label}: spectral flatness missing or above limit`);
      }
    }
    lockHolds[name] = errors.length === before;
  }

  if (state.requested_action === 'deliver') {
    require(list(state.shots).length > 0 && list(state.shots).every(s => record(s) && s.status === 'delivery_ready'), 'delivery requires delivery_ready shots');
    require(locks.picture?.status === 'locked' && lockHolds.picture === true, 'delivery requires a valid picture lock');
    require(locks.sound?.status === 'locked' && lockHolds.sound === true, 'delivery requires a valid sound lock');
    checkConditions('delivery');
  }
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
