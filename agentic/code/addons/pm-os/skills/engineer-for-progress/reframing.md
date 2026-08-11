# Reframing: symptom → function

## The move

A **symptom** is the user-visible effect ("paint drips"). A **function** is the underlying mechanism with a measurable quantity ("paint settles at 200μm thickness").

When you fix symptoms, you play whack-a-mole. Fix "drips" by thinning the paint and you get "orange peel." Fix "onboarding is confusing" by adding tooltips and you get "onboarding is bloated." The function — *paint thickness*, *time-to-first-value* — is what you actually want to control.

To make the move, ask: *what is the system supposed to do, in mechanical terms, with units?*

- *"Make checkout fast"* → *"95% of checkouts complete the payment step in under 3 seconds, measured server-to-confirmation."*
- *"Reduce support load"* → *"95% of new users complete first-value flow without contacting support within their first session."*
- *"Make it easy to use"* → unpack first (see below).

## Three things commonly confused

- **Job.** The progress a person is trying to make in a struggling circumstance. *"Help me consolidate three subscriptions into one so I can stop bleeding money on tools I don't use."* Owns the *who, when, why*.
- **Feature.** A supply-side attribute. *"Bulk delete button."* Owns the *what we ship*.
- **Requirement (spec).** A tech-agnostic, measurable target. *"User can deselect and remove 100+ items in one operation under 2 seconds."* Owns the *what the system must do*.

A common bug: features get treated as requirements. *"Add a bulk delete button"* is a feature pretending to be a requirement. The requirement is the operation count, the time bound, and the failure mode handling. The button is one possible input that satisfies the requirement.

## Vague-word unpack (borrowed from sales)

Symptoms often hide inside vague qualifiers: *easy, intuitive, fast, smooth, clean, simple, magical, modern, slick*. None of these are functions. Unpack before proceeding.

When the input says *"make it intuitive"*:

1. *"Intuitive like what?"* — force a reference.
2. *"Intuitive like the iOS Photos app, or intuitive like a spreadsheet?"* — bracket.
3. *"What's the opposite? Give an example of not-intuitive."* — get the boundary.
4. *"So if it behaved like [opposite example], you'd say it failed?"* — confirm.

The unpack ends when the vague word has been rewritten as an action with units: *intuitive = user completes task X without docs, in under N steps, on first attempt*.

## Right-to-left examples

| Outcome | Tech-agnostic requirement | Input | Build steps |
|---|---|---|---|
| New users feel oriented in first session | 80% reach onboarding completion in ≤10 min, ≤2 support pings | Guided checklist with 4 milestones, in-app | Build checklist component, instrument events, run weekly |
| Reduce LLM inference cost | Median request cost ≤ $0.002 with same quality scores | Cheaper model with augmentation, or routing | Build router, define quality eval, A/B against current |
| Customers can recover their account fast | 95% account recovery completes in ≤90s without human | Magic-link + backup-email + verified phone | Build recovery flow, instrument time-to-recover |

Notice: the input is *plural*. Right-to-left does not pre-commit to one input — it commits to the requirement, then lets the build phase pick.

## When to iterate the reframe

Iterate when:

- The function statement still names a feature ("the bulk delete button works").
- It still names a symptom ("doesn't crash").
- It uses a vague qualifier without an unpack.
- The measurable quantity is missing or fuzzy ("fast").
- The unit of measurement is missing ("3 seconds" without "for which operation under what load").
