---
name: film-production-state
description: Track authoritative versions, approvals and next action
---

# Film Production State

Maintain one current-state.json; preserve change history separately. Use schemas/production-state.schema.json and validate recorded promotions with scripts/validate-film-state.mjs, both relative to `$AIWG_ROOT/agentic/code/frameworks/film-production/`. Keep large media in approved storage with immutable references. These are manual evidence records, not automatic visual acceptance.

Required fields: schemaVersion=1, project_id, production_status (active|paused|complete), requested_action (none|prepare|generate|deliver), authority {generation_allowed, currency, remaining, next_estimate}, assets[], shots[].
Asset: id, version, sha256, role, quality_status (candidate|accepted|rejected), path.
Shot: id, version, status (candidate|held|motion_ready|accepted|delivery_ready), input_assets[{id,sha256,usage}], required_dimensions[], optional required_user_dimensions[], reviews[{dimension,shot_version,decision,reviewer,reviewer_type,evidence,input_hashes}], defects[{id,severity,status}], checks{object_counts:[{id,expected,observed}],spatial_checked,temporal_checked}, record_path.

Review input_hashes maps each input asset ID to its SHA256. reviewer_type is agent, user or automated; labeling a review does not authenticate it. Populate required_user_dimensions only from an actual review requirement, not as a default permission gate. A current user rejection cannot be cleared by an agent's later acceptance when that dimension requires user review.

Resolved defects need disposition_evidence, disposition_reviewer and the current shot_version. accepted_exception also needs exception_reason, authority_reference and exception_basis (intentional|accepted_scope). Open minor defects may remain with disclosure; open blocker/major defects block promotion. Never fabricate evidence merely to pass the checker.

Promotion states require matching accepted review evidence and no open blocker/major defects. Primary image inputs must be accepted and not blocking guides; all versions/hashes must resolve. A paused state cannot request generation. This validator does not authorize spending or publication.

See examples/production-state.example.json under the same framework root for a non-generating synthetic motion-ready record. State your actual paused/active status; never copy example acceptance into live evidence. The current checker models image-to-video shot promotion; it does not inspect file bytes, visualize media or enforce provider submissions.
