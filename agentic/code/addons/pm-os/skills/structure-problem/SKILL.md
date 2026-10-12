---
name: structure-problem
description: >-
  Use when a messy problem needs a clear recommendation and you do NOT need a full issue tree — a top-down (deductive) and bottom-up (inductive) pass that *converge* on one answer, delivered answer-first. Also /decisions Step 5, taking the MECE option tree and causal map as input and returning a Pyramid-Principle recommendation. Not for building the issue tree itself (`mckinsey-issue-tree`), a MECE decomposition (`mece-tree`), root-cause diagnosis alone (`causal-tree`), or framing the problem before analysis (`problem-framing-canvas`).
---

# Converge a messy problem onto a recommendation

## Step 1 — Frame the problem and the decision it must produce

State the problem in one sentence and the decision it has to produce — what will be decided and by whom. When arriving from `/decisions` Step 5, take the MECE option tree (Step 4) and the causal map (Step 1) as your material; standalone, gather the problem and the key facts you have.

Done when the problem is one sentence, the decision it must produce is named, and the input material (option tree + causal map, or gathered facts) is in hand.

## Step 2 — Deductive pass (top-down)

From the general situation, walk down the options — branch the plausible answers and note the cause-and-effect that makes each rise or fall. Keep the tree shallow; the goal is to weigh options, not to enumerate every leaf.

Done when the plausible answers are branched with the cause-effect logic that raises or lowers each.

## Step 3 — Inductive pass (bottom-up)

From the specific data points, examples, and cases you actually have, name the pattern they point to. Evidence you don't have is a gap, not a pattern — say so rather than inferring past it.

Done when the concrete evidence is listed and the pattern it supports is named, with gaps flagged as gaps.

## Step 4 — Converge

Set the two passes against each other. Where top-down and bottom-up agree, that agreement is the spine of the answer. Where they conflict, name the conflict and the specific evidence that would resolve it — don't smooth it into a false consensus.

Done when the agreements are named as the spine and every conflict is stated with what would resolve it.

## Step 5 — Recommend, answer-first

State the recommendation in one sentence **first**, then the supporting logic beneath it (Pyramid Principle — answer on top, reasons under). Close with the single evidence gap that would change the call.

Done when the recommendation leads with a one-sentence answer, the support sits beneath it, and the change condition is one checkable fact.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-structure-problem-{problem-slug}.md`. Never hand-build the path.

The doc holds: the framed problem and its decision, the deductive branches, the inductive patterns with gaps, the convergence and conflicts, and the answer-first recommendation with its change condition.
