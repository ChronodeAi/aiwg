---
name: film-provider-preflight
namespace: aiwg
platforms: [all]
description: Verify a film tool adapter, source compatibility, task reconciliation, and bounded generation cost before submission.
triggers:
  - "film-provider-preflight"
  - "preflight film provider"
commandHint:
  modelRole: efficiency
  modelTier: economy
---

# Film Provider Preflight

## Inputs

Read current state, the representative shot record, approved source versions, requested operation, and existing upload/spend authority. Load `aiwg show template film-generation-receipt`.

## Workflow

1. Discover the installed adapter for the actual operation and inspect its current documentation. Verify provider, account/workspace, model capability, input schema, output location, and supported status/retrieval route. An authenticated connection does not prove the intended project is loaded.
2. Check limits for source dimensions, file types, duration, references, masks, audio conditioning, and exact-source layers. Preserve originals; record derivative conversions and inspect any visible loss before upload.
3. Verify that inputs are current and have no relevant quality hold. Check hand/prop states, useful causal coverage, speech mode, and acceptance criteria before turning them into a concise operational prompt.
4. Record a bounded estimate, currency/units, maximum attempts, and remaining authorized budget. Price is not proof of quality; start with a representative test when capability is unverified. Do not require a premium tier by default.
5. Establish task identity and reconciliation before submission. Retain provider task IDs and sanitized request/response references. After an uncertain submission or failed poll, query the known handle before any retry that could create another charge.
6. Submit only within existing authority. Inspect the returned artifact and record observed behavior, actual charge when available, and any unknown cost or capability claims.

## Outputs

Produce a generation receipt, source/version mapping, capability evidence, and a proceed/hold decision for the bounded operation.

## Continue or hold

Continue on supported inputs and sufficient authority. Hold dependent submissions for incompatible controls, unknown task outcome, source defects, or insufficient budget authority. Continue independent preparation without bypassing service safeguards or relabeling a failed operation as completed.
