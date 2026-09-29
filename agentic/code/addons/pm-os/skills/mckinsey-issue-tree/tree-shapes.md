# Tree shapes — rendering and deliverables

Reference for [`SKILL.md`](SKILL.md) Phases 8 and 9. Read the section for the shape confirmed in Phase 1; ignore the other two.

## Rules common to all shapes

- Drill until each leaf is **concrete** — a specific cause, a specific work unit, a specific intervention. Stop when concrete, not at level N. Some branches go 2 levels, some go 5. That is correct.
- **Soft cap: ~25 active leaves.** What-trees often run longer because workplan items add up; cap those at ~30.
- **Prune lowest-leverage branches** with `[PRUNED: reason]` left visible. The rationale must be specific and reference the framing or the crux, never "less important".
- Tree imbalance is fine and expected.
- **Default format: box-drawing characters, vertical layout**, with hierarchical numbering (1, 1.1, 1.1.1) so the Phase 9 deliverable can cite branches precisely.
- **Alternative format: horizontal, McKinsey-slide style.** Render it only if the user explicitly asks. If it would exceed ~100 characters wide, fall back to vertical and say why.

---

## Why-tree (diagnostic)

Root is a "Why" question. Leaves are concrete causes.

```
Why are X% of users churning in month 1?
├── 1. Product fails to deliver value
│   ├── 1.1 Onboarding doesn't surface key feature
│   │   ├── 1.1.1 Setup wizard skips X
│   │   └── 1.1.2 First-run dashboard buried
│   └── 1.2 Feature underperforms expectation
├── 2. User experiences friction
│   └── 2.1 Auth failures
└── 3. External fit drift  [PRUNED: explains <10% per framing]
```

### Deliverable — 3-5 hypotheses to test

```
**Hypothesis 1:** [1-sentence falsifiable claim about a root cause]
*Stems from: branches X.Y, X.Z*

**Hypothesis 2:** [...]
```

- 3-5 maximum — forced prioritisation. Seven candidates means the analysis is incomplete.
- Each must be falsifiable in form: the user could in principle test it with data, observation or conversation.
- Each must cite specific tree branch numbers.
- Rank by structural importance — hypotheses on the crux branch, or with multiple converging branches, go first.
- Do **not** write "if true, we'd expect X" predictions, suggest cheapest tests, or write a reconciliation paragraph against the working hypothesis.

### Anti-patterns

- Vibey hypotheses ("the team isn't aligned"). A hypothesis needs falsifiable shape — a specific causal claim someone could verify or refute.
- More than 5 hypotheses.
- Hypotheses that diagnose the user themselves as broken when the real problem is structural. "PM didn't ask enough questions" is upstream context, not a current root cause.

---

## What-tree (compositional / workplan)

Root is "What does producing X require us to unpack?" Leaves are tagged by work type:

- `[ANALYSIS]` — work to investigate, produces evidence
- `[DECISION]` — point-in-time choice, often blocked by an analysis
- `[COMMITMENT]` — cross-team agreement to extract (timeline, ownership, scope)
- `[ARTIFACT]` — written work product (one-pager, doc, deck)
- `[PROCESS]` — ongoing ritual (read-back cadence, escalation rules)
- `[SYNTHESIS]` — integration of upstream branches, only in the final synthesis branch

```
What does producing a Q2 product strategy require us to unpack?
├── 1. Strategic positioning
│   ├── 1.1 [DECISION] Primary product bet for Q2 (depends on 1.2)
│   └── 1.2 [ANALYSIS] Competitive landscape shift since Q1
├── 2. Audience prioritization
│   ├── 2.1 [ANALYSIS] Segment-level revenue and retention deltas
│   └── 2.2 [DECISION] Which segments are anti-scope for Q2
├── 3. Stakeholder alignment
│   ├── 3.1 [ARTIFACT] DACI for Q2 priority decisions
│   └── 3.2 [PROCESS] Biweekly written read-back to leadership  [continuous]
└── 4. Synthesis
    └── 4.1 [SYNTHESIS] Final Q2 strategy one-pager (depends on 1, 2, 3)
```

### Deliverable — sequenced execution plan

Group leaves into waves: sets of work that can run in parallel within the wave but depend on prior waves' outputs.

```
**Wave 1 (Weeks X-Y): [theme]**
- [leaf number] [tag] [description] — [optional: blocker note]

**Wave 2 (Weeks X-Y): [theme] (blocked by Wave 1)**
- ...

**Continuous (across all waves):**
- [leaf number] [tag] [description]
```

- Determine dependencies from the tree's structure and the natural sequencing of decisions.
- Leaves on the crux branch usually go in Wave 1 — they unblock everything else.
- `[SYNTHESIS]` leaves go in the last wave. `[PROCESS]` leaves marked `[continuous]` sit outside the waves.
- 3-4 waves is typical. More than 5 means the sequencing is too granular — collapse adjacent waves.
- Do **not** estimate effort, cost or timeline. Week ranges are order-of-magnitude rhythm only.

### Anti-patterns

- Vague leaves ("understand the audience better"). Leaves must be specific work units with a clear output.
- Sequencing that ignores real dependencies — synthesis tasks in early waves, independent work in late ones.
- Tagging everything `[DECISION]`. Most of a workplan is `[ANALYSIS]` and `[COMMITMENT]`.
- Inventing week ranges as if they were estimates.

---

## How-tree (solution / options)

Root is a "How might we" question. Leaves are concrete interventions a team could go execute.

```
How might we reduce month-1 churn by 30%?
├── 1. Improve onboarding
│   ├── 1.1 Redesign setup wizard to skip step X
│   └── 1.2 Move first-run dashboard surface
├── 2. Add engagement nudges
│   └── 2.1 Email reminder series in days 3-14
└── 3. Lower friction
    └── 3.1 Fix auth failures on mobile
```

### Deliverable — 3-5 ranked options

```
**Option 1:** [name / one-sentence intervention]
*Hits levers: branches X.Y, X.Z*
*Trade-offs:* [structural — which levers it hits and which it doesn't]

**Option 2:** [...]
```

- 3-5 maximum.
- Each must be a concrete intervention path, not a category. "Improve onboarding" is not an option; "redesign the setup wizard to skip step X" is.
- Each must cite the tree branches it implements.
- Rank by structural leverage — options hitting the crux branch plus multiple secondary branches go first.
- Trade-offs in structural terms only. Do **not** estimate effort, cost or timeline.

### Anti-patterns

- Options carrying effort or timeline estimates. You don't know the user's environment.
- Options too abstract to execute.
- Trade-offs phrased as cost or effort rather than as which levers are hit and missed.
