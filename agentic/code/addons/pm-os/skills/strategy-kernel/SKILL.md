---
name: strategy-kernel
description: >-
  Use when a product situation needs Rumelt's three-part *kernel* — an honest diagnosis of what is actually going on, a guiding policy that chooses an approach, and the coherent actions that follow — built on a context check that refuses to proceed on fantasy inputs. Not for the seven-part strategy document (`product-strategy`), backcasting from an idealized end state (`limit-strategy`), or pointing existing strengths at one industry trend (`industry-strategy`).
---

# Build the strategy kernel

Richard Rumelt's kernel is three parts and nothing else: **diagnosis** (what is going on, simplified to what matters), **guiding policy** (the overall approach chosen to deal with it), **coherent action** (the coordinated steps that carry it out). A list of goals is not a strategy. A vision is not a strategy. Ambition without a diagnosis is what Rumelt calls bad strategy, and it is the default output when Step 1 gets skipped.

## Step 1 — Assess whether the context can carry a kernel

Pull from the user: the product and its category, company stage, team shape, market segment, customer base, business model; how long the product and the PM have existed and what phase the product is in; why this is happening *now* and who is asking; what data, stakeholders, and history they can actually reach; their constraints, undiscussables, and known blind spots; and what the finished kernel has to unblock.

Score context completeness 0–100 and confidence high/medium/low. Separate what they stated, what can be reasonably inferred, and what is missing but essential — for each gap, why it is critical and how to obtain it. Where context is short, ask 3–5 questions ranked `[CRITICAL]` / `[IMPORTANT]` / `[USEFUL]`, each with why it matters.

Done when completeness is scored, every critical gap has a named way to close it, and the user has answered the `[CRITICAL]` questions or explicitly accepted proceeding without them.

## Step 2 — Write the diagnosis

Name what is actually going on, simplified down to the one or two things that matter. Push past the presenting complaint to the structural obstacle — if the user has already run `find-the-strategic-crux`, that crux is the diagnosis and this step confirms rather than re-derives it. Start the history early enough to include the decisions that made today inevitable, not just the last two quarters.

Flag the anti-patterns as they appear: a solution masquerading as a problem, a real problem avoided for political reasons, only the last 3–6 months considered, one powerful voice (usually the CEO or the biggest customer) treated as the whole picture, resources assumed that do not exist.

Done when the diagnosis names a structural obstacle in one or two sentences and the user agrees it is the real one.

## Step 3 — Choose the guiding policy

The policy is a choice of approach that follows from the diagnosis and rules things out. Test it three ways: does it draw on a real advantage the user can evidence rather than assert; does it decline something specific rather than promise everything to everyone; and does the user hold the authority to make that trade-off. A policy that fails any of the three gets rewritten, not annotated.

Done when the guiding policy is one sentence, names what it declines, and passes all three tests.

## Step 4 — Lay out the coherent actions

Three to six actions that reinforce each other and carry out the policy. Coherence is the bar: name, for each pair, whether they compound or compete. Any action that would still be on the list under a different guiding policy is not coherent action — it is a to-do, and it comes off.

Done when every action traces to the policy, competing pairs are resolved, and each has an owner and a first move.

## Output

Produce: the context assessment (completeness score, explicit / implied / critical gaps, red flags, stakeholder map with influence and alignment), then the kernel — diagnosis, guiding policy, coherent actions — then immediate next steps for the next 24 hours and the first week.

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-strategy-kernel.md`. Never hand-build the path.
