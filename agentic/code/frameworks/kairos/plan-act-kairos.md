# Kairos Pilot Lifecycle

Use the four phase flows (connect, model, validate, operate) and the continuous feedback track. The pilot orchestrator owns the plan and the gates; specialists receive bounded inputs. Parallelize reading, proposing and probing; serialize every write to the node.

Start with `kairos-connect` on a new pilot and `kairos-status` on continuation. The default proof is one decision the host project already makes, modeled as a handful of edges, validated over three walk-forward windows, and operated in paper mode.

## Operational contract

The node is the one `.aiwg/kairos/connection/node.json` declares. Proposals are hashed and never written as admitted edges. Evidence is point-in-time and disjoint from proposal sources. Gates run client-side because Kairos 2.1.1 does not enforce them. Every write has a durable idempotency key and a saved response. Every decision has a receipt. Paper until a human signs an OP packet.

## Human boundary

Humans decide only live-money or policy-touching edges, gate disagreement, sign flips on active edges, new node types, and signing and capital policy. Everything else proceeds on gates. Decisions become calibration labels; review minutes per admitted edge are measured.

## Feedback

Every discrepancy between Kairos's documents and its behavior becomes a finding with command, output, citation and expected versus observed. Findings are deduplicated and filed on `ChronodeAi/kairos`. The pilot report lists them with issue numbers.

## Enforcement limits

Rules are agent procedures. The scripts check recorded structure, hashes, fingerprints, gate arithmetic and credential leaks; they cannot see the node, prove a command ran, or authenticate a reviewer. False records can pass structural checks.
