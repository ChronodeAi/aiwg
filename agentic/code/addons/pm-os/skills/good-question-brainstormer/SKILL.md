---
name: good-question-brainstormer
description: >-
  Use when a topic, decision or vague curiosity needs better questions before
  it gets answers — 25+ candidates generated across seven lanes (why, what if,
  how, eigenquestion, contextual, appreciative, story/life), then sharpened
  and ranked into a top 5-10 with a best-first question and a next action.
  Also `mckinsey-issue-tree` Phase 6, applied to the crux. Not for generating
  ideas rather than questions (`brainstorm-genius`), deliberately strange
  provocation questions (`offbeat-questions`), framing the problem statement
  itself (`problem-framing-canvas`), or resolving one ambiguous request
  through follow-ups (`clarification-chain`).
---

# Improve the questions before answering them

A good question is ambitious yet actionable: it changes perception, exposes a hidden assumption, opens a new search space, or turns uncertainty into a next action. The failure mode is rushing to answers while the question is still the one the user walked in with.

For source material and question banks, read [`question-compendium.md`](question-compendium.md).

## Step 1 — Frame the terrain

Name the topic in one sentence. Identify the decision or problem behind it, who the question is for, what kind of answer would change behaviour, and whether the user needs exploration, a principle, an experiment or a decision.

Ask a clarifying question only if the topic is too vague to generate against.

Done when the topic is stated in one sentence and the needed output type is named.

## Step 2 — Question-storm across seven lanes

Generate more questions than feel necessary, and don't stop at the first obvious cluster. Work every lane:

- **Why** — causes, assumptions, beneficiaries, constraints, incentives
- **What if** — reversals, abundance, scarcity, removal, combination, weird possibilities
- **How** — experiments, prototypes, tests, collaborators, next actions
- **Eigenquestion** — the recurring debate sitting beneath many decisions
- **Contextual inquiry** — what must be observed up close in the real world
- **Appreciative inquiry** — what already works, and how to bring it back
- **Story/life** — what path creates a clearer identity or a better story

Done when at least 25 candidates exist for a serious problem and every one of the seven lanes has contributed at least one.

## Step 3 — Sharpen the strongest candidates

Rewrite the best candidates through these moves:

- **Open a closed question:** "Should we do X?" → "What would need to be true for X to be the right move?"
- **Close a broad question:** "How do we grow?" → "Which one user segment would miss us if we disappeared?"
- **Add ownership:** "Why is this broken?" → "What am I willing to do about this?"
- **Add action:** "Why does this happen?" → "What small test would teach us why?"
- **Add contrast:** "What should we build?" → "What should we stop building?"
- **Add stakes:** "What is the right option?" → "Which option would still matter a year from now?"

Done when every question carried into Step 4 has been through at least one of the six moves.

## Step 4 — Rank

Rank 5-10 questions. Favour those that reframe the problem, reveal an assumption or constraint, point toward an observation, test or decision, could generate several layers of answers, would still be useful after the immediate situation passes, and make the user a little uncomfortable in a productive way.

Reject the four failure shapes as you rank: questions too broad to act on, questions so narrow they only confirm the current plan, complaints dressed as questions, and cleverness with no use.

Done when 5-10 questions are ranked and each carries a one-line reason for its position.

## Step 5 — Name the first question and the next action

Pick the single question to ask first and say why it goes first. Then name the next action — a concrete observation, conversation, prototype or experiment that the first question points at.

Done when the best-first question and the next action are both stated, and the next action is something the user could start this week.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-questions-{topic-slug}.md`. Never hand-build the path.

The doc holds: the framing sentence, the ranked questions with reasons, the best-first question, and the next action. If the user asked for volume, include the raw 25-50 above the ranked set.
