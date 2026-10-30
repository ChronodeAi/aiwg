# AIWG release announcement guide

Write for someone who uses AI coding tools but is not an AIWG internals expert.
One reader, one job: after reading, they know what changed, how it helps them,
and what to type or set.

## Structure

1. Title: `# AIWG <version> - <short benefit-led title>`.
2. Opening, one or two sentences: what changed and why it matters.
3. Two to four short sections, one per thing a user would notice. Cover what it
   is, how it helps, and how to use it, in flowing prose, with one short
   command or config example where it helps.
4. "If you are upgrading": only things a user must do or would notice. At most
   four bullets.
5. Links: the versioned CHANGELOG entry and the relevant user guide. Never link
   `docs/decision/` or `docs/agents/`.

## Length and voice

Target 350–600 words. Plain words and short sentences. No hype, no exclamation
marks, no emoji. Calm and structured: name the trade-off, then the decision.
Use the AIWG voice framework's `friendly-explainer` profile (`aiwg show skill voice-apply`).
Cover the what, the help, and the use without labelled slots such as "Why it
matters:". The GitHub release body is a 120–200 word version with the same
facts and a link to the announcement.

## What to leave out

Field tables, precedence rules, evidence gates, benchmark requalification,
shard and test details, and PR-by-PR coverage. The CHANGELOG holds the full
technical record and stays as it is.

## Fact-check rule

Every claim must be true per the CHANGELOG section for the release. Do not
invent features. If unsure, leave it out. Social drafts ship with a
`verified-claims.md` mapping each claim to its CHANGELOG lines, and stay
`status: draft` with empty asset paths until Joe approves.

## Where the detail lives

`CHANGELOG.md` is the complete technical record for each release, and the
linked user guides hold reference detail. The announcement links to both
instead of repeating them. The same text, shortened, feeds the GitHub release
body and the GitHub Announcements discussion (see
[Release plan sidecars](release-plan-sidecars.md)).
