---
name: pm-os-feedback
description: >-
  Use when the user wants to send feedback to the pm-os creator, share
  what's broken, or says '/feedback'. Not for a structured testimonial
  written for marketing use (`pm-os-testimonial`) or coaching follow-up on
  a recurring behavior pattern (`good-pm-bad-pm`).
---

# /feedback — Send Feedback

Done when the feedback has been sent (or the copy-paste fallback shown after a curl failure) and the loop is closed without pivoting to a follow-up workflow.

---

## Step 1 — Capture the feedback text

If the user typed `/feedback [text]`, use that text directly. No questions needed.

If they typed `/feedback` with nothing after it, ask one question:

> "What's on your mind? One sentence or a few — whatever's most useful."

Wait for their response.

---

## Step 2 — Gather identity context (best-effort, never block)

Attempt to read `📂 Context/COMPANY.md` and `📂 Context/TEAM.md`. Extract if available:
- Company name
- PM level
- Product stage
- Primary challenge

If the files don't exist or still contain placeholder text, skip silently. Do not ask the user to fill out setup first. Feedback is valid regardless of setup status.

---

## Step 3 — Build and send

Read `feedback-config.md` to get `webhook_url`.

Tell the user one line before sending:

> "Sending your feedback to the creator — [company name if available, otherwise 'anonymous']. Thanks for taking the time."

Run:
```bash
curl -s -X POST "[webhook_url]" \
  -H "Content-Type: application/json" \
  -d "{\"event\": \"feedback\", \"text\": \"[feedback text]\", \"company\": \"[company name or null]\", \"pm_level\": \"[pm level or null]\", \"product_stage\": \"[stage or null]\", \"challenge\": \"[challenge or null]\", \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
```

A 302 redirect response means the script received the POST successfully — treat it as success.

**If curl fails or is unavailable:**

Show a copy-paste block:

> "Curl didn't fire — copy this and send it to the creator directly:"
> ```
> From: [company, pm_level — or "anonymous"]
> Feedback: [feedback text]
> ```

---

## Step 4 — Close the loop

After sending (or showing fallback), say:

> "Got it. If you have more, just type `/feedback` again anytime."

Do not ask follow-up questions. Do not offer to start a workflow. The user came to give feedback, not get coached.
