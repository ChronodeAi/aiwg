# pm-workflows Plugin

This plugin contains 11 sequenced PM workflows and 3 agents. Workflows chain skills from `skills/` in a defined order, turning individual tools into end-to-end thinking sessions. Agents provide the intelligence layer for routing, knowledge lookup, and context awareness.

## Agents

| Agent | File | Role |
|---|---|---|
| pm-workflows | `agents/pm-workflows.md` | Primary entry point — routes PM requests to the 11 workflow commands |
| knowledge-librarian | `agents/knowledge-librarian.md` | Backs `/framework` and `/skill` — surfaces matching knowledge/ content and skills on demand |
| context-manager | `agents/context-manager.md` | Backs `/status` — reads 📂 Context/ (including 📂 Context/Work/) to surface current state and next best action |
| 7 cross-functional reviewers | `agents/{engineering,design,executive,legal-risk,ux-research,devils-advocate,customer-voice}-reviewer.md` | Back `/review` Steps 1–7 and `/prd` Step 8 — read-only document reviewers, structured findings |
| 2 PRD-specific reviewers | `agents/prd-{strengths,flaws}-reviewer.md` | Back `/prd` Step 7 — optimist + critic personas paired by design |

**Agent discovery (Claude-stack canonical):** Every active agent in `registry/agents.json` — the three routing agents, the seven cross-functional reviewers, and the two PRD-specific reviewers — lives at `agents/<name>.md`. Claude Code discovers them natively when the plugin is enabled. No mirroring step needed.

- **Edit the canonical file** under `agents/`. There are no mirror copies to keep in sync.
- **Cursor distributions** receive their own copy of these files via the release-time transform in `bin/build-cursor-zip.sh` — never edit the generated Cursor copy.

## Workflows

| Command | Workflow | Skills in sequence |
|---|---|---|
| `/strategy` | Core Strategy Development | 4 skills — crux to value chain |
| `/opportunity` | Opportunity Mapping | 3 core skills + optional MECE — intake → OST → (optional MECE) → selection |
| `/assumptions` | Assumption Mapping | 3 skills — generate to prioritize to signal |
| `/research` | Research to Feature | 5 skills — transcript to experiment |
| `/decisions` | Make Great Decisions | 6 skills — root cause to decision rights |
| `/stakeholder` | Stakeholder & Politics Copilot | 7 skills — power map to executive presence |
| `/meeting` | Meeting Mastery | 3 skills — agenda to influence to summary |
| `/review` | Multi-Perspective Review | 7 inline perspectives — eng to customer voice + optional synthesis |
| `/coaching` | PM Coaching | 5 modes — situation retrospective, team perspective, adversarial roleplay, decision audit, blind spot scan |
| `/measure` | Measure What Matters | 4 skills + 2 inline steps — intangible to quantified decision |
| `/prd` | PRD Construction | 8 skills + 9 reviewer subagents — pick input mode (talk/design/research) → reconcile → use cases → user stories (basic or Gherkin) → UI AC → draft → 2 PRD-specific reviewers → 7 cross-functional reviewers (optional) → synthesis (gated) |

## How Workflows Work

Each workflow file sequences skills from `skills/`. When a user triggers a workflow:
1. Invoke each skill in the listed step order
2. Pass outputs from one step as inputs to the next
3. Let the user confirm between steps or run end-to-end based on preference
4. Save outputs to `📂 Context/Work/` when the workflow produces a deliverable

## How Agents Work

- `pm-workflows.md` — activated by the Global Plugin Routing Rule in AGENTS.md whenever a PM request comes in; reads 📂 Context/ and routes to the matching workflow command
- `knowledge-librarian.md` — activated by `/framework [topic]` and `/skill [task]` commands; conversational multi-turn retrieval (surface options → user picks → retrieve and explain)
- `context-manager.md` — activated by `/status`; reads all 5 📂 Context/ files and scans 📂 Context/Work/ for active outputs before synthesising a single recommended next action

## Versioning

Bump version in `.claude-plugin/plugin.json` and `.cursor-plugin/plugin.json` when:
- MINOR: new agents or workflows added
- PATCH: edits to existing workflow steps, agent instructions, or command files
