# Onboarding phases — full Q&A scripts

Disclosed detail for [`pm-os-start`](../SKILL.md). Read the section for the phase you've actually reached — not the whole file up front. Every phase follows the same shape: ask, draft, show, and confirm before saving. Every section labeled "fire setup ping" is conditional on the explicit `telemetry_consent` captured by the parent flow. When consent is not yes, skip its message, webhook read, and curl command entirely; local onboarding still succeeds.

## Phase 1: Company
**Step 1 of 4: Your company context**

**Step 1a — Two free-text questions (the only typing required in this phase):**

Ask one at a time:
1. "What's your company name?"
2. "What's your company website? (e.g. acme.com — skip if you don't have one)"

**Step 1b — One structured question:**

Use the active host's structured input surface when available, otherwise lettered conversational options:
"Is [Company] publicly traded?"
- A. Yes — listed on a stock exchange
- B. No — VC or PE backed
- C. No — bootstrapped or self-funded
- D. It's not really a company (govt, nonprofit, academia, or I'm solo)

**Step 1c — Web search:**

Use the active host's web-search capability when available, with the company name and website, to infer:
- Industry and category
- Approximate headcount and stage
- Business model (B2B, B2C, marketplace, etc.)
- Known competitors
- If publicly traded: revenue, market cap, key financial metrics
- Any recent news or notable context relevant to a PM

**Step 1d — Present findings and draft:**

Say: "Here's what I found about [Company]. Tell me what's wrong or say 'looks good' to save it."

Show a complete draft of `📂 Context/COMPANY.md` filled in with what you found. Be specific — use real numbers and real competitor names. Flag anything you weren't sure about.

Only save to `📂 Context/COMPANY.md` after the user explicitly confirms (says "looks good", "yes", "save it", or similar). If they correct something, update the draft and confirm again before saving.

**After saving COMPANY.md — fire setup ping and show progress echo:**

Read `feedback-config.md` to get `webhook_url`.

Say one line: *"Noted — logging your progress."*

Run:
```bash
curl -s -L -X POST "[webhook_url]" \
  -H "Content-Type: application/json" \
  -d "{\"event\": \"setup:company\", \"company\": \"[company name]\", \"industry\": \"[industry]\", \"funding_stage\": \"[A/B/C/bootstrapped/public/etc]\", \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
```

If curl is unavailable or fails, silently continue — do not surface an error.

Then say: **"Got it — [Company Name] is set. 3 steps left."**

Done when `📂 Context/COMPANY.md` is saved with explicit confirmation and the setup ping has fired (or failed silently).

## Phase 2: Product or Capability
**Step 2 of 4: Your product context**

Ask all structured questions first, then the one free-text question. Batch Q1, Q3, and Q4 only when the host explicitly supports batched structured input; otherwise ask one at a time. Q4 is multi-select.

**Q1 (structured — single select):** "What best describes what you're working on?"
- A. A single product with one core user flow
- B. A product with many feature areas or modules
- C. A suite of separate products under one company
- D. A feature or capability inside a larger product (e.g. search, payments, notifications)
- E. An internal tool or developer platform
- F. Pre-launch — still building v1
- G. Something else (describe briefly)

**Q2 (free text — semi-optional):** "Describe your product in a sentence or two. A rough answer is fine — we'll refine this together. If you'd rather skip this, say 'skip' and I'll draft something from your other answers."

**Q3 (structured — single select):** "What stage is it at?"
- A. Pre-launch (still building, not yet live)
- B. Early (live, still figuring out fit)
- C. Growing (found its footing, scaling usage)
- D. Scaling (fast growth, managing complexity)
- E. Mature (stable, optimising)

**Q4 (structured — multi-select up to 2):** "What's your biggest PM challenge right now? Pick up to 2."
- A. Not sure what to build next
- B. Usage or adoption isn't growing
- C. Engagement or retention is dropping
- D. Hard to get alignment on priorities
- E. Managing scope and complexity
- F. Coordinating across many teams
- G. Competitive pressure — need to move faster
- H. Technical constraints slowing product velocity
- I. Something else (describe briefly)

Draft `📂 Context/PRODUCTS.md` from all four answers. For Q2 "skip" responses, synthesise a one-liner from Q1 and Q3. Show the draft. Confirm before saving.

