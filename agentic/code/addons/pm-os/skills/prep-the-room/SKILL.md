---
name: prep-the-room
description: >
  Use when the user says "prep me for this meeting", "I'm walking into a conversation with X",
  "I have a review with my VP in an hour", "how do I pitch this to the team", "help me get ready
  for this 1:1", or names an upcoming interaction with a stakeholder, exec, engineer, or designer
  that carries tension or stakes — produces a read on the actors, a stance, opening moves, and
  what not to do. Also `/stakeholder` Fast path. Not for a planned, already-identified hard
  conversation needing a full script (`difficult-conversation`), deciding whether the underlying
  issue is worth fighting (`pick-your-battles`), or a reactive incident that already happened
  (`respond-under-fire`). Source: Shreyas Doshi org-navigation corpus + The Prince / 48 Laws of
  Power.
---

# Prep the Room

**Purpose:** Convert "I have a meeting with X soon" into a field read, a stance, and opening moves — in under 10 minutes of prep.

**Agency boundary:** Advise and draft only. Never send messages, book meetings, or take any action on the user's behalf — these are judgment calls the user executes personally.

## Input/Output Contract

**Accepts:** An upcoming interaction: who is in the room, what the user wants from it, any history of friction.
**Produces:** (1) a read on each actor, (2) capital-P and lowercase-p purpose, (3) opening moves and pitch structure, (4) a do-not-do list.
**Passes to:** `pick-your-battles` if the worth-fighting gate fires. Otherwise terminal.

## Process

### 1. Read the field

For each person in the room, run the reads in `references/field-reads.md`:

- **Maturity read:** baby in disguise or well-formed adult? Babies "operate as just a victim of whatever circumstances there are," small things irritate them, they cannot regulate emotions. If a baby holds power in this room, do not plan to win by being right — plan inputs that soothe and align. "Discard judgment, discard superiority" — use the read as "an input for you to be able to better influence them."
- **Culture read:** PM Dominated, PM Serviced, or PM Guided? Plot competence vs influence. Tactics differ per culture (see reference file).
- **Friction read:** is the existing tension good friction (healthy pushback on what to build) or bad friction (lane-policing, title arguments, "what will make my function's life easier")?
- **Exec read:** if an exec is present, are they competent, or optics-obsessed/incompetent? If the latter, this meeting is interface work — give them "the basics of what they need," do not fight the template here (that is `manage-the-upward-channel` territory).

Done when every person in the room has all four reads (maturity, culture, friction, exec if applicable).

### 2. Clear your own head (neutral-why)

If you walk in carrying a thought like "this person is uncaring / incompetent / difficult," interrogate it first: "why am I getting this thought... let me do it from a place of neutrality." Look for hidden context — a tremendous deadline, a delegation gap on your side, a previous company culture of "done is better than perfect." Walking in with the impulsive thought unexamined is how drama starts.

Done when the impulsive thought is named and either dismissed with evidence or replaced by a neutral read.

### 3. Set both purposes

Spend five minutes on two purposes:
- **Capital-P Purpose:** the business outcome you need from this meeting.
- **Lowercase-p purpose:** how you want each person to *feel* about you and your team afterward. Tailor anecdotes to show past successful work with their function; ask open-minded questions about how their role works here.

Done when both purposes are written as concrete, checkable statements, not vibes.

### 4. Worth-fighting gate

If your agenda involves pushing a contested position, changing someone's strategy, or correcting a process you think is broken: stop and run `pick-your-battles` first. Do not spend political capital by accident in a room you only meant to survive.

Done when the gate has fired and been resolved, or confirmed not to apply.

### 5. Build the pitch (if you are proposing something)

Use the structured-instinct flow — never lead with "I have a gut feeling":
1. "This is what I understand about users / the world."
2. "This is what I understand about our goals."
3. "This is what I understand about our culture / approach."
4. "Therefore, it follows that we need to do X."

If you expect steamroll-perception risk, pre-commit to the split: be "uncompromising about the impact... uncompromising about the customer experience" but open the floor with "what I'd like to focus our conversation on is *how* we can do it... I need input on where the blind spots are."

Done when the four-line pitch flow is written out with the actual "therefore X" conclusion, not left implicit.

### 6. Power read (fox mode)

Before walking in, run trap detection — be "a fox to discover the snares":
- Whose status does your ask threaten? Expect resistance dressed as process objections.
- Is anyone positioned to take credit for or quietly kill your proposal? (Law 1: if the master's ego is fragile, attribute the idea's seed to their prior guidance.)
- Are you being baited into over-explaining? Law 4: say less than necessary — state the core ask, then stop talking.

Done when every trap and every credit-taking or credit-killing risk in the room is named.

## Output format

```
READ: [per-person: maturity / culture / friction / exec reads, one line each]
PURPOSES: Capital-P: [...] | lowercase-p: [...]
OPENING MOVES: [2-4 concrete moves, with exact phrasings where scripts exist]
DO NOT: [traps detected, steamroll risks, capital you must not spend here]
HANDOFF: [pick-your-battles, if gate fired]
```

## Failure modes

- **Prepping content, not people.** A perfect deck into a room misread is a loss. The field read comes first.
- **Truth-seeker posture.** If your prep notes contain "they just need to understand the data," you are playing moral superiority and "they think you're full of shit." Reframe as a curious influence problem: you control only the inputs to their processing.
- **Pride in your own maturity read.** If you catch yourself feeling superior after labeling someone a baby, the label is now clouding you, not helping you.
