# Idea gallery — agents that earn their context

A starting menu for users who want an agent but don't have a job in mind. Every entry here clears at least one Step-2 bar. Filter to the user's harness and connected MCPs before showing; on pick, pre-fill Job (Step 3), Cadence (Step 4), and Tools/MCP (Step 5) from the row, then adapt.

**Legend** — *Earns via*: Par=parallelism, Thr=protects the thread, Ext=external MCP data, Rec=recurring · *Cadence*: one-shot / recurring / goal · *Harness*: OAI=OpenAI Codex/ChatGPT, CC=Claude Code, Cur=Cursor, Cow=Cowork. Existing one-shot examples are Codex-capable unless their notes require a provider-only feature.

| Agent | Job | Earns via | Cadence | Model | MCP | Harness |
|---|---|---|---|---|---|---|
| `doc-review-panel` | Fan out N persona reviewers over a doc, merge to one prioritized list | Par, Thr | one-shot | Opus | none | CC, Cur (Cow: uncommon) |
| `decision-archaeologist` | Trace how a decision evolved; surface turning points + contradictions | Thr | one-shot | inherit | none | all |
| `prior-work-researcher` | Surface relevant past work before new work starts | Thr | one-shot | inherit | Notion (opt) | all |
| `feedback-synthesizer` | Mine tickets/reviews/survey for themes + severity | Thr, Ext | one-shot | Opus | Linear/GitHub/Notion | all (Cow: connector) |
| `competitor-watch` | Scan one competitor's site/news/socials for what's new | Ext, Rec | recurring | Sonnet | Perplexity/web | all (Cow: connector) |
| `metrics-analyst` | Pull live analytics; ground a metric question in real numbers | Ext | one-shot | Sonnet | GSC/Ahrefs/DataFast | CC, Cur |
| `release-radar` | Watch a competitor changelog or your own repo for shipped changes | Ext, Rec | recurring | Haiku | GitHub | all (Cow: connector) |
| `meeting-prep-researcher` | Pull context on attendees + topics before a meeting | Ext | one-shot | Sonnet | Granola/Notion/Gmail | CC, Cow |
| `standup-digest` | Summarize what changed across Linear/Notion since yesterday | Ext, Rec | recurring | Haiku | Linear/Notion | all (Cow: connector) |
| `experiment-monitor` | Watch a running experiment's metric; flag when it crosses a threshold | Ext, Rec | recurring→goal | Sonnet | DataFast/GSC | CC, Cur |
| `inbox-triage` | Classify + route incoming tickets/email into buckets | Thr, Rec | recurring | Sonnet | Gmail/Linear | CC, Cow |

## Not a subagent — build these as a command or skill

Single-lens, single-pass jobs do not earn an isolated context. If the user asks for one of these, route to a command/skill per Step 2 (this is exactly what `pm-skills` does — it ships these as commands):

- **`red-team`** — attack a plan's load-bearing assumptions. One pass, one lens.
- **`assumption-auditor`** — surface the riskiest unstated assumptions in a doc.
- **`customer-voice`** — role-play the target user reacting to a doc.
- **`stakeholder-sim`** — role-play a named stakeholder. (A subagent only if run as a *panel* of several at once — then it's `doc-review-panel`.)
