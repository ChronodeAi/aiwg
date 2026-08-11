# PRD Format Library

7 document formats for product work, matched to your situation. Each format serves a different stage, audience, and level of detail.

**How this works:** When you use `/prd`, the AI asks 2-3 diagnostic questions (stage, audience, detail level), matches your answers to the metadata tags on each format, and presents 1-2 matching formats. You pick the one that fits, and the AI generates your PRD using that structure plus your Context/ files.

---

## Quick Routing Table

| If you need to... | Use this format | Time |
|---|---|---|
| Frame the problem before exploring solutions | [Intercom Intermission](intercom-intermission.md) | 30 min |
| Align your team quickly on a feature idea | [Lenny's 1-Pager](lenny-1-pager.md) | 30 min |
| Test whether your assumptions hold | [Lean UX Canvas](lean-ux-canvas.md) | 1 hour |
| Shape scope and boundaries for a small bet | [Shape Up Pitch](shape-up-pitch.md) | 1-2 hours |
| Get exec buy-in for a new product initiative | [Amazon PRFAQ](amazon-prfaq.md) | Multi-day |
| Plan a feature through lifecycle with review gates | [Kevin Yien's Stage-Gated PRD](kevin-yien-prd.md) | 2-4 hours |
| Hand off a detailed spec to engineering | [Feature PRD](feature-prd.md) | Half day+ |

---

## By Lifecycle Stage

| Stage | Format | Why |
|---|---|---|
| Discovery | Intercom Intermission | Forces problem clarity; no solution allowed |
| Discovery | Lenny's 1-Pager | Quick problem-first alignment |
| Validation | Lean UX Canvas | Hypothesis → experiment flow |
| Shaping | Shape Up Pitch | Defines appetite and boundaries, not specs |
| Planning | Amazon PRFAQ | Narrative-first, works backwards from customer |
| Planning | Kevin Yien PRD | Stage-gated, grows from draft to launched |
| Build | Feature PRD | Full technical spec for eng handoff |

---

## By Detail Level

**Light (1 page, 30 min):** Intercom Intermission, Lenny's 1-Pager, Lean UX Canvas
**Medium (2-4 pages, 1-2 hours):** Shape Up Pitch, Kevin Yien PRD
**Heavy (5+ pages, iterated):** Amazon PRFAQ, Feature PRD

---

## By Audience

**Direct team:** Intercom Intermission, Lenny's 1-Pager, Lean UX Canvas
**Cross-functional:** Shape Up Pitch, Kevin Yien PRD, Lenny's 1-Pager
**Leadership/execs:** Amazon PRFAQ
**Engineering:** Feature PRD

---

## Metadata Reference

Each format file has metadata tags at the top, following the same pattern as `knowledge/Prioritization/`. The AI uses these tags to route you to the right format.

### Tag Vocabulary

**Use When:**
- `Discovery` — still understanding the problem
- `Validation` — testing whether assumptions hold
- `Shaping` — defining scope and boundaries
- `Planning` — getting buy-in for what to build
- `Build` — handing off for implementation
- `New Product` — 0-to-1 initiative
- `Feature Work` — incremental to existing product
- `Quick Alignment` — need to align fast, async
- `Exec Buy-In` — need leadership approval
- `Team Autonomy` — team decides how to fill in details

**Best For:**
- `Problem Framing` — defining what to solve
- `Hypothesis Testing` — validating assumptions
- `Scope Definition` — drawing boundaries
- `Stakeholder Alignment` — getting everyone on same page
- `Eng Handoff` — everything engineering needs to build
- `Exec Approval` — getting a go/no-go decision

**Audience:** `Direct Team` | `Cross-Functional` | `Leadership` | `Engineering`

**Detail Level:** `Light` | `Medium` | `Heavy`

**Artefact:** `Document` | `Canvas`