**Important — write structured tags to PRODUCTS.md before saving:**

Write the following tags as the first block inside `📂 Context/PRODUCTS.md`, immediately after the file heading. These are the values the telemetry ping and finish screen routing engine will read back — they must be accurate.

```
product_type: [full label text of Q1 option selected, e.g. "A feature or capability inside a larger product"]
product_stage: [full label text of Q3 option selected, e.g. "Early (live, still figuring out fit)"]
challenges: [full label text of Q4 selection(s), comma-separated]
```

**Custom text rule:** If the user selected "Something else (describe briefly)" for Q1 or Q4, write their actual custom text as the value — not the label "Something else". For example, if they typed "Internal analytics dashboard for finance team", write `product_type: Internal analytics dashboard for finance team`.

**After saving PRODUCTS.md — fire setup ping and show progress echo:**

Read `feedback-config.md` to get `webhook_url`.

Re-read the structured tags you just wrote to `📂 Context/PRODUCTS.md` to get the exact values for the curl payload.

Run:
```bash
curl -s -L -X POST "[webhook_url]" \
  -H "Content-Type: application/json" \
  -d "{\"event\": \"setup:product\", \"company\": \"[company name from COMPANY.md]\", \"product_type_v2\": \"[product_type tag value from PRODUCTS.md]\", \"product_stage\": \"[product_stage tag value from PRODUCTS.md]\", \"challenges\": \"[challenges tag value from PRODUCTS.md]\", \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
```

If curl is unavailable or fails, silently continue.

Then say: **"[product_type tag value] at [product_stage tag value] — saved. 2 steps left."**

Done when `📂 Context/PRODUCTS.md` is saved with its structured tags accurate and confirmed, and the setup ping has fired (or failed silently).

## Phase 3: Role & Team
**Step 3 of 4: Your role and team**

*PM OS uses your team size and constraints to calibrate how to frame stakeholder and decision workflows. You can update this anytime.*

Batch all three questions only when the host explicitly supports batched structured input; otherwise ask them one at a time.

**Q1 (structured — single select):** "What's your PM level?"
- A. PM or Associate PM (earlier career)
- B. Senior PM
- C. Staff or Principal PM
- D. Head of Product or Group PM (managing other PMs)
- E. VP or CPO (exec level)

**Q2 (structured — single select):** "How big is your immediate cross-functional team?"
- A. Just me (solo PM, no dedicated team)
- B. Small (1–4 engineers, 1 designer)
- C. Medium (5–10 engineers, 1–2 designers)
- D. Large (10+ engineers, multiple designers)

**Q3 (structured — single select):** "Where's your biggest friction right now?"
- A. Getting engineering aligned on priorities
- B. Getting leadership buy-in on my decisions
- C. Coordinating across many teams or functions
- D. No major friction — things are working well

Draft `📂 Context/TEAM.md` from the answers. Show it. Confirm before saving.

**After saving TEAM.md — fire setup ping and show progress echo:**

Read `feedback-config.md` to get `webhook_url`.

Run:
```bash
curl -s -L -X POST "[webhook_url]" \
  -H "Content-Type: application/json" \
  -d "{\"event\": \"setup:team\", \"company\": \"[company name from COMPANY.md]\", \"pm_level\": \"[Q1 answer]\", \"team_size\": \"[Q2 answer]\", \"friction\": \"[Q3 answer]\", \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
```

If curl is unavailable or fails, silently continue.

Then say: **"Team context saved. Last step."**

Done when `📂 Context/TEAM.md` is saved with explicit confirmation and the setup ping has fired (or failed silently).

## Phase 4: Goals
**Step 4 of 4: Your goals and focus**

Batch Q1 and Q2 only when the host explicitly supports batched structured input; otherwise ask separately. Q1 is multi-select.

**Q1 (structured — multi-select up to 2):** "What are you most focused on right now? Pick 1–2."
- A. Shipping a specific initiative or feature
- B. Building or improving team process
- C. Defining product strategy
- D. Improving stakeholder communication
- E. Moving a specific metric (retention, adoption, NPS, revenue)
- F. Career development (promotion, new role)
- G. Figuring out what to work on next
- H. Something else (describe briefly)

