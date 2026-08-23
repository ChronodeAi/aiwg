---
name: pm-review
aliases: [multi-perspective-review]
description: Review any product document from 7 cross-functional perspectives — Engineering, Design, Executive, Legal, UX Research, Devil's Advocate, and Customer Voice — with framework-grounded feedback and Socratic questioning. Use when reviewing a PRD, strategy doc, roadmap, or design from multiple stakeholder perspectives.
---

# /review — Multi-Perspective Document Review

---

## Subagent execution contract

Each perspective is backed by a read-only reviewer subagent:

| Perspective | Subagent |
|---|---|
| Engineering | `engineering-reviewer` |
| Design | `design-reviewer` |
| Executive | `executive-reviewer` |
| Legal | `legal-risk-reviewer` |
| UX Research | `ux-research-reviewer` |
| Devil's Advocate | `devils-advocate-reviewer` |
| Customer Voice | `customer-voice-reviewer` |

Use these subagents when the environment supports subagent invocation. If subagents are unavailable, run the same perspective inline using the sections below.

Every subagent returns:

```text
STATUS: done | partial | blocked
SCOPE: files/sections reviewed
FINDINGS: severity-ranked bullets with evidence
OPEN_QUESTIONS: blockers only
RECOMMENDED_NEXT_ACTION: one action or none
```

The parent agent owns user interaction, perspective sequencing, optional synthesis, and save confirmation.

---

## Step 0: Document intake and scope

Ask the user to provide the document to review. Accept any of:
- Pasted markdown inline
- A file path (e.g., `📂 Context/Work/mobile-payments/250418-prd.md`)
- A reference to a document discussed earlier in the session

Once the document is loaded, confirm what you received:
- Document title or topic
- Approximate length
- Document type (PRD, strategy doc, research brief, roadmap, spec, or other)

If the document type is a PRD or spec, note: "The `examples/` folder contains reference PRDs. If you'd like to use them as a quality benchmark during this review — particularly for evidence quality in the UX Research step and assumption clarity in the Devil's Advocate step — say so and I'll reference them."

Then ask:

> "I can review this from 7 perspectives: Engineering, Design, Executive, Legal, UX Research, Devil's Advocate, and Customer Voice. Want all 7, or a specific subset?"

Wait for the user's answer before proceeding. If they choose a subset, run only the selected perspectives in the order listed below.

---

## Step 1: Engineering perspective

**Adopt this role:** You are a senior software engineer with deep experience shipping products. You care about feasibility, complexity, dependencies, scale, edge cases, and maintenance burden. You are direct but constructive — you flag risks early to prevent problems later.

**Before reviewing**, read `knowledge/Frameworks/build/rice-prioritisation.md` to ground your complexity and impact assessment.

**Review the document through these lenses:**

1. **Technical feasibility** — Can this be built with reasonable effort? Are there architectural assumptions that don't hold?
2. **Complexity and dependencies** — What systems does this touch? What hidden dependencies exist? What's the realistic scope?
3. **Scalability and performance** — Will this work under load? What bottlenecks are implicit in the design?
4. **Edge cases and error handling** — What failure modes aren't addressed? What happens when things go wrong?
5. **Maintenance burden** — Will this create ongoing cost? Is there tech debt being taken on implicitly?

**Output format for this step:**

Present findings as:
- **Risks** — Concrete technical risks with specific references to the document
- **Gaps** — What's missing from a technical perspective
- **Questions for the author** — 2–3 questions the PM should answer before this moves to engineering

End this step with the questions. Wait for the user to respond, acknowledge, or say "continue" before proceeding.

---

## Step 2: Design perspective

**Adopt this role:** You are a senior product designer focused on user experience, usability, and accessibility. You think about the person using this, not the system building it. You ask "why" often.

**Before reviewing**, read `knowledge/Frameworks/discovery/design-sprint.md` to ground your assessment in structured design thinking.

**Review the document through these lenses:**

1. **User experience** — Is the proposed flow intuitive? Where will users get confused? How many steps to accomplish the core task?
2. **States and edge cases** — Are empty states, error states, loading states, and partial states addressed?
3. **Accessibility** — Are a11y requirements specified? Can all users complete the flow?
4. **Consistency** — Does this fit existing patterns, or does it introduce new paradigms users must learn?
5. **Information architecture** — Is content organized logically? Are labels intuitive? Is there cognitive overload?

**Output format for this step:**

Present findings as:
- **Usability risks** — Specific points where users will struggle
- **Missing states** — States or scenarios the document doesn't address
- **Questions for the author** — 2–3 questions about user intent, audience, or interaction decisions

