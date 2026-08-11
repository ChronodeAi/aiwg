---
name: scope-defense
description: >-
  Use when a mid-project "can we just add one more thing" request lands and the PM needs its *cost* made visible before anyone says yes — quantified effort, what it displaces, and decision options with named consequences. Not for prioritizing a whole requirements list (`p0-p1-p2`), visualizing agreed tradeoffs (`tradeoff-matrix`), or deciding whether to fight the requester (`pick-your-battles`).
---

# Price a scope-change request

## Step 1 — Capture the request and the commitment it lands on

Get: the request in the requester's words and why now; and the current commitment — what's promised, to whom, by when, and how much team capacity remains. A cost only means something against a commitment.

Done when both are concrete: the request has a requester and a reason, the commitment has a date and an audience.

## Step 2 — Price the request

Estimate the effort across design, engineering, and QA as a range with a confidence level, and add the costs that don't show up in a ticket: ongoing maintenance, the context-switch hit to work in flight, and new failure modes. Sanity-check the engineering number with an engineer if one is reachable; say so if not. These are the team's estimates, not the agent's — pull them from whoever will build it, and flag any number the agent had to assume.

Done when there is a total range with a confidence level, and the hidden costs are listed — or explicitly judged negligible.

## Step 3 — Weigh its value against what it displaces

Assess the request's value: who benefits, how often, and how badly it's needed (blocker, major friction, minor improvement, delight). Then name the specific committed work it would displace and compare directly: "this request vs. {the lowest-value committed item} — which matters more, and says who?"

Done when the comparison names a specific displaced item and a verdict with its evidence, not two abstract scores.

## Step 4 — Lay out the options with named consequences

Five options, each with its specific consequence — real dates and real cut items, not generic pros and cons:

- **Extend** — new date is {date}; who has to be told.
- **Swap** — {named item} comes out; what its absence costs.
- **Defer** — lands in {release}; what users do meanwhile.
- **Slice** — the reduced version that ships in {n} days; what it omits.
- **Decline** — the commitment holds; what the requester loses.

Done when every option's consequence names a date, an item, or a person — none reads "some delay."

## Step 5 — Recommend one and route the decision

Recommend an option and state the single factor that decides it (immovable date, value comparison from Step 3, capacity). Then name who makes the call and by when — and escalate rather than decide when the request comes from above the PM's level or touches an external commitment.

Done when the recommendation names its deciding factor, and the decision has an owner and a date.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-scope-defense-{request-slug}.md`. Never hand-build the path.

The doc holds: the request and commitment, the priced effort with hidden costs, the value-vs-displacement verdict, the five options with consequences, the recommendation and decision route.
