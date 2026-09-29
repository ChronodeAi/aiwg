---
name: tech-to-business
description: >-
  Use when you need to translate a technical explanation for a non-technical stakeholder so they can make *the decision* in front of them — jargon stripped, an analogy where it helps, risks preserved, and their likely questions answered. Not for producing the technical architecture itself (`tech-arch-brief`), presenting a deck to leadership (`problem-deck`), or writing a status update (`status-update`).
---

# Translate technical explanations into stakeholder language

## Step 1 — Get the explanation and the audience

Capture the technical explanation and the stakeholder type (exec, internal team, customer). The audience shapes every choice that follows.

Done when the technical content and the stakeholder type are both known.

## Step 2 — Extract concepts and their likely questions

List the key technical concepts and their implications, then the questions this stakeholder will actually ask — cost, risk, timeline, what it means for them.

Done when the key concepts are listed and each is paired with the stakeholder question it raises.

## Step 3 — Translate without flattening the risk

Rewrite in jargon-free language with an analogy where it earns its place — but don't oversimplify the nuances or risks that matter to the decision. A translation that hides the risk is worse than none.

Done when the explanation is jargon-free and the decision-relevant risks are still intact.

## Step 4 — Structure for the decision

Lay it out: a short overview, the business impact in their terms, the risks/benefits/decisions to understand, and recommended next steps — answering the Step 2 questions directly. Keep a tiny glossary of any unavoidable terms.

Done when the output has overview / impact / considerations / answered questions / next steps, plus a glossary of retained terms.

## Step 5 — Match the voice

Read the relevant guide in `knowledge/Writing-Styles/` — `writing-style-executive.md` for exec/board, `writing-style-internal.md` for internal teams, `writing-style-customer.md` for external — and match the tone.

Done when the tone matches the audience's writing-style guide.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-tech-to-business-{topic-slug}.md`. Never hand-build the path.

The doc holds: the simplified explanation (overview, business impact, considerations, answered questions, next steps) and the glossary, tone-matched to the stakeholder.
