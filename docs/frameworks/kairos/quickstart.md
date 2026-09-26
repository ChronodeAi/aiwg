# kairos Quickstart

> **First time using AIWG?** Begin with [Install, Connect, and
Verify](../../getting-started/install-connect-verify.md). This guide assumes AIWG is already installed and connected
to the target project.

Use kairos when a project should make real decisions through a live Kairos node, admit graph edges only on evidence,
and report back to the Kairos team where the node differs from its documentation.

## Before You Start

You need a running Kairos node that someone operates for this project, its address, and, when the node has
authentication on, a way to obtain a token. The framework never installs or operates the node, never picks a node on
its own, and never stores the token.

## Installation

```bash
aiwg use kairos
```

Verify what was deployed:

```bash
aiwg list
```

You should see `kairos` listed as an installed framework and `.aiwg/kairos/` in the project. Reload the provider
session so it sees the new `kairos-quickref` kernel skill. The eight operational skills are reached through discovery:

```bash
aiwg discover "kairos review packet" --limit 3
aiwg show skill kairos-connect
aiwg show template kairos-pilot-plan
```

## First Useful Task

Ask for the Connected gate, naming the node:

```text
Use AIWG's kairos framework to connect this project to the Kairos node at http://127.0.0.1:4110
(pg profile, Privy token in KAIROS_API_TOKEN). Record /meta, readiness, version and the auth path
without storing any secret, run the conformance baseline, and tell me whether gate CG passes.
```

Success means `.aiwg/kairos/connection/connection-record.json` with `gate_cg`, a saved `/meta` snapshot, and a
conformance receipt. Failed documented claims become findings for the feedback track.

## Common Patterns

### Model One Decision

```text
Propose the causal edges behind our paper order-sizing decision as kairos proposals, from two model families
and one statistical screen, with every source hashed. Do not write anything to the node.
```

### Admit on Evidence

```text
Build this week's evidence bundle and run the kairos gates. Promote what passes, and give me review packets
only for the escalations.
```

The evaluation lists each edge's decision: promote, hold, demote, or escalate, with the reason.

### Send Feedback to Kairos

```text
File the open kairos findings that have complete evidence, after checking ChronodeAi/kairos for duplicates.
```

## Next Steps

- Read the [overview](overview.md) for gates, the human boundary, and the component catalog.
- Read the [framework README](https://github.com/jmagly/aiwg/blob/main/agentic/code/frameworks/kairos/README.md) for
  the scripts and workspace layout.
