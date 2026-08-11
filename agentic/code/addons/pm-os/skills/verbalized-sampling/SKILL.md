---
name: verbalized-sampling
description: >-
  Use when an output set needs genuine diversity and "give me 10 ideas" keeps
  collapsing into one cluster — prompt for a probability distribution with
  tail sampling instead of a single response, load context first, then
  critique the results before presenting them. Also the generation mechanics
  behind `tech-sensemaking` Step 3. Not for a facilitated ideation session
  (`brainstorm-genius`), constraint-driven idea generation
  (`constrained-ideas`), or generating questions rather than answers
  (`good-question-brainstormer`).
---

# Verbalized Sampling

Asking a model for its single best answer gets the mode of its distribution. Asking it to *verbalize the distribution* — each candidate tagged with the probability it would have been generated — and then sampling the tail gets what the mode was hiding.

Diversity is only as good as the framing that goes in and the critique that comes out. Both phases below carry completion criteria; the rest of this file is reference.

## Universal template

```
[Task description with rich context]

Generate {k} responses. Return in JSON format with key "{output_key}" (list of dicts). Each dict:
• text: [output specification]
• probability: estimated probability (0.0–1.0) of this response given the input

{Distribution constraint}

Output ONLY the JSON object.
```

**Distribution constraints — pick one:**
- `Sample from the full distribution.` — balanced, moderate diversity
- `Sample from the tails of the distribution, with each probability below 0.10.` — high diversity
- `Sample from the tails of the distribution, with each probability below 0.01.` — maximum diversity

## Variant selection

| Variant | When to use | Trade-off |
|---|---|---|
| **VS-Standard** | Straightforward tasks, speed priority | Best balance |
| **VS-CoT** | Complex tasks needing quality + diversity | Slight diversity cost, higher quality |
| **VS-Multi** | Maximum diversity, token cost acceptable | Best diversity, 2× token cost |

**VS-CoT**: add `"reasoning": "step-by-step thought process"` as the first field in each dict.

**VS-Multi**: turn 1 generates k/2 responses. Turn 2: "Generate k alternative responses to the original prompt — do not repeat ideas from Turn 1."

## Context-first phase (before the VS prompt)

Thin context produces generic output no matter how deep you sample. Three moves:

1. **Decompose into subproblems.** Break the task into 3-5 distinct angles. "Improve sales for a B2B SaaS" → acquisition channels · trial conversion · pricing and packaging · referral · partnerships.
2. **Load context per subproblem.** The real constraints (time, budget, team size, org politics, market saturation), the base rates (what others in this space actually do, what has failed), and what has already been tried.
3. **Inject it into the preamble.** Compress the answers into the prompt, and name the subproblems as explicit coverage requirements: "Cover at least one idea addressing each of: […]".

If step 2 can't be answered without asking the user, ask before generating.

Done when every subproblem has constraints, base rates and prior attempts recorded, and all of them appear in the prompt preamble as coverage requirements.

## Critique-and-improve loop (after VS, before presenting)

Check each output on four questions: is it naive (would it appear in a top-10 listicle?), is it actionable (could execution start Monday without further research?), does it require magical thinking (assumes steps will "just work" with no mechanism?), does it ignore base rates (a known low-success approach presented as a good bet?).

If two or more items fail two or more checks, flag the specific failures with reasons, generate 2-3 improved variants that address them, and present the originals, the critique summary and the variants together.

The full 6-dimension framework and prompt templates are in `references/critique-framework.md`; LLM-as-Judge prompts for automated scoring are in `references/judges.md`.

Done when every output carries a verdict on all four checks, and any item failing two or more has either an improved variant or a stated reason for keeping it.

## Output mode

**JSON** (default for agent pipelines) — return raw JSON when outputs feed downstream processing, storage or evaluation.

**Readable** (in-chat or sharing) — group by diversity tier and show probabilities inline:

```markdown
## High diversity (p < 0.05)
1. [text] (p=0.03)

## Moderate diversity (p 0.05–0.15)
2. [text] (p=0.08)
```

CLI formatting: `echo '<json>' | python skills/verbalized-sampling/scripts/format_vs_output.py`

## Probability thresholds

| Threshold | Use case |
|---|---|
| Full distribution | General brainstorm, common + uncommon mix |
| p < 0.15 | Moderate novelty — avoids the top-5 obvious answers |
| p < 0.10 | High diversity — noticeably non-obvious |
| p < 0.05 | Aggressive — surprising, niche ideas |
| p < 0.01 | Maximum — edge cases, stress testing, adversarial |

## Failure modes

**FM-1: Overfit topic collapse.** High-frequency training topics (weight loss, productivity, exercise) resist VS even at p<0.01 — the tail is still inside the well-known cluster. The paper's 1.6-2.1× diversity gains apply to creative and niche domains, not saturated self-help. *Mitigation:* add exclusion constraints — "Exclude any idea covered in mainstream [domain] journalism. Prioritize ideas from adjacent fields or underrepresented subcultures."

**FM-2: Context starvation → generic gravity.** Thin context ("Xero + retention") produces generic-category outputs even at tail sampling. *Mitigation:* run the context-first phase above.

**FM-3: Semantic clustering despite syntactic diversity.** Tail sampling can produce a list that reads differently but covers the same solution space — VS does not cross problem-frame boundaries by itself. *Mitigation:* name the frames — "Cover at least one idea from each of: distribution, pricing, community, product, partnerships."

**FM-4: Probability spread collapse.** If highest and lowest probabilities sit within 3× of each other, diversity is illusory. Good output spreads 5-10×. *Diagnosis:* tight spread means you're in FM-1 or FM-2 — apply those mitigations.

## Meta-prompt: generate a VS prompt

```
I need to generate diverse {output_type} for {use_case}.

Create a Verbalized Sampling prompt that:
1. Clearly describes the task with specific context about {use_case}
2. Requests k={number} outputs in JSON format
3. Requires each output to include "text" and "probability" fields
4. Specifies a distribution constraint appropriate for the diversity level needed:
   - 0.10–0.15 for moderate diversity
   - 0.05–0.10 for high diversity
   - 0.01–0.05 for maximum diversity
5. Ends with "Output ONLY the JSON"
6. Includes explicit problem-frame coverage if the topic is likely overfit
```

Ready-to-paste domain templates — creative writing, brainstorming, dialogue simulation, synthetic data, adversarial examples, open-ended QA — are in `references/templates.md`.

## When not to use VS

A single correct answer exists · factual lookup or retrieval · strict format compliance is required · you need one best answer rather than a distribution · an overfit topic with no rich context available (add the context first, then re-evaluate).