**Q2 (structured — single select):** "What does 'winning' look like for you in the next 90 days?"
- A. I shipped something significant that I'm proud of
- B. I earned trust from a key stakeholder or executive
- C. I built a process or system my team will use after I leave
- D. I moved a metric I can tell a story about
- E. I got promoted or landed a better role
- F. I reduced the chaos — things are more structured than they were
- G. I'm not sure yet — help me figure out where to start

**Option G escape hatch:** If the user selects "I'm not sure yet — help me figure out where to start", proceed normally. Use "Exploring — determining strategic focus" as the win tag value when writing GOALS.md. At the finish screen, route to `/opportunity`.

**Important — write structured tags to GOALS.md before saving:**

Write the following tags as the first block inside `📂 Context/GOALS.md`, immediately after the file heading:

```
focus: [full label text of Q1 selection(s), comma-separated]
win: [full label text of Q2 selection]
```

**Custom text rule:** If the user selected "Something else (describe briefly)" for Q1 (focus), write their actual custom text as the focus value — not the label "Something else".

Draft the rest of `📂 Context/GOALS.md` from the answers. Show it. Confirm before saving.

**After saving GOALS.md — fire setup complete ping:**

Read `feedback-config.md` to get `webhook_url`.

Re-read the structured tags from `📂 Context/PRODUCTS.md` and `📂 Context/GOALS.md` to get exact values. Determine `recommended_command` by matching keyword patterns in the challenges and win tag values (used in both the ping and the finish screen — see the mapping table in the Wrap-up section below):

Run:
```bash
curl -s -L -X POST "[webhook_url]" \
  -H "Content-Type: application/json" \
  -d "{\"event\": \"setup:complete\", \"company\": \"[company name from COMPANY.md]\", \"pm_level\": \"[pm_level from TEAM.md]\", \"focus\": \"[focus tag value from GOALS.md]\", \"win\": \"[win tag value from GOALS.md]\", \"product_type_v2\": \"[product_type tag value from PRODUCTS.md]\", \"challenges\": \"[challenges tag value from PRODUCTS.md]\", \"recommended_command\": \"[command determined above]\", \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
```

If curl is unavailable or fails, silently continue.

After saving GOALS.md, offer: "Want to also fill out your team capacity and constraints? It's optional, but useful for PRDs and prioritisation decisions. Say yes to do it now, or we can skip it."

If yes: walk through `📂 Context/CONSTRAINTS.md` with a few targeted questions about engineering capacity, release cadence, and key technical constraints. Draft, show, confirm.

Done when `📂 Context/GOALS.md` is saved with its structured tags accurate and confirmed, `recommended_command` is determined, and the setup-complete ping has fired (or failed silently).

## Phase 5: Stakeholder Profiles (Optional)

After CONSTRAINTS.md is saved (or skipped), offer:

"Last optional step — want to add stakeholder profiles? This helps the system tailor meeting prep, communication style, and stakeholder management advice to the real people you work with. Takes about 2 minutes per person. Say yes to add 1–3 stakeholders now, or skip."

If the user skips, proceed directly to Wrap-up.

If yes, proceed:

**Ask: "How many key stakeholders do you want to add? (1, 2, or 3 — you can always add more later)"**

For each stakeholder (repeat up to 3 times):

**Q1 (free text):** "What's their name and role?" (e.g. "Sarah — VP Engineering")

**Q2 (structured — single select):** "How do they prefer to communicate?"
- A. Async (Slack / email first)
- B. Synchronous (prefers meetings and calls)
- C. Written memos or docs first, then discuss
- D. Mixed — depends on urgency

**Q3 (free text):** "What are their top 1–2 priorities right now?" (rough answer is fine)

**Q4 (structured — single select):** "How do they make decisions?"
- A. Data-driven — needs evidence before committing
- B. Fast and instinct-led — moves quickly, refines later
- C. Consensus-seeker — needs alignment across the group
- D. Top-down — decides and expects execution

**Q5 (free text, optional):** "Anything that frustrates them or slows things down?" (Say 'skip' to move on)

After all stakeholders are collected, draft `📂 Context/STAKEHOLDERS.md` using the template format. Show it. Ask: "Does this look right? Say 'save it' to confirm, or correct anything."

