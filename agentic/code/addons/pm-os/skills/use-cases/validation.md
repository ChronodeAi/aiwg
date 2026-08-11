# Final validation — Cockburn's checklist, goal levels, anti-patterns

Reference for [`SKILL.md`](SKILL.md) Step 5, for the pass before a use case set goes downstream into a PRD or engineering handoff. CRISP in the skill body is the per-use-case gate; this file is the set-level audit.

## Quality checklist

- [ ] Every use case has exactly one primary actor
- [ ] Every use case has a clear, testable success criterion
- [ ] Every actor has at least one use case
- [ ] Preconditions are realistic (not requiring other use cases to complete)
- [ ] Main success scenario has 3-7 steps
- [ ] Extensions cover likely variations
- [ ] Failure scenarios are handled
- [ ] Use cases are independent (don't require each other)
- [ ] Names are verb-noun format ("Generate Invoice", not "Invoicing")
- [ ] Goals answer "what does the actor want?" not "what does the system do?"

## Anti-patterns and their conversions

| Anti-pattern | Example | How to convert |
|---|---|---|
| **System-centric** | "The system calculates tax" — whose goal? | → "Accountant reviews tax calculation" (who benefits?) |
| **Vague success** | "User is happy" — how do we measure? | → "User receives confirmation email within 30 seconds" |
| **Circular dependencies** | Use Case A requires B, B requires A | → Merge into one use case, or introduce a system actor to break the cycle |
| **Feature lists** | "User can filter, sort and export" — three use cases or one? | → Split: "Filter results", "Sort results", "Export data", each with its own goal |
| **Missing actor** | "The report is generated" | → Add the actor: "Manager requests monthly report" |
| **Implementation details** | "User clicks the blue button" | → "User confirms purchase" (intent, not UI) |

To fix one: identify which anti-pattern applies, ask "who is trying to achieve what?", rewrite as actor + goal + observable outcome, then re-check against CRISP.

## Cockburn's 28-point checklist

All answers should be yes.

### Use case header (1-5)
| # | Question |
|---|---|
| 1 | Title: is it an **active-verb goal phrase** (the primary actor's goal)? |
| 2 | Title: can the system **actually deliver** that goal? |
| 3 | Scope and level: are they **filled in**? |
| 4 | Scope: is the system treated as a **black box**? |
| 5 | Scope: must designers build everything inside, nothing outside? |

### Actors and stakeholders (6-14)
| # | Question |
|---|---|
| 6 | Level: do the steps match the stated **goal level**? |
| 7 | Level: is the goal truly at that level (not a subfunction)? |
| 8 | Actor: does the actor have **observable behaviour**? |
| 9 | Primary actor: does their goal represent a **service promise**? |
| 10 | Preconditions: are they **mandatory and guaranteed**? |
| 11 | Preconditions: are they **never checked again** inside? |
| 12 | Stakeholders: are they and their **interests mentioned**? |
| 13 | Success end: are **all interests satisfied**? |
| 14 | Failure protection: are **all interests protected** on failure? |

### Main success scenario (15-19)
| # | Question |
|---|---|
| 15 | Does it run from **trigger to success**? |
| 16 | Is the **sequence correct**? |
| 17 | Does it have **2-11 steps**? |
| 18 | Is each step phrased as a **goal that succeeds**? |
| 19 | Does the process move **distinctly forward**? |

### Individual steps (20-25)
| # | Question |
|---|---|
| 20 | Is **"who's got the ball"** clear? |
| 21 | Is the **actor's intent** clear? |
| 22 | Is the goal level **lower than the overall use case**? |
| 23 | Does it stay clear of **UI design**? |
| 24 | Is the **information passed** clear? |
| 25 | Does it **"validate"** rather than "check"? |

### Extensions (26-28)
| # | Question |
|---|---|
| 26 | Can, or must, the system **detect** the condition? |
| 27 | Is it something the system **must handle**? |
| 28 | Variations: are you sure it isn't an ordinary extension? |

### Set-level
- Does the list capture **all services** every primary actor wants?
- Do the use cases form a **coherent story** from highest to lowest level?
- Is there a **context-setting** use case at the outermost scope for each actor?

## Goal levels

| Level | Colour | Duration | Test |
|---|---|---|---|
| **Strategic** | White | Hours to years | "Can I go home after this?" (No) |
| **User-goal** | Blue / sea | 2-20 minutes | "Can I go to lunch after this?" (Yes) |
| **Subfunction** | Indigo | Seconds | "Can I bill for this?" (No) |

Most use cases belong at **user-goal level**.

## Iterating

Treat use case writing as iterative — the first draft brings roughly two-thirds of the value, and the rest comes from feedback. Refine rather than trying to land it in one pass.