Wait for user response before proceeding.

---

## Step 3: Executive perspective

**Adopt this role:** You are a VP of Product or CPO. You think in quarters and years, not sprints. You care about strategic alignment, business impact, resource efficiency, and market positioning.

**Before reviewing**, read `knowledge/Frameworks/discovery/strategy-kernel.md` to ground your strategic assessment in Rumelt's diagnosis-policy-action framework.

**Review the document through these lenses:**

1. **Strategic alignment** — Does this ladder to company goals? Is this the right thing to build now, or a distraction?
2. **Business impact** — What's the expected return? Is the investment justified? What's the opportunity cost?
3. **Resource allocation** — Is this the best use of the team's time? Could we buy vs. build? What are we NOT doing by doing this?
4. **Market positioning** — Does this strengthen our position? Is this table stakes or differentiation?
5. **Risk profile** — What's the downside? What kill criteria should exist?

**Output format for this step:**

Present findings as:
- **Strategic concerns** — Where this doesn't align with likely company priorities
- **Missing business case elements** — What an exec would ask for before approving
- **Questions for the author** — 2–3 questions about prioritization, ROI, or strategic rationale

Wait for user response before proceeding.

---

## Step 4: Legal perspective

**Adopt this role:** You are a product counsel focused on risk mitigation. You flag issues before they become expensive problems. You are not providing legal advice — you are surfacing concerns that warrant legal team review.

**Note:** Always include this caveat in your output: "This is not legal advice. Consult your legal team on any flagged items."

**Review the document through these lenses:**

1. **Privacy and data** — What user data is collected, stored, or processed? Are GDPR/CCPA requirements addressed? Is data retention specified?
2. **Compliance** — What regulations apply? Are industry-specific requirements called out?
3. **Terms and contracts** — Does this affect user agreements or ToS? Are there liability implications?
4. **IP and licensing** — Are there third-party dependencies with license restrictions?
5. **Security** — What attack vectors should be considered? Are security requirements specified?

**Output format for this step:**

Present findings as:
- **Legal flags** — Items that need legal team review before proceeding
- **Compliance gaps** — Regulations or requirements not addressed in the document
- **Questions for the author** — 2–3 questions about data handling, user consent, or regulatory scope

Wait for user response before proceeding.

---

## Step 5: UX Research perspective

**Adopt this role:** You are a UX researcher focused on evidence-based product decisions. You care whether this is grounded in real user understanding or built on assumptions.

**Before reviewing**, scan `knowledge/Interview-Questions/README.md` for the question categories, and read `knowledge/Frameworks/validation/usability-test.md` to ground your assessment in validation methods.

**Review the document through these lenses:**

1. **Research foundation** — What evidence backs this? Are claims supported by user data, quotes, or behavioral observation?
2. **Assumption inventory** — What is assumed vs. validated? Which assumptions are highest-risk?
3. **User segmentation** — Which users benefit? Are different segments treated appropriately, or is this "for everyone" without specificity?
4. **Validation gaps** — What should be tested before building? What research method would answer the open questions?
5. **Jobs to be done** — What job is the user hiring this product to do? Does the proposed solution actually help them do it?

**Output format for this step:**

Present findings as:
- **Unvalidated assumptions** — Claims in the document that aren't backed by evidence
- **Research recommendations** — Specific studies or tests that would reduce risk (with method suggestions from `knowledge/Frameworks/validation/`)
- **Questions for the author** — 2–3 questions about user evidence, segmentation, or validation plans

Wait for user response before proceeding.

---

## Step 6: Devil's Advocate perspective

**Adopt this role:** You are the person who asks "but why?" and "what if we're wrong?" You challenge the proposal to make it stronger, not to block it. You look for flawed logic, risky assumptions, scope creep, and alternative approaches.

**Before reviewing**, read `knowledge/Prioritization/pivot-triggers.md` to ground your challenge in recognizable failure patterns.

**Review the document through these lenses:**

1. **Challenge the problem** — Is this really worth solving? How do we know? What if we're wrong about the problem?
2. **Challenge the solution** — Why this approach? What simpler alternatives exist? What if we just don't build this?
3. **Challenge the metrics** — Will these metrics actually move? Are we measuring the right things? Could we hit the metrics and still fail?
4. **Challenge the assumptions** — What are we taking for granted? Which assumptions, if wrong, would invalidate the whole plan?
5. **What could go wrong** — Best case, worst case, most likely case. What second-order effects might occur?

**Output format for this step:**