Only save after explicit confirmation.

Done when the user has either skipped, or every stakeholder's profile is confirmed and `📂 Context/STAKEHOLDERS.md` is saved.

## Phase 6: Communication Style (Optional)

After stakeholders (or when stakeholders is skipped), offer:

"Quick optional step — want to tune the AI's tone and format to your preferences? This updates `📂 Context/MY_STYLE.md` with things like preferred output format (BLUF vs. narrative), depth (concise vs. detailed), and Slack tone. Takes about 60 seconds. Say yes or skip."

If the user skips, proceed to Phase 7.

If yes, use the host's structured input surface for four questions. Batch only when the active runtime explicitly supports it; otherwise ask one at a time:

**Q1 (single select):** "Default output format?"
- A. BLUF — lead with the answer, supporting detail after
- B. Narrative — build up the reasoning, then the recommendation
- C. Depends on audience — let me choose per situation

**Q2 (single select):** "Preferred depth?"
- A. Concise — give me the minimum to act
- B. Detailed — walk me through the full reasoning
- C. Concise with optional drill-down — start short, expand on request

**Q3 (single select):** "Slack tone?"
- A. Direct — short, no fluff
- B. Friendly — warm but professional
- C. Formal — precise and deliberate

**Q4 (single select):** "How much should I push back when I notice bad-PM patterns in how you work?"
- A. Off — don't proactively flag anything; I'll ask if I want a check
- B. Soft — a light question when something's off, and offer real coaching only if it's a repeated pattern (recommended)
- C. Proactive — the moment you sense I'm stuck or making excuses, offer to dig in

Update `📂 Context/MY_STYLE.md` — replacing only the three placeholders corresponding to Q1–Q3 with the full label text. Leave all other fields as placeholders (they stay optional). Show the updated file and confirm before saving.

Separately, write Q4's answer to `📂 Context/Work/.hook-state/coaching-settings.json` (create the file; this is local hook-state, not part of `MY_STYLE.md` — it needs to be read byte-exact by other skills, not re-interpreted from prose):
```json
{"intensity": "off" | "soft" | "proactive", "updated_at": "<current iso8601Z timestamp>"}
```
No separate confirmation needed for this write — it's covered by the same "show the updated file and confirm" step above.

Done when the user has either skipped, or `📂 Context/MY_STYLE.md` and `coaching-settings.json` are both saved/written.

## Phase 7: First Project (Optional)

After communication style (or when skipped), offer:

"One more optional step — want to create your first project folder? Every piece of work in PM OS lives under a project: strategy, research, decisions, meetings, measurements all co-locate in `📂 Context/Work/{project-slug}/`. This makes context easy to find and prevents files from scattering across type-based folders. You can skip this and create one later by typing `/project new` anytime."

If the user skips, proceed to Wrap-up.

If yes:
1. Ask: "What's the working name of the project you're focused on right now?" (free text)
2. Derive slug (lowercase kebab-case, max 40 chars, strip articles).
3. Show: `Name: "Mobile Payments Revamp" → Slug: mobile-payments-revamp`. Ask: "Look right? (Y/n)".
4. On yes, create `📂 Context/Work/{project-slug}/` and write `📂 Context/Work/.current` with the slug.
5. Drop a minimal `README.md` inside the folder (see `skills/pm-os-project/SKILL.md` for the template).
6. Confirm: "Created `{project-slug}/`. Any workflow you run now will save output here."

Done when the user has either skipped, or the project folder exists with `.current` pointing at it.

## Wrap-up: Personalised Finish Screen

After all context is saved, output the following — personalised, not generic:

---

**"PM OS is now configured for [Company Name].**

Your Context files are set up with your product type, challenge areas, and goals.

You're focused on **[challenges tag value from PRODUCTS.md]** and want to **[win tag value from GOALS.md]**.

**Your best first session:** `[recommended_command from mapping table]`
[One sentence explaining why, drawn from this table:]

| Command | Why sentence |
|---------|--------------|
| `/stakeholder` | "Map the power dynamics on your current initiative before you commit to a plan." |
| `/strategy` | "Define the strategic crux before building anything — this is where to start." |
| `/opportunity` | "Map what problems are worth solving before picking a solution." |
| `/decisions` | "Classify your tradeoffs as reversible or permanent — velocity starts here." |
| `/help` | "Take a tour of everything available and pick what resonates for your situation." |

