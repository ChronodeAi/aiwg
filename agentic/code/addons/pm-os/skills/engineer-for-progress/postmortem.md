# Postmortem: FWBU coding

A postmortem that ends with "lessons learned" learns nothing. Moesta's postmortem maps the timeline of the project and codes each event so the causal pattern becomes legible.

## The codes

For each event on the project timeline, mark one of:

- **F — Frustration.** You hit a wall but kept pushing. The work continued. Useful when frustration revealed a new constraint.
- **W — Washed out.** The road you were on was gone. You couldn't continue down it. A pivot was required.
- **B — steppedBack.** You voluntarily backed up to revisit an earlier decision. Often the most valuable code — backing up is expensive but usually right.
- **U — Unsure what to do.** You stalled. The work paused not because the road was gone, but because you didn't know which road to take.

The codes are not judgments — they are factual descriptions of what happened to the team's momentum. A project with many Fs and few Us is one shape. A project with many Us is a different shape, with different fixes.

## The timeline map

Draw the timeline in stages — design, build, integrate, ship, run. For each event a team member remembers, place it on the line and code it.

```
DESIGN ──────── BUILD ──────── INTEGRATE ──────── SHIP ──────── RUN
   │              │                 │                │             │
   F: spec   B: redo data    W: API change       U: launch     F: ops
   moved     model              broke us           date moved   pages
```

Pre-fill the timeline with known stages and let the team add events. The act of *placing* events on the line surfaces causation: an F in design that nobody addressed often shows up as a W in integrate.

## The red-pill question

End with one question, asked of the whole team:

> *"If you could go back and take the red pill of innovation before this project started, what would you do differently? What actions would you start, stop, or continue?"*

Three rules for the answers:

- **Start / stop / continue** — every answer fits one of the three. No "we should think about" or "we might consider."
- **Tie to a coded event** — every action ties to a specific F, W, B, or U on the timeline. No abstract advice.
- **One owner** — every action has a name attached. No "the team should."

## What a useful postmortem produces

- A coded timeline that any team member could reconstruct the project from.
- 3–7 named actions (start/stop/continue) tied to specific events.
- An identified pattern across the codes (*"every U came from missing customer evidence"* or *"every W came from upstream dependencies we treated as control"*).
- A revised entry in [`reframing.md`](reframing.md) or [`prototyping.md`](prototyping.md) if the pattern challenges a heuristic.

## What a useless postmortem produces

- A bulleted "lessons learned" list with no events attached.
- "We should communicate better."
- "We should plan more."
- "We should test more."

If the output drifts toward the useless list, return to the codes — every lesson must trace to an F/W/B/U event on the line.
