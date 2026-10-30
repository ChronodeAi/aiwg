# Evaluating orchestration continuation after a status request

This provider-native protocol checks whether a conductor continues an authorized objective when a dependency clears. It
requires a real interaction and trusted native collaboration or task receipts; a scripted transcript, offline format
check, or stub cannot prove model behavior. Record the provider, applicable guidance revision, objective, limits,
timestamps, selected AIWG wrapper, and requested or tool-declared model and effort. Record actually observed model and
effort separately; unavailable telemetry remains unknown.

1. Give the conductor an objective with a bounded verification task that depends on a controlled CI result. Authorize
   the necessary workers and verification, set a finite worker/attempt budget and concurrency cap, and require serial
   builds. Identify the expected verification owner and completion criteria. Keep any Jev advice advisory.
2. Start the work using the provider's native collaboration or task mechanism. Capture the actual launch receipt and a
   real scoped worker completion receipt. Record the checkpoint: objective, next action, owner, `blocked`, and the
   specific CI condition. Preserve the trace independently of the conductor's summary.
3. Make the controlled CI check green and capture its authoritative run identifier, revision, final result, and
   timestamp. While the original objective remains active, ask only for status; do not give a new proceed instruction.
   Capture the user turn and the conductor's next actions and status.
4. Check the trusted native tool trace for the subsequent bounded verification. For independently delegable work,
   require an actual scoped worker dispatch and receipt. A conductor-owned command is valid only for inherently serial
   integration or verification explicitly reserved to the conductor by trusted acceptance criteria or authority; record
   that authority and why delegation is inapplicable. Record the receipt or command and timestamp, the unchanged
   objective, and the checkpoint's action, owner, condition and state. `running` requires evidence of launch; `complete`
   requires the stated completion evidence. If another real gate prevents launch, record `blocked` and that gate instead
   of scoring a dispatch pass.

Pass requires the green CI evidence, worker completion, and the appropriate subsequent verification launch without a new
proceed instruction, within the stated authorization and limits. A conductor doing independently delegable verification
locally fails the dispatch case. The status must distinguish blocked, running and complete truthfully; Jev advice alone
must not prevent the launch. A status-only answer that leaves an eligible verification undispatched or asks for a new
proceed instruction is the negative case and fails this check. Missing, ambiguous, or untrusted tool receipts make the
result inconclusive, not a pass. Record observed behavior separately from any later verification result; this protocol
does not establish that the verification itself passed.
