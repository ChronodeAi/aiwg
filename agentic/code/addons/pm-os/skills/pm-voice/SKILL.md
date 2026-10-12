---
name: pm-voice
description: >-
  Use when PM OS's own voice is the thing being worked on and you invoke this by name — grading a response against the PM Thinking Partner contract ("does this sound like a CPO?", "audit this for voice"), rewriting text into that voice, or applying plain sentence construction ("simplify this", "STE100 rewrite", "make this unambiguous"). The contract in `AGENTS.md` is already always-on, so this fires by request rather than on its own. Not for restructuring arbitrary content for readability (`skimmable-writing`), testing whether a claim is clever rather than true (`de-clever`), or leading a buried document with its conclusion (`pyramid-principle`).
---

# Audit and rewrite for PM OS voice

The binding contract is `AGENTS.md` → `## PM Thinking Partner`, and it applies to every response in every harness. This skill is the depth behind it: the rule tables, the worked examples, and the graded rubric that says what good looks like rather than only what bad looks like.

## Part 1 — Reasoning and rhetoric

Distilled from 3 Lenny's Podcast transcripts (CPO Figma, CDO Reforge, CTO Netflix; n=3, method and limits in the internal source `docs/research/2026-07-26-lennys-podcast-senior-pm-voice-patterns.md`). Treat this section, not that file, as what's available at runtime.

**1. Reason out loud, then resolve** (high confidence, 3/3). Pose the sharpening question mid-thought and answer it in the same breath, rather than asserting a bare conclusion.
- Weak: "You should prioritize retention."
- Strong: "The real question is whether this is retention or acquisition. Given churn concentrates in week one, it's retention."

**2. Keep 2–3 named diagnostic questions ready** (medium confidence, 3/3 qualitative). Not "ask more questions" — specific reusable ones, deployed at the right moment. Example: "What's the headline here, philosophically — never mind whether you can measure it yet."

**3. Cite, then credit** (high confidence, 3/3). Ground an opinion in a named framework or precedent instead of confident adjectives ("clearly", "obviously"). Where the framework isn't yours, say whose it is — credit-sharing reads as more authoritative, not less.

**Do not port** these spoken-medium artifacts into writing: filler ("you know", "I mean"), acknowledgment openers ("Great question", "Yeah, totally"), run-on sentences, and intensifiers (*really*, *very*, *totally*, *absolutely*) standing in for the sourcing pattern 3 requires.

## Part 2 — Sentence mechanics (ASD-STE100)

Mechanics only, not the flat aerospace register — PM OS stays opinionated. Source: [danyuchn/asd-ste100-skill](https://github.com/danyuchn/asd-ste100-skill), a practical subset of the ~53-rule standard rather than a reproduction of it.

| Rule | Do | Don't |
|---|---|---|
| One word, one meaning | Pick one verb per action and reuse it (always "check") | Rotate synonyms for the same idea ("check"/"verify"/"confirm") |
| Active voice | "The hook injects the reminder." | "The reminder is injected." — unless the actor is genuinely unknown |
| Simple tenses | "We shipped the fix." | "We have shipped the fix." |
| One claim per sentence | "Open the file. Check line 3." | "Open the file and check line 3, then see if it matches." |
| Sentence length | ≤20 words for instructions, ≤25 for description | Long subordinate-clause chains |
| Noun clusters | ≤3 words stacked ("fuel pump valve") | 4+ stacks ("high pressure fuel pump inlet valve assembly") |
| No ellipsis | Keep subject, verb, and article explicit | Drop words into ambiguity ("Files not backed up will be lost" — which files?) |
| Paragraph limits | One topic per paragraph | Multi-topic paragraphs |
| Lists for sequences | A list for 3+ steps or conditions | A sequence buried in one prose sentence |
| Domain terms | Keep necessary PM terms, define once | Jargon never defined |

## Part 3 — The ceiling: graded anchors

The floor is easy to spot; the ceiling needs an example. Grade 1/3/5 per dimension.

| Dimension | 1/5 | 3/5 | 5/5 |
|---|---|---|---|
| Self-posed reasoning | States a conclusion with no visible fork | Names a tradeoff but leaves it open | Poses the sharpening question and resolves it in the same breath, naming the deciding factor |
| Question sharpness | Generic open question ("thoughts?") | Relevant but improvised | A specific, named, reusable diagnostic that fits the moment |
| Epistemic sourcing | Asserts with adjectives | Cites a framework, no attribution | Cites the framework *and* credits whose it is |
| Voice hygiene | Filler, "Great question", 2+ intensifiers | Clean but generic corporate register | Zero filler, zero unearned intensifiers, reads as one person's judgment |
| Sentence mechanics | Passive, run-ons, 4+ noun stacks | One or two violations | Active throughout, one claim per sentence, no ambiguous ellipsis |

## Running an audit

Grade each of the five dimensions against Part 3, quote the exact sentence that earned each grade, and write one concrete rewrite for every dimension scoring below 5. Show the 5/5 version rather than naming the flaw.

Done when all five dimensions carry a grade, a quoted line, and — below 5 — a rewritten line the user could paste in.

## Running a rewrite

Apply Part 2's mechanics first, since they are checkable, then Part 1's rhetorical patterns where the content allows. Rewriting someone else's factual claim doesn't license inventing a framework-naming moment that was never theirs. For a mechanics-only request, return the table format:

```markdown
| Rule violated | Original | Simplified |
|---|---|---|
| Present perfect tense | "We have received your request." | "We received your request." |
| Noun cluster (4+ words) | "the agent task queue priority handler" | "the handler that sets task-queue priority" |
```

Done when every Part 2 violation in the source text appears as a row with its rewrite, and no rhetorical pattern has been added that the source content doesn't support.
