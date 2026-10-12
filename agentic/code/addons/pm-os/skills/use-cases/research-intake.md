# Research intake — synthesis format and extraction

Reference for [`SKILL.md`](SKILL.md) Step 3, on the research-driven branch. Skip it when the input is an idea with no research.

## Required synthesis format

Research must be in this shape before use cases can be extracted from it. If the user's research isn't, either ask them to restructure it, or interview them to fill the template question by question.

```markdown
## Research Synthesis: [Project/Study Name]

### Research Context
- **Number of interviews/sessions:** [N]
- **Participant profile:** [e.g. "Mid-career PMs at 150-500 person tech companies"]
- **Research goal:** [What you were trying to learn]
- **Date range:** [When conducted]

### Key Findings by Frequency

**Mentioned by 7+ of 10 participants (High priority):**
- [Pain point / job-to-be-done]
- Current workaround: [What they do today]
- Quote: "[Direct quote capturing the need]"

**Mentioned by 4-6 of 10 participants (Medium priority):**
- [Pain point / job-to-be-done]
- Current workaround: [What they do today]

**Mentioned by 1-3 of 10 participants (Low priority / edge case):**
- [Pain point / job-to-be-done]

### Actors Identified
- **Primary:** [Who initiates the goal] — [context about them]
- **Secondary:** [Who is affected / responds] — [context]
- **System:** [External systems involved]

### Current Workarounds
- [What users do today without your solution]
- [Tools, processes, hacks they use]
- [Why current solutions fail]

### Decision Triggers
- [What makes them look for a solution]
- [Recent events that sparked interest]

### Value Perception
- [How they describe the value]
- [What they compare it to]
- [What they'd pay for]

### Unexpected Insights
- [Surprising findings that don't fit above categories]
- [Contradictions or tensions in the data]
```

## Extraction mapping

Once the synthesis is in that format, each section becomes a specific part of a use case:

| Synthesis section | Becomes |
|---|---|
| High-priority findings (7+/10) | Must-have use cases |
| Medium-priority findings (4-6/10) | Should-have use cases |
| Current workarounds | Preconditions and trigger events |
| Actors identified | Primary / secondary / system actor definitions |
| Decision triggers | Use case triggers |
| Value perception | Success criteria |

## Worked before/after

### BEFORE — raw research synthesis

```markdown
## Research Synthesis: PM Tooling Study

### Research Context
- **Number of interviews:** 10
- **Participant profile:** Mid-career PMs (3-8 years), tech companies 150-500 people
- **Research goal:** Understand discovery and workflow gaps in PM OS

### Key Findings by Frequency

**Mentioned by 8 of 10 participants (High priority):**
- Discovery problem: "I bought it but haven't found what's inside"
- Current workaround: Pull individual skill files, don't use workflows
- Quote: "I pull skills directly — haven't tried the workflows"

**Mentioned by 6 of 10 participants (Medium priority):**
- Tool mismatch: Uses Claude Code terminal, not Cursor
- Current workaround: Skills work but workflow routing may not function

**Mentioned by 3 of 10 participants (Low priority):**
- Wants coaching/mentorship from product expert

### Actors Identified
- **Primary:** Mid-career PM (engineer background, wants to grow)
- **Secondary:** PM team lead, CPO
- **System:** Claude Code terminal, Notion, custom-built skills

### Current Workarounds
- Pull individual skill files ad hoc
- Build custom AI skills for specific tasks
- Use Claude Code + Notion instead of Cursor
- Don't run `/start` or workflow commands

### Decision Triggers
- Trust in author ("following you for a while")
- Career transition (engineer → PM)
- Posts resonate with their journey

### Value Perception
- "Bundle of skills" not "operating system"
- Values curation/judgment over technical capability
- Would pay for coaching separately

### Unexpected Insights
- Activation > product-market fit (has what they need, can't find it)
- Trust moat is relational (WHO), not architectural (WHAT)
- Tool-agnostic usage (works across Claude/Code/Cursor)
```

### AFTER — extracted use cases

#### UC1: Discover Relevant Skills

**Scope:** PM OS Platform
**Level:** User-goal
**Primary Actor:** New Buyer (mid-career PM)

**Stakeholders & Interests:**
- Buyer: Finds value quickly, justifies purchase
- Platform: Increases activation and retention
- Author: Maintains trust relationship

**Preconditions:**
- User has purchased PM OS
- User is logged into a compatible environment (Cursor / Claude Code)

**Minimal Guarantees:**
- User can access individual skills even if workflow discovery fails
- Support available for navigation questions

**Success Guarantee:**
- User identifies at least 3 skills relevant to their current pain points
- User understands workflow architecture exists

**Trigger:** User opens PM OS for the first time, or says "I don't know what's in here"

**Main Success Scenario:**
1. System prompts "What's your biggest PM challenge right now?"
2. User selects from: stakeholder management, strategy, execution, communication
3. System maps challenge to specific skills and workflows
4. System presents 3-5 relevant entry points
5. User selects one skill to try
6. System opens skill with context on how to use it
7. User successfully runs skill
8. System offers to show related workflows

**Extensions:**
- 2a. User types custom challenge: System uses semantic search to match
- 3a. No direct match: System shows closest skills + offers human support
- 5a. User declines all options: System logs for product improvement
- 7a. Skill fails: System offers troubleshooting or an alternative skill

**Meta:** Frequency=Once per new buyer, Priority=Must-have

---

#### UC2: Access Workflows in Non-Native Tool

**Scope:** PM OS Platform
**Level:** User-goal
**Primary Actor:** PM Using Claude Code Terminal

**Stakeholders & Interests:**
- PM: Uses preferred tool, gets full PM OS value
- Platform: Expands addressable market beyond Cursor
- Support: Fewer "does this work in X?" questions

**Preconditions:**
- User has PM OS access
- User is in Claude Code terminal (not Cursor)

**Success Guarantee:**
- All core skills function in Claude Code
- Workflow routing available (even if a different UX)
- Documentation clear on any limitations

**Trigger:** User attempts to use PM OS in Claude Code terminal

**Main Success Scenario:**
1. User types workflow command in Claude Code
2. System detects environment and adapts output format
3. System presents workflow steps as numbered options
4. User selects step by number
5. System executes skill and shows results
6. System prompts for next step or exit
7. User completes workflow or exits

**Extensions:**
- 2a. Feature unavailable in terminal: System explains limitation + workaround
- 4a. User enters invalid selection: System reprompts with valid options

**Meta:** Frequency=Daily, Priority=Should-have

---

#### UC3: Get Personalized Coaching

**Scope:** PM OS Services
**Level:** Strategic
**Primary Actor:** Aspiring Founder / Career Transitioner

**Stakeholders & Interests:**
- PM: Gets guidance specific to their situation
- Coach: Monetizes expertise, maintains trust relationship
- Platform: Creates high-ticket revenue stream

**Preconditions:**
- User has established trust (follows content, bought product)
- User has a specific career/founder question

**Success Guarantee:**
- User receives actionable advice for their specific situation
- Clear next steps identified
- Relationship strengthened

**Trigger:** User explicitly requests coaching, or says "I need guidance on my specific situation"

**Main Success Scenario:**
1. User requests coaching session
2. System collects context (career stage, specific challenge, goals)
3. System schedules session or offers async option
4. Coach reviews context before session
5. Session occurs (video call or async exchange)
6. Follow-up resources shared
7. User applies advice and reports back

**Extensions:**
- 2a. Context insufficient: System asks clarifying questions
- 3a. No availability: System adds to waitlist + offers resources

**Meta:** Frequency=Monthly, Priority=Nice-to-have (revenue opportunity)
