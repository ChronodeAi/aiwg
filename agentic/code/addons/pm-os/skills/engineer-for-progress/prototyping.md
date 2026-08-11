# Prototyping and scope cutting

## Why orthogonal beats A/B

A/B tests change one variable, hold the rest constant. Three problems:

1. You learn that variable's marginal effect, not how the *system* behaves.
2. You can run forever — every test answers one question and surfaces three more.
3. The world doesn't move one variable at a time, so the test conditions don't match reality.

An **orthogonal array** changes multiple factors at once across a small set of variants, designed so each factor's effect can still be isolated mathematically. You learn how the system behaves under combinations.

## The matrix

For 3 control factors and 2 levels each (low/high), a Taguchi L4 orthogonal array gives you 4 variants that cover all the interaction space without running 2³=8 variants:

| Variant | Factor A | Factor B | Factor C |
|---|---|---|---|
| V1 | low | low | low |
| V2 | low | high | high |
| V3 | high | low | high |
| V4 | high | high | low |

Each factor appears at each level in exactly half the runs, and each pair of factors appears at each combination in exactly half. This is the Moesta/Taguchi move.

For 4 factors at 2 levels you use L8 (8 variants instead of 2⁴=16). For 7 factors at 2 levels, L8 still works (with caveats on interaction confounding).

You don't need to memorize the arrays — pick the smallest standard array that fits your factor count, lay it out, and run it.

## Noise injection

Each variant runs under noise extremes. Define noise factors *before* running:

- Worst plausible network.
- Worst plausible hardware (oldest supported phone, slowest laptop).
- Hostile user (clicks rapidly, mis-orders the flow, has 30 tabs open).
- Edge environment (timezone DST flip, locale that uses comma decimals, RTL language).
- Adversarial data (max-length strings, unicode edge cases, empty states, 10k items).

Run each variant under at least the worst noise combination. The variant that **stays robust** wins — not the variant that scores highest under ideal conditions.

## What "done" looks like for a prototype

You haven't tested the right thing until the result forces an **explicit tradeoff**.

- *"V3 is fastest but costs 4x in inference. V2 is mid-cost but degrades at high concurrency. V1 is cheap but fails on the hostile user."* → useful tradeoff.
- *"V3 won."* → suspicious; probably means the noise wasn't aggressive enough.

If no variant breaks, increase noise until one does. Knowing where each variant fails is more valuable than knowing one passes.

## Kick-ass half: the cut protocol

List every scope item. For each, classify:

- **big hire** — the user *won't adopt* without it. Cutting this kills the initial purchase. (Buying signup without password recovery = nobody trusts the signup.)
- **little hire** — the user *won't return* without it. Cutting this kills the habit. (Signup with password recovery but no notifications = users sign up once, leave.)
- **everything else** — cut or defer.

Two failure modes of the cut:

- **Cutting too shallow.** The "everything else" pile contains 1–2 items. You haven't really cut. Push harder — what would survive if the deadline halved?
- **Cutting too deep.** You cut a big-hire or little-hire feature thinking you'd "add it back." Adoption craters and you spend three months re-adding it. Protect the two protected categories explicitly.

For each cut item, record the reason in one line. Examples:

- *"Defer dashboard charts — users don't need analytics until week 3; not a little-hire."*
- *"Cut bulk import — power users only; users without it can paste 1-by-1; not a big-hire."*
- *"Defer SAML — needed by enterprise tier only; current cohort is self-serve."*

## Sequencing the prototype and the cut

Prototype first, cut second. The prototype tells you which factors are load-bearing under noise; the cut tells you which scope items defend those factors. Cutting before prototyping defends scope items you only *think* are load-bearing.

Exception: if scope is so bloated that you can't even prototype, cut once on intuition, then prototype, then cut again on evidence. Two-pass cut is fine. One-pass cut without prototype data is gambling.
