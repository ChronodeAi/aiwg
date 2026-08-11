---
name: rulebook-for-arguments
description: >-
  Use when a position has to hold up under someone trying to break it — building an argument from premises to conclusion, auditing an existing one for validity and fallacies, drafting an argumentative essay, or steelmanning both sides of a contested call — against Weston's *Rulebook*, with the conclusion held to exactly what the reasons establish. Not for ordering a document so its conclusion leads (`pyramid-principle`), testing whether a framing is clever rather than true (`de-clever`), or decomposing a problem into MECE branches (`mece-tree`).
---

# Build, audit, and steelman arguments

The full rule set — Weston's 45 rules, the 19 fallacies, and the three definition rules — lives in [`RULES.md`](RULES.md). Read it before running any mode below, and cite rules by number in the output so the user can check the call.

Four modes. Name which one you're in as the first line of the response; where the user hasn't said, infer from what they pasted and confirm in one sentence.

## BUILD — construct an argument

1. **Sharpen the claim** into a precise, arguable conclusion (R35). "Something should be done about X" gets rewritten before anything is built on it.
2. **Name the argument type** — generalization, analogy, causal, deductive, or proposal. Each pulls a different rule set from `RULES.md`.
3. **Draft 3–5 premises** leading to the conclusion, using a valid deductive form (R22–R28) wherever the material allows one.
4. **Stress-test each premise** (R3): would a skeptic grant it as stated? Mark which need sub-arguments of their own, and which need a citation (R13).
5. **Run the 19 fallacies** against every premise and inference.
6. **State the strongest objection** and answer it (R32), then show why this beats the plausible alternatives (R33).
7. **Set the confidence** to exactly what the premises establish (R39).

Done when every premise is either defended, cited, or explicitly flagged as an assumption the reader must grant — and the stated confidence matches, with no claim of certainty from inductive support.

## AUDIT — evaluate an existing argument

1. **Extract the structure**: conclusion, stated premises, and the implicit premises the argument needs but never states. The unstated ones are usually where it breaks.
2. **Check validity** where deductive — does the form match R22–R28, or is it affirming the consequent wearing a disguise?
3. **Rate each premise**: well-established, assumed, or contested.
4. **Apply the type-specific rules** — R7–R11 for generalizations, R12 for analogies, R18–R21 for causal claims.
5. **Scan all 19 fallacies**, naming each one found and where it sits.
6. **Check language** for loaded terms (R5) and equivocation (R6), then **check sources** for citation, expertise, impartiality, and corroboration (R13–R17).
7. **Check what's missing**: the strongest unaddressed objection (R32), the unexamined alternatives (R33), and any overclaiming (R39).

Done when the verdict is one of sound, valid but unsound, invalid, or weak inductive — every fallacy found is located in the text, and the single most important repair is named.

## ESSAY — argumentative writing

Run BUILD first: the 3–5 premise skeleton becomes the outline (R30, R36), with each section defending one premise. Open on the claim with no throat-clearing (R34), defend any premise a reader might doubt with its own sub-argument (R31), place the objections after the case is established rather than before (R37), show why this answer beats the alternatives (R33), and close on exactly what was established (R39).

Done when every section of the essay maps to one premise of the skeleton argument, and no paragraph supports nothing.

## DEBATE — steelman both sides

Both positions get the full BUILD treatment, then both get the full AUDIT. This is not a summary of common views — it is two complete arguments, each written as an advocate would write it.

1. **Build Position A** to full depth: precise conclusion, 3–5 premises, strongest form available, its own best objection answered, and what evidence would strengthen it further.
2. **Build Position B** to identical depth. Reducing B to a caricature of A is the straw man (R32) and voids the exercise.
3. **Audit both** against the fallacy list, premise reliability, overclaiming, and missing alternatives.
4. **Compare**: which side starts from better-supported premises, carries fewer undefended assumptions, better answers its objections, and claims more modestly?
5. **Declare which argument is currently stronger** in two or three sentences. Where it is genuinely close, say so and name the evidence that would tip it.

Done when both positions are argued at equal depth, neither is refuted with a claim its advocates wouldn't recognize, and the verdict names the evidence that would change it.

## Output

Present the mode's result inline. Where the argument is a project deliverable, resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json` and write to `{project_path}/YYMMDD-argument-{topic-slug}.md`. Never hand-build the path.

The doc holds: the mode, the precise claim, the numbered premises with the conclusion, which premises need defense or sources, the strongest objection and its answer, the fallacy check, and the confidence the argument actually earns.