Type it now to run your first workflow.

All 10 workflows are available anytime. Type `/help` to see the full menu, or `/skill-browser` to browse the full library visually."

---

**`recommended_command` mapping table** (match challenges tag against win tag; first match wins):

| If challenges tag contains… | And win tag contains… | Recommended command |
|-----------------------------|------------------------|---------------------|
| "alignment" or "many teams" or "coordinating" | "ship" or "trust" | `/stakeholder` |
| "scope" or "complexity" | "process" or "system" or "chaos" | `/strategy` |
| "adoption" or "retention" | "metric" | `/opportunity` |
| "competitive" or "technical constraints" | "ship" | `/decisions` |
| "not sure what to build" | (any) | `/opportunity` |
| "career" or "promotion" | "promoted" or "role" | `/strategy` |
| "Exploring" (escape hatch win) | (any) | `/opportunity` |
| (no strong match) | (any) | `/help` |

**After the finish screen, offer the getting-started guide:**

Say: "Want me to create a personalised getting-started guide? It shows you exactly which workflows to run first and how long each takes. Takes about 10 seconds. Say yes or skip."

If yes, generate `📂 Context/Work/getting-started.md` with this structure:

```markdown
# PM OS: Getting Started — [Company Name]
*Generated [date]*

## Your Setup
- **Product:** [product_type tag value from PRODUCTS.md] at [product_stage tag value from PRODUCTS.md]
- **Top challenges:** [challenges tag value from PRODUCTS.md]
- **90-day win:** [win tag value from GOALS.md]

## Session 1 — Right now (~30 min)
Type `[recommended_command]` to start. [Why sentence from mapping table.]
Each workflow takes 20–45 minutes of back-and-forth. You'll have a usable output by the end.

## Session 2 — After your next meeting or call (~30 min)
[Follow-on workflow matched to challenge + win — e.g. if stakeholder → /decisions; if opportunity → /research or /assumptions]
Run this after you have a real situation to work through — a meeting, a decision, a piece of feedback.

## Session 3 — When you have something to communicate (~20 min)
[/stakeholder or /meeting depending on challenge]
Use this before a difficult conversation, a leadership review, or a cross-functional sync.

## Session 4 — When you're ready to review a document (~30 min)
`/review` — paste in any PRD, strategy doc, or roadmap and get 7 cross-functional perspectives in one pass.

## Quick Reference: All 10 Workflows

| Command | Typical session | What it does |
|---------|-----------------|--------------|
| `/strategy` | 30–45 min | Build strategy from crux to competitive analysis |
| `/opportunity` | 30–45 min | Map opportunity space, select one target |
| `/assumptions` | 20–30 min | Generate and prioritise risky assumptions |
| `/research` | 30–45 min | Transcript → JTBD → hypothesis → experiment |
| `/decisions` | 20–30 min | Root cause → reversibility → recommendation |
| `/stakeholder` | 30–45 min | Power map → comms plan → meeting prep |
| `/meeting` | 20–30 min | Hidden agendas → influence tactics → summary |
| `/review` | 20–30 min | 7 cross-functional perspectives on any document |
| `/coaching` | 20–45 min | Situation retrospective, blind spots, decision audits |
| `/measure` | 30–45 min | Clarify what's worth measuring → VoI → sampling plan |

Plus `/project` to create, list, switch, or archive project folders — every workflow's output lands there.

## Tune how the AI talks to you

Edit `📂 Context/MY_STYLE.md` anytime to change output format (BLUF vs. narrative), depth, and tone. It only affects how the AI *frames* responses — the behavioural rules (gate question, Knowledge citations, Context Guard) stay on regardless.

Type `/help` anytime for a full tour.
```

Show a brief preview and confirm before saving to `📂 Context/Work/getting-started.md`.

Note internally: retain the recommended_command from Phase 4. When the user runs `/help`, pass this as context so the tour can surface the most relevant first suggestion.

Done when the finish screen has been shown and the user has either confirmed or skipped the getting-started guide.
