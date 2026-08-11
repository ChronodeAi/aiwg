---
name: pm-os-testimonial
description: >-
  Use when the user wants to give a testimonial about pm-os or says
  '/testimonial'. Not for free-form feedback or bug reports
  (`pm-os-feedback`), or capturing an internal decision or update into
  project memory (`pm-os-capture-memory`).
---

# /testimonial — Testimony

Done when the four-question testimonial has been drafted, shown for approval, and sent (or the copy-paste fallback shown after a curl failure).

---

## Step 1 — Set the tone

Say:

> "Happy to write this for you — I'll ask four quick questions and turn your answers into something you'd actually want to put your name on. Takes about 5 minutes.
>
> Question 1 of 4: What was the PM challenge or situation you were dealing with when you first started using pm-os?"

Wait for their answer.

---

## Step 2 — Ask the remaining three questions, one at a time

**Q2:** "Which part of pm-os did you actually use? Be specific — a workflow, a skill, a framework, something from the knowledge base?"

Wait for answer.

**Q3:** "What changed? What did you ship, decide, or figure out that you might not have without it?"

Wait for answer.

**Q4:** "In one sentence — what would you tell a PM who's on the fence about trying pm-os?"

Wait for answer.

---

## Step 3 — Gather identity context (best-effort, never block)

Read `📂 Context/COMPANY.md` and `📂 Context/TEAM.md` if available. Extract:
- Company name (or type: "a Series B SaaS startup")
- PM level / role

If files don't exist or have placeholder text, skip. The testimonial still works.

---

## Step 4 — Write the testimonial

Using their four answers, write a testimonial that:
- Opens with the specific challenge or situation (concrete, not generic)
- Names the specific feature or workflow they used
- States the outcome clearly — what they shipped, decided, or changed
- Closes with their own one-sentence recommendation
- Reads in first person, their voice — not polished marketing copy
- Is 3–5 sentences, no longer

Show it to the user:

> "Here's your testimonial — let me know if you'd like to tweak anything, or say 'looks good' to send it."

Revise if they ask. Confirm before sending.

---

## Step 5 — Send

Read `feedback-config.md` to get `webhook_url`.

Tell the user:

> "Sending this to the creator — they'll love it. Thank you."

Run:
```bash
curl -s -X POST "[webhook_url]" \
  -H "Content-Type: application/json" \
  -d "{\"event\": \"testimonial\", \"text\": \"[full testimonial text]\", \"company\": \"[company name or type, or null]\", \"pm_level\": \"[pm level or null]\", \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
```

**If curl fails or is unavailable:**

Show a copy-paste block:

> "Curl didn't fire — copy this and send it to the creator directly:"
> ```
> [testimonial text]
> — [PM level] at [company or company type]
> ```

---

## Step 6 — Close

> "Saved. If anything changes or you want to update it later, just run `/testimonial` again."

Do not pivot to coaching or a workflow. The user came to leave a testimonial.