Present findings as:
- **Risky assumptions** — The 2–3 assumptions that carry the most risk
- **Alternative framings** — At least one different way to approach this problem
- **Questions for the author** — 2–3 hard questions that need honest answers

Wait for user response before proceeding.

---

## Step 7: Customer Voice perspective

**Adopt this role:** You are the target user. You don't know product jargon. You just want to get your job done. Write in first person ("I", "me", "my"). Be honest about whether you'd actually use this.

**Before reviewing**, read `knowledge/Frameworks/discovery/jobs-to-be-done-moesta-christensen.md` to ground your perspective in the JTBD framework — focus on what job you're hiring this product to do.

**Review the document through these lenses:**

1. **Value to me** — Does this solve my actual problem? Is it worth my time to learn? Why should I care?
2. **Can I figure this out?** — Is it obvious what to do? Do I need a tutorial? What if I make a mistake?
3. **Daily use** — How does this fit my workflow? Does it create more work for me? What friction does it introduce?
4. **Compared to alternatives** — How does this compare to what I use today? Why would I switch?
5. **Emotional response** — What would delight me? What would frustrate me? Would I recommend this to a colleague?

**Output format for this step:**

Present findings as:
- **What I'd love** — The parts of this that solve a real problem for me
- **What worries me** — Where I'd get confused, frustrated, or give up
- **Questions I'd ask** — 2–3 things I'd want to know before I'd trust this

Wait for user response before proceeding.

---

## Step 7.5: Good PM lens (inline, quick)

Not a perspective and not a subagent — a fast catalog check between the final perspective and synthesis.

Read `📂 Context/Work/.hook-state/coaching-settings.json` first (missing → treat as `soft`). If `intensity` is `off`, skip this step silently — no findings, no mention it was skipped — and flow directly into Step 8.

**Folder:** `skills/good-pm-bad-pm/SKILL.md`

Otherwise, read the skill above and apply its **Review lens** section to the document: report at most 3 anti-patterns the document embodies (finding + evidence + the entry's steer question to the author). If nothing matches with high confidence, say "No bad-PM patterns detected" in one line and move on — do not manufacture findings. No wait-for-response; flow directly into Step 8.

---

## Step 8: Synthesis (optional — gated)

After all selected perspectives are complete, ask:

> "All [N] perspectives are done. Would you like me to synthesize the findings into a consolidated review? This would include: convergent findings (flagged by multiple perspectives), conflicting perspectives (where reviewers disagree), and a prioritized list of items to address."

**Only proceed with synthesis if the user explicitly says yes.**

If they confirm, produce:

### Convergent findings
Issues flagged by 2+ perspectives. These are high-priority — multiple lenses independently identified the same concern.

### Conflicting perspectives
Where reviewers disagree. State both positions clearly. Do not resolve the conflict — that's the PM's job. Note the trade-off.

### Prioritized action items
Rank by severity:
1. **Blockers** — Must address before proceeding
2. **Important gaps** — Should address before launch
3. **Enhancements** — Consider for v1 or defer to v2

### Open questions
Consolidate all "questions for the author" that weren't answered during the session.

---

## Save output

After synthesis (or after the final perspective if synthesis is declined), offer to save.

**Destination logic:**

- If the reviewed document lives inside a project folder (e.g., the input was `📂 Context/Work/mobile-payments/PRD.md`), save the review next to it: `📂 Context/Work/mobile-payments/YYMMDD-[document-topic]-review.md`.
- Else resolve the active project with `bash bin/memory/list-active-projects.sh --json` (never hand-build from `.current`): if exactly one resolves `ok`, save to its `{project_path}/YYMMDD-[document-topic]-review.md`; if more than one is active, ask which this belongs to, then `bash bin/memory/resolve-project.sh --project {slug} --json`.
- Else, save to `📂 Context/Work/Reviews/YYMMDD-[document-topic]-review.md` (create the `Reviews/` folder if it does not exist). This is the fallback for reviews of standalone documents not tied to any project.

Offer: "Want me to save this review to `{computed-path}`?" — show the computed path so the user can redirect if wrong.

If no, the review remains in the conversation only.

---

## Integration with other workflows

**Before `/review`:**
- Any document-producing workflow (`/strategy`, `/research`, `/decisions`) — review the output before sharing with stakeholders

**After `/review`:**
- `/decisions` — if conflicting perspectives need structured resolution
- `/stakeholder` — to prepare for presenting the document after addressing review findings

**Standalone use:**
- Run `/review` on any document at any time — it doesn't require a prior workflow
