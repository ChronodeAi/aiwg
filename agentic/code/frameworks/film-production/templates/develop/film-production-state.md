---
name: film-production-state
description: Track authoritative versions, approvals and next action
---

# Film Production State

Maintain one current-state.json; preserve change history separately. Use schemas/production-state.schema.json and validate recorded promotions with scripts/validate-film-state.mjs, both relative to `$AIWG_ROOT/agentic/code/frameworks/film-production/`. Keep large media in approved storage with immutable references. These are manual evidence records, not automatic visual acceptance.

Required fields: schemaVersion=2, project_id, production_status (active|paused|complete), requested_action (none|prepare|generate|deliver), authority {generation_allowed, currency, remaining, next_estimate}, assets[], shots[].
Asset: id, version, sha256, role, quality_status (candidate|accepted|rejected), path.
Shot: id, version, status (candidate|held|motion_ready|accepted|delivery_ready), input_assets[{id,sha256,usage}], required_dimensions[], optional required_user_dimensions[], reviews[{dimension,shot_version,decision,reviewer,reviewer_type,evidence,input_hashes,checklist_version}], defects[{id,severity,status,affects_event}], events[{id,order,target,result_state,expected_count,observed_count,observed_evidence}], checks{object_counts:[{id,expected,observed}],spatial_checked,temporal_checked}, record_path.

Gate records (criteria in `docs/taxonomy.md`, Acceptance gates and locks):
- checklist {version, classes[{id,source_defect,added_in_version}]}: bump version for each escaped defect class.
- beats[{id,required,treatment (shown|continuous|cut|elided),event_refs["SHOT#EVENT"],scope_change{reason,authority_reference}}].
- locks {coverage, picture, sound}: {status (open|locked|waived), subject_sha256, reviewer, reviewer_type, evidence, change_list[], conditions[{id,closes_by (picture|sound|delivery),status,closure_evidence}]}; only coverage may be waived, with reason and authority_reference. Optional required_user_locks[] only from an actual user requirement.
- timeline {id,version,sha256,shot_order[]}; cuts[{id,out_shot,out_version,in_shot,in_version,carried_states[],reviews[{method (playback|stills),context_seconds,timeline_sha256,checklist_version,decision,reviewer,reviewer_type,evidence}],defects[]}].
- audio_elements[{id,kind (dialogue|foley|effect|bed|music),measured_by,qc,noise_floor_dbfs,noise_floor_limit_dbfs,spectral_flatness,spectral_flatness_limit,bed_approval_reference}].

Review input_hashes maps each input asset ID to its SHA256. reviewer_type is agent, user or automated; labeling a review does not authenticate it. Populate required_user_dimensions only from an actual review requirement, not as a default permission gate. A current user rejection cannot be cleared by an agent's later acceptance when that dimension requires user review.

Resolved defects need disposition_evidence, disposition_reviewer and the current shot_version. accepted_exception also needs exception_reason, authority_reference and exception_basis (intentional|accepted_scope). Open minor defects may remain with disclosure; open blocker/major defects block promotion. Never fabricate evidence merely to pass the checker.

Promotion states require matching accepted review evidence and no open blocker/major defects. Primary image inputs must be accepted and not blocking guides; all versions/hashes must resolve. Accepted and delivery_ready shots need a recorded event walk with matching counts. A paused state cannot request generation; generation also needs a locked or waived coverage lock. Delivery needs valid picture and sound locks for the current timeline hash with all conditions closed. This validator does not authorize spending or publication.

See examples/production-state.example.json under the same framework root for a non-generating synthetic motion-ready record. State your actual paused/active status; never copy example acceptance into live evidence. The checker validates recorded claims only: it does not inspect file bytes, play media, measure audio or enforce provider submissions. Write audio measures and review-render hashes from scripts where possible so the record reflects real measurements.
