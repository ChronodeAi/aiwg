---
name: good-pm-bad-pm
description: >-
  Use when the user's own words show a bad-PM anti-pattern — a solution
  named before any problem, authority as the whole justification ("the CEO
  asked for it"), an excuse or a blamed team, "that's not my job", skipped
  validation, boilerplate or copied-competitor strategy, a roadmap of quick
  wins, a metric standing in for a judgment call, or a request to make a
  weak idea sound strategic — and one question should make them see it
  themselves. Also when they ask "am I being a bad PM?", and when /review
  or /daily-drip needs the good-PM catalog. Not for a full coaching session
  on a recurring pattern (`coaching`), auditing one decision's process
  (`decision-audit`), or stripping clever framing out of a claim
  (`de-clever`).
---

# Good PM / Bad PM

A catalog of bad-PM anti-patterns distilled from the field's canon, with a steering protocol. The unit of work is the **tripwire** — a high-confidence signal that the user is acting like a bad PM — and the **steer** — the one question that makes them see it themselves.

## Steering protocol

State lives in two small local files under `📂 Context/Work/.hook-state/` — gitignored, never distributed, read and written directly with your file tools (no intermediary script, so this works identically everywhere the skill runs):
- `coaching-settings.json` — `{"intensity":"off"|"soft"|"proactive","updated_at":"<iso8601Z>"}`
- `pm-patterns.jsonl` — one line per firing, `{"pattern":"<id>","at":"<iso8601Z>"}`

**Step 0 — read the intensity dial.** Read `coaching-settings.json`. Missing file, unreadable, or no `intensity` field → treat as `soft`. If `intensity` is `off`, none of the proactive steps below fire this turn — skip straight to the user's request. This gate does not apply to the Self-audit or Review lens branches, or to a direct request to run this skill — those are explicit, not proactive.

**Step 1 — match the signal.** Compare the user's message against the catalog below. Fire only on a high-confidence signal — the user's words clearly instantiate an entry's *Signals*. Ambiguous or merely adjacent → do not fire. Done when you can quote the words that tripped the wire.

**Step 2 — recall-before-steer.** Before asking anything blind, check whether the answer already lives in the user's own memory:
- If a project is active (`bash bin/memory/list-active-projects.sh --json`), pull its recall packet (`bash bin/memory/build-recall-packet.sh --project {slug} --json`) and scan `decisions`, `constraints`, `open_questions`, `recent_sources` for anything bearing on this tripwire's topic. Also read `📂 Context/Work/.hook-state/user-memory.md` if present.
- **Found it** → skip the blind question. Reflect it back and test alignment instead — e.g. *"Your [artifact] says [X] is the priority — does this work serve that, or is it a detour?"* That reflection **is** the steer for this firing; go straight to Step 4.
- **Not found, no active project, or the lookup errors** → this is the ordinary case, not a failure. Fall through silently to Step 3.

**Step 3 — deliver the steer.** Check repeat status by reading `pm-patterns.jsonl` (missing file → no prior firings) and counting lines for this pattern's id, plus anything fired earlier in this session. First offense → ask the entry's *Steer* question (or Step 2's reflect-back), at most two sentences of setup. Repeat offense → name it first — "That's the **{Name}** pattern: {Principle}" — then ask. Ask as genuine curiosity, not a test: the goal is the user seeing it themselves, not being proven wrong.

**Step 4 — log the firing.** Read `pm-patterns.jsonl` (missing → treat as empty), append one line `{"pattern":"{id}","at":"{iso8601Z timestamp}"}`, write the full file back. Silent — never announced.

**Step 5 — read and classify the reply**, on the user's next turn:

| Reply pattern | Read | Response |
|---|---|---|
| Concrete facts, named constraints, a real reason, genuine reconsideration | Real answer | Acknowledge specifically — tie it to what they actually said, not a generic affirmation. If it's durable, offer once: *"Want me to save that so I don't ask again?"* → hand off to `/capture-memory` on yes. Proceed. |
| Vague, brushes past, minimizing ("whatever, just do it") | Possible deflection | **One** follow-up only, in a "fine, there's a reason — let's move forward from here" tone. Never loop a second time. Proceed regardless of what comes back. |
| Self-blame spiral, "I have no say," "it's always like this," visible overwhelm, framing the situation as entirely without agency | Distress / low agency | Shift stance immediately: reflect and validate, don't challenge. No pattern-naming, no principle-lecture this turn. Note it for Step 6. Proceed warmly. |

This read is provisional for one exchange, not a verdict on the user — the moves trigger the tests, not a label. Tie every read to the specific words used this turn, never to inferred personality.

**Step 6 — the escalation offer**, gated by Step 0's dial:
- `off` → never offered.
- `soft` (default) → offer once when this pattern's firing count (from `pm-patterns.jsonl`) reaches 3, or when a distress-classified reply has now happened twice, whichever comes first.
- `proactive` → offer once on the *first* distress-classified reply, in addition to the `soft` thresholds.

Offer copy: *"This has come up a few times — want to spend some real time on it? I'd hand you to a proper coaching session."* Never re-offer in the same session if declined. On yes: hand off via the `/coaching` command with the recurring pattern as opening context (name, principle, firing count, most recent trigger) so the coaching orchestrator doesn't ask the user to re-explain from scratch. Suggest a default mode — same pattern recurring → `blind-spot-scan`; tied to one named relationship → `adversarial-roleplay`; one vivid recent incident → `situation-retrospective` — but the orchestrator's own entry-detection has final say.

**Step 7 — complete the user's original request regardless.** The steer is a detour of one question, never a refusal, a lecture, or a gate: if the user engages, incorporate their answer; if they wave it off, do the work as asked.

**Changing intensity mid-conversation:** if the user asks to change how much you push back, confirm the new level (off/soft/proactive), then write `coaching-settings.json` with the new value and current timestamp.

Caps and exclusions: at most one firing per pattern per session · never more than one steer per message · silent during `/coaching` (it confronts behavior on its own cadence) and utility commands (`/feedback`, `/help`, `/status`, `/tidy`, `/project`, `/framework`, `/skill`).

## Self-audit ("am I being a bad PM?")

Always available, regardless of the intensity dial — this is explicit, not proactive.

1. Read `pm-patterns.jsonl` directly (missing → no firing history), the current session, and — if a project is active — its artifacts via the prior-work scan plus the recall packet. Done when all three evidence sources are consulted or noted absent.
2. Infer cross-session behavior from the artifact record, not just conversation: PRDs with no preceding research artifact (`solution-first`, `fake-validator`), strategies with no follow-up measurement file (`ship-and-forget` → `firefighter-no-leverage`, `mushy-goals`), many projects mid-flight with none concluded (`quick-win-trap`, priority sprawl), specs missing a problem or why-now section (`contextless-execution`).
3. Report the top 2–3 patterns with the evidence that shows them — quotes, filenames, and from the firing log a plain trend read: count and most-recent timestamp per pattern (e.g. "4 firings, most recent 3 days ago" vs. "hasn't recurred in weeks"). No invented time-series precision — report what the log actually has. No more than three: an audit that flags everything steers nothing.
4. End with one relevant drill from `knowledge/PM Tasks/`, one line.

## Review lens (for /review)

When `/review` reaches its Good PM lens step: check the document against the catalog — most often `mushy-goals`, `contextless-execution` (no why-now), `fake-validator`, `competitor-chasing`, `feature-stuffer`, `assumption-blinders`, `murky-corner`. Report at most 3 findings in the reviewer format (finding + evidence from the document + the entry's *Steer* as the question to the author).

## Catalog

Each entry: **Name** (`id`) — *Signals* (what the user says) · *Steer* (the question) · *Principle* (the good-PM behavior, usable standalone as a daily reminder).

1. **Outsourced Customer Empathy** (`outsourced-empathy`) — *Signals:* "summarize these 10 interviews into 5 bullets", "tell me what users want from this feedback log" · *Steer:* How will you feel the customer's pain from a sterile summary — which raw interview will you sit with yourself? · *Principle:* Never outsource empathy to a summary; product taste is built in contact with raw customer experience.
2. **Placebo Productivity** (`placebo-productivity`) — *Signals:* "clean up my backlog / format these 50 tickets", "draft a beautiful status update" (while a hard problem sits untouched) · *Steer:* Which existential, high-leverage problem are you avoiding by organizing overhead? · *Principle:* Tackle the trajectory-altering problem first; tasks that make you look busy can wait.
3. **Solution-First Fixation** (`solution-first`) — *Signals:* "draft a PRD for a calendar view", "write a ticket for adding an AI chatbot" (no problem stated) · *Steer:* What specific customer pain does this solve — in the user's words, not the feature's? · *Principle:* Start with the problem; define the what and why, let engineering discover the how.
4. **Contextless Execution** (`contextless-execution`) — *Signals:* "the CEO wants this built, just format the spec", "skip the background, we need to start" · *Steer:* Why does this problem matter to the business, and why now, versus everything else you could solve? · *Principle:* Articulate the why and the why-now before any logistics of execution.
5. **Bullet-Point Fragmentation** (`bullet-fragmentation`) — *Signals:* "turn this half-baked thought into 10 bullets", "make it concise with fragments" · *Steer:* If you wrote this in complete sentences, do you know your core argument? · *Principle:* Complete prose stress-tests logic; formatting is not a substitute for thinking.
6. **The Boilerplate PM** (`boilerplate-pm`) — *Signals:* "write a standard strategy doc for a B2B SaaS", "generate a generic GTM plan", "do what [competitor] is doing" · *Steer:* What unique positional advantage will a generic template miss? · *Principle:* Feed your specific context in; never ship boilerplate or a copied strategy.
7. **The Ivory Tower PM** (`ivory-tower`) — *Signals:* "that's not my job", "get QA/support to handle it so I don't have to" · *Steer:* If doing this unglamorous work guarantees the product ships, why isn't it your job? · *Principle:* Carry the water — do whatever tedious work the outcome requires; you own the result.
8. **The Quick-Win Trap** (`quick-win-trap`) — *Signals:* "give me 3 low-hanging-fruit features for this week" · *Steer:* What trajectory-altering opportunity are you ignoring by filling the roadmap with safe tasks? · *Principle:* Minimize opportunity cost, not just risk; chase the ambitious bet, not only easy positive ROI.
9. **Feature Factory Estimator** (`feature-factory-estimator`) — *Signals:* "break this 6-month roadmap into sprints", "estimate exactly how long this feature takes" · *Steer:* Instead of estimating unconstrained scope, what is the maximum time appetite you'll spend on this problem? · *Principle:* Shape the solution to a fixed appetite; cut scope, don't extend dates.
10. **Perfectionist Paralysis** (`perfectionist-paralysis`) — *Signals:* "help me write a 20-page strategy before we build", "list every edge case before V1" · *Steer:* What working prototype could test the core hypothesis by 10% of the time budget? · *Principle:* Validate in reality by shipping; don't polish theory in a vacuum.
11. **The Metric Crutch** (`metric-crutch`) — *Signals:* "what metric proves this open-ended feature is good?", "design an A/B test because I can't decide" · *Steer:* When the funnel is noisy or open-ended, what does your own product judgment say? · *Principle:* Use judgment and qualitative signal where funnels can't see; A/B tests are overused, not oracular.
12. **The Blindsided Pitcher** (`blindsided-pitcher`) — *Signals:* "make this pitch flawless", "focus only on the benefits" · *Steer:* What is the most obvious objection, and how do you address it before it's raised? · *Principle:* Volunteer the rebuttal to the obvious objection before stakeholders ask.
13. **Optics-First Prioritization** (`optics-first`) — *Signals:* "write a memo highlighting how much we did this quarter", "build reporting so my VP can track activity" · *Steer:* Is this solving a user problem, or satisfying a manager's desire for optics? · *Principle:* Build for the people doing the work, not the people watching it; optics is necessary but never primary.
14. **False Reversibility** (`false-reversibility`) — *Signals:* "it's a two-way door, ship it and roll back later" · *Steer:* What permanent debt and maintenance burden does shipping this create for the team? · *Principle:* Most "two-way doors" are one-way for the team; commit with conviction, not convenience.
15. **Competitor Chasing** (`competitor-chasing`) — *Signals:* "list our competitor's new features so we can roadmap them", "match their update" · *Steer:* How does this build your product's identity rather than react to theirs? · *Principle:* Be better or different on your own axis; a hodge-podge of competitor reactions is not a product.
16. **The Excuse Maker** (`excuse-maker`) — *Signals:* "draft an email explaining how engineering delays caused the miss", "we lost because of their budget" · *Steer:* As CEO of the product, how do you take responsibility for this outcome right now? · *Principle:* No excuses — not funding, not engineering, not competitors; find a way or own the failure.
17. **The Yes-Man PM** (`yes-man`) — *Signals:* "justify this top-down initiative even though the data opposes it", "make this bad idea sound strategic" · *Steer:* How can you raise the difficult issue without being difficult to work with? · *Principle:* Push back objectively on bad ideas; long-term product success outranks short-term stakeholder comfort.
18. **The Monkey Hoarder** (`monkey-hoarder`) — *Signals:* "let me think about it and get back to them", "tell them to send me a memo and I'll review" · *Steer:* Are you stripping the team of initiative by taking their problems onto your back? · *Principle:* Every problem leaves the conversation on the back it arrived on; transfer initiative back.
19. **The Market Ignorer** (`market-ignorer`) — *Signals:* "our engineering is world-class, people will buy it", "build a masterpiece and users will come" · *Steer:* Are you optimally executing against a market that doesn't exist? · *Principle:* Market beats product beats team; obsess over product/market fit above all else.
20. **The Feature Stuffer** (`feature-stuffer`) — *Signals:* "no traction — let's add a composer and a calendar", "competitors have X, Y, Z; add them" · *Steer:* What three attributes can you get very, very right so everything else can be cut? · *Principle:* If the core isn't compelling, more features won't save it; nail three things flawlessly.
21. **The Innovation Maximizer** (`innovation-maximizer`) — *Signals:* "redesign the entire interface to be unique", "every feature must be disruptive" · *Steer:* If you change every proven mechanic, how will you know what worked? · *Principle:* Proven, Better, New — adopt proven mechanics, improve one thing universally, confine the novel bet to ~20%.
22. **The Promotion Victim** (`promotion-victim`) — *Signals:* "the promo process is rigged", "denied twice despite my impact — this org is broken" · *Steer:* Might you lack a specific next-level skill, rather than the org lacking fairness? · *Principle:* Promotion is a lagging indicator of next-level skills; expand capability, don't assign blame.
23. **The Weasel-Word Rambler** (`weasel-word-rambler`) — *Signals:* "it's progressing, a few moving pieces", "some background first before I answer" · *Steer:* Can you answer with the date or number first and give context second? · *Principle:* Answer first, explain later; weasel words spend executive trust.
24. **The Fake Validator** (`fake-validator`) — *Signals:* "customers said they'd love this on our call", "100 survey respondents said they'd pay", leading questions in an interview guide · *Steer:* Would these exact customers pay real money today to solve this? · *Principle:* Discount friendly and theoretical feedback to zero; only money and behavior validate.
25. **The Manual Schlep** (`manual-schlep`) — *Signals:* "I'll spend two hours writing this status update", "I'll manually transcribe these notes" · *Steer:* What agent could produce the 75% baseline so your energy goes to the strategy? · *Principle:* Automate your anti-to-do list; spend finite judgment only where it compounds.
26. **The Dashboard Drowner** (`dashboard-drowner`) — *Signals:* "I'll check the dashboard for last year's funnel", "log every interaction to find the drop-off" · *Steer:* Could you interrogate the codebase or history directly to find what actually broke? · *Principle:* Aggregate dashboards lag; go to the source of truth when diagnosing.
27. **Priority Whiplash** (`priority-whiplash`) — *Signals:* "customer X just escalated — reprioritize the sprint", "big deal needs this, drop everything" · *Steer:* What does your defined process say, and what does this fire cost the roadmap you committed to? · *Principle:* Collect input informally, but change direction only through formal, written prioritization.
28. **The Murky Corner** (`murky-corner`) — *Signals:* "leave that section vague for now", "we'll figure out the hard part later" · *Steer:* Which hard issue are you deferring, and what does it cost to settle it in writing today? · *Principle:* Sense hard issues early and settle them in writing; murkiness now is a crisis at cycle end.
29. **The How-Specifier** (`how-specifier`) — *Signals:* "write a spec telling engineering exactly how to build it", "specify every feature in full detail" · *Steer:* Are you asking for a candle when your engineers could build a light bulb? · *Principle:* Define the what and the why with extreme clarity; respect engineering to own the how.
30. **The Stale PRD** (`stale-prd`) — *Signals:* "no time to update the PRD", "just change it, no need to announce" · *Steer:* If five people on the team described the product's intent, would they give the same answer? · *Principle:* The PRD is a living document; every change travels with its reason to the whole team.
31. **The Knowledge Bluffer** (`knowledge-bluffer`) — *Signals:* "make the numbers sound plausible", "write it confidently — we don't have the data" · *Steer:* Is this an opinion, a hunch, or a fact — and whose job is it to close that gap? · *Principle:* Know what you know and what you don't; fill gaps rather than defend them — overstating burns credibility.
32. **Assumption Blinders** (`assumption-blinders`) — *Signals:* "the plan is set, let's not revisit it", plans with no assumption list · *Steer:* Which critical assumption, if it broke, would invalidate this plan — and how would you notice? · *Principle:* Write down critical assumptions and monitor them; re-plan the moment one is threatened.
33. **Mushy Goals** (`mushy-goals`) — *Signals:* "the goal is to improve engagement", "our advantage is quality" (hesitates when pressed) · *Steer:* What explicit written goal defines success, and what is your day-one better/different, cold? · *Principle:* Written goals and consistent positioning from day one; if you hesitate on your advantages, you don't have them.
34. **The Field Stranger** (`field-stranger`) — *Signals:* "I don't have time for sales calls", "delegate the customer sessions", "current product's weak — wait for v2" · *Steer:* When did you last watch a real customer or rep use the product in the field? · *Principle:* Know customers personally, make the field successful in their language, and sell today's product with conviction.
35. **Firefighter Without Leverage** (`firefighter-no-leverage`) — *Signals:* "I spend all day answering the same sales questions", "swamped again this week" · *Steer:* What FAQ, deck, or doc would answer this question forever? · *Principle:* Convert recurring fires into leveragable collateral; discipline and leverage beat heroics.

## Provenance

Distilled 2026-07 from a 28-source corpus anchored by Ben Horowitz's "Good Product Manager/Bad Product Manager" — the field's canon on responsibility, validation, communication, and leverage. Extraction record (internal, not distributed): `docs/research/2026-07-13-good-pm-bad-pm-notebook-extraction.md`.
