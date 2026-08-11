---
name: de-clever
description: >-
  Use when a claim needs its rhetorical cover stripped to see whether anything is under it — framework name-drops ("classic cold-start problem"), coined terms ("engagement debt"), contrarian inversions, aphorisms as trump cards, altitude statements ("own the workflow, not the feature"), meta-escalations ("we're solving the wrong problem"), or speculative second-order chains — restated *plainly* and tested against what it would actually change. Fires on "de-clever this", "plain version of this", "is this clever or true?", and on strategy docs, PRDs, and decision rationale that lean on the moves above. Not for packaging an idea that already survived (`prep-the-room`), an exec update or date commitment (`manage-the-upward-channel`), or restructuring prose for readability (`skimmable-writing`). Source: Shreyas Doshi's "sound less clever" post.
---

# Strip cleverness from a claim

Cleverness is a contaminant in the thinking phase. Optimizing for *sounds sophisticated* is optimizing a proxy; the target is *is true*. Every move below produces the sensation of insight without paying the cost of contact with specifics. The plain version always costs more — it is checkable, attributable, and might be visibly wrong. That cost is exactly what makes it the one operating at the level of truth.

## The seven moves

| Move | Sounds like | Why it feels clever | What plain thinking does instead |
|---|---|---|---|
| Premature pattern-matching | "This is a classic cold-start problem" | Compression — the click of recognition as messy specifics snap onto a known shape. It ends the looking. | Stays with specifics: "New users aren't finding value in the first session and I don't know why." The answer usually lives in a detail the framework doesn't predict. |
| Elegant abstraction one level up | "We shouldn't own the feature, we should own the workflow" | Altitude reads as strategy, and nothing that high can be wrong. Often where you go to dodge a decision you'd have to defend at ground level. | Forces the cash-out: "Which three things would we build differently next quarter if this were true?" Frequently nothing — the insight was decorative. |
| Contrarian inversion | "Our churn isn't a retention problem, it's an acquisition problem" | Has the syntactic shape of insight. People generate the reversal first and the justification after. | Asks the boring question the inversion skipped: what does the evidence say about why people actually leave? |
| Aphorism as trump card | "If you're not embarrassed by v1, you shipped too late" | Borrowed authority — disputing the line feels like disputing wisdom. | Argues the actual case: this specific cut is acceptable because these specific users won't hit it. |
| Meta-escalation | "I think we're solving the wrong problem here" | Costs nothing, can't be falsified in the room, and instantly repositions the speaker above everyone doing ground-level work. | Carries the burden: "I think the problem is X, and here's what I'd look at to check." |
| Coining a term | "We're accumulating engagement debt" | Naming feels like discovering. A label is not a mechanism. | Says it without the label — "usage is declining among users we onboarded during the promotion, possibly because it attracted a different need" — which exposes how much weight *possibly* is carrying. |
| Second-order theater | "The second-order effect is that power users feel deprioritized, which compounds into…" | Speculative chains can't be checked in the room and each link sounds rigorous. Performing reasoning is cheap; doing it is work. | States confidence honestly: "I can imagine this annoying power users. I don't know if it would. We could ask eight of them." |

## Step 1 — Quote what's actually there

Scan the material for the seven moves and quote each instance exactly. Where nothing is flagged, say so and stop — manufacturing findings to justify the audit is itself the proxy alarm firing.

Done when every flagged item is a verbatim quote paired with its named move, or the verdict is an explicit "nothing flagged".

## Step 2 — Restate each flagged claim plainly

Rewrite each in flat declarative sentences: no framework names, no coinages, no inversions. Watch what happens to the certainty. When a sentence gets visibly more speculative once stripped, the coinage was hiding the speculation, and that is the finding.

Done when each flagged claim has a plain restatement, and any that became more speculative under restatement is marked as such.

## Step 3 — Run the tests

Three, per claim:

- **Plain-statement** — can you say what's happening without the term or framework name?
- **Cash-out** — what would we build differently next quarter if this were true? If nothing, the insight is decorative.
- **Confidence honesty** — replace a speculative causal chain with "I can imagine X. I don't know. Here's how we'd check."

A claim that survives all three stands, however clever it sounded. The moves trigger the tests; they are not a verdict. Sometimes the inversion is true and the framework does fit.

Done when every flagged claim has a named test result and is sorted into survives, collapses, or honest speculation.

## Step 4 — Deliver the verdict and the handoff

Say which claims survive plain statement, which collapse without their scaffolding, and which are speculation that should be labelled as speculation. Escalate to the user when a collapsing claim is load-bearing for a decision already in motion, or when the plain version reveals the decision rests on evidence only they can go gather.

Where the idea survives and now needs approving, hand off: "it holds in plain form; `prep-the-room` builds the costume."

Done when every flagged item ends with either a checkable plain version or an explicit "this is speculation, here's how we'd check" — and nothing is left with only a critique.

## Think plainly, present cleverly

In most companies the approval stage rewards cleverness-signaling, not truth-seeking — the presentation manufactures a feeling of co-discovered brilliance rather than transmitting an idea. That is real, and this skill owns phase one only. Phase two belongs to `prep-the-room` and `manage-the-upward-channel`.

The costume has to stay a translation layer you put on for the room and take off after, and you can only tell it from the body if you know what the idea looks like naked. Two ways that fails: **leakage**, where the framing built for the room becomes how you think about the problem (the room applauds in real time, better decisions pay out late and unattributed, so anyone drifts) — cured by keeping a venue where only plain statement counts. And **performing plainness**, where flat sentences become their own cleverness signal; test your plain version against the same cost signature, since austere is not the same as checkable.

## Provenance

Compiled from Shreyas Doshi's "sound less clever" post and its accompanying analysis chat (June 2026). Full source in `references/source.md`. The post performs its own structure — plain at first, clever in the last paragraph — and recruits the reader into the demonstration, since decoding the irony delivers the jolt of feeling clever it warns about.
