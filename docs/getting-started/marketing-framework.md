# Marketing Framework

> **First time using AIWG?** Begin with [Install, Connect, and Verify](install-connect-verify.md). This guide assumes
AIWG is connected to the target project and your provider session can read the deployed context.

You're running marketing campaigns — content, social, email, paid, events. You have a strategy but execution is fragmented. Different people working in different tools, inconsistent brand voice, no structured review before things go out.

The marketing framework gives you a campaign lifecycle: intake, strategy,
content creation across channels, brand and legal review, publication planning,
and performance analysis. Use it when campaign work needs a brief, reviewable
assets, and a record of what changed.

Each section below starts with what you can ask your assistant, then gives the command reference. Every command is kept exactly as shipped.

---

## Before You Start

Complete [Install, Connect, and Verify](install-connect-verify.md) first. If
you intentionally run a targeted deployment instead of the complete system,
`aiwg use marketing` remains the manual command for this framework.

The first useful result should be a campaign brief, content calendar, review
packet, or performance note saved under `.aiwg/marketing/`.

---

## Starting a campaign

### From a brief or idea

> "Start a campaign for our Q2 enterprise product launch. Ask me for goals, audience, and budget, and save the brief where I can review it."

Your assistant walks through campaign goals, audience definition, messaging pillars, channel mix, budget, and timeline.

> "We only target mid-market CTOs and the budget is fixed. Rework the brief around that."

Your assistant revises the brief against the corrected constraints.

#### Command reference — campaign intake

```bash
/marketing-intake-wizard "Q2 product launch for enterprise customers" --interactive
```

The wizard walks through campaign goals, audience definition, messaging pillars, channel mix, budget, and timeline. It generates a campaign brief and strategy document in `.aiwg/marketing/`.

### From existing assets

> "Build a campaign around these existing assets. Tell me what is missing before we create anything new."

Your assistant scans what you have, infers campaign intent, and identifies gaps.

If you already have some materials and need to build a campaign around them:

#### Command reference — intake from assets

```bash
/intake-from-campaign ./existing-assets --interactive
```

Scans what you have, infers campaign intent, identifies gaps, and generates the missing strategy documents.

---

## The campaign lifecycle

| Phase | What happens | Key commands |
|-------|-------------|-------------|
| **Strategy** | Goals, audience, messaging, channel selection | `/flow-strategy-baseline` |
| **Creation** | Content generation across channels | `/generate-content-calendar`, `/generate-social-content` |
| **Review** | Brand, legal, and quality validation | `/brand-validate`, `/legal-clearance` |
| **Publication** | Scheduling and deployment | `/flow-review-to-publication` |
| **Analysis** | Performance measurement and optimization | `/flow-performance-optimization` |

Check status at any point:

```
/campaign-status
```

---

## The agent roster

> "Which agent should write this piece, and what will I get back to review?"

Your assistant matches the work to a specialist agent and states what that agent returns. Where one agent briefs another, the brief names the goal, inputs, boundaries, result, and success check.

| Agent | Role |
|-------|------|
| `campaign-strategist` | Campaign architecture, channel strategy, measurement frameworks |
| `copywriter` | Headlines, CTAs, long-form copy, channel-specific messaging |
| `content-writer` | Blog posts, articles, case studies, whitepapers |
| `social-media-specialist` | Platform-native social content, community engagement |
| `email-marketer` | Email sequences, automation flows, subject line optimization |
| `seo-specialist` | Keyword research, on-page optimization, content briefs |
| `brand-guardian` | Brand guideline compliance, voice consistency |
| `legal-reviewer` | Regulatory compliance, claim validation, risk mitigation |
| `market-researcher` | Competitive intelligence, audience research |
| `marketing-analyst` | Performance data, trend analysis, optimization recommendations |
| `art-director` | Visual concept development, layout, brand visual consistency |

---

## Content creation

> "Generate a week of social content for LinkedIn and Twitter announcing our new feature. Keep it professional and save drafts for review."

Your assistant drafts channel-specific content against the campaign brief and saves it for review.

### Social content

#### Command reference — social content

```
Generate a week of social content for LinkedIn and Twitter announcing our new feature
```

```
/generate-social-content --campaign "Q2 launch" --channels "linkedin,twitter" --tone "professional"
```

### Blog and thought leadership

> "Write a practitioner blog post about our monolith-to-microservices move. Use the technical-authority voice."

Your assistant drafts the post against the campaign brief and brand voice.

#### Command reference — blog and email

```
Write a blog post about why we moved from monolith to microservices, written as a practitioner for other practitioners
```

### Email campaigns

```
Write a 3-email nurture sequence for enterprise prospects who downloaded our whitepaper
```

### Paid copy

```
Generate 10 ad headline variants for this product feature targeting CTOs at mid-market companies
```

---

## Brand and voice consistency

The marketing framework can work with the voice framework. Apply a brand voice
profile when the campaign has one:

```
Use the technical-authority voice for all content in this campaign
```

> "Check this content against our brand voice and list what to fix before it goes out."

Your assistant checks tone, vocabulary, visual description language, and structural patterns against your brand guidelines.

Run brand compliance review before anything goes out:

### Command reference — brand review

```
/brand-validate path/to/content.md
```

This checks tone, vocabulary, visual description language, and structural patterns against your brand guidelines.

---

## Legal review

> "Clear these campaign assets for legal. Flag unsubstantiated claims and missing disclosures."

Your assistant reviews for regulatory compliance, claim substantiation, required disclosures, and risk flags.

For campaigns making specific claims or running in regulated industries:

### Command reference — legal review

```
/legal-clearance path/to/campaign-assets/
```

Reviews for regulatory compliance, claim substantiation, required disclosures, and risk flags.

---

## Performance and analytics

> "Analyze last month for the Q2 launch. Separate what the data shows from what still needs validation."

Your assistant analyzes the campaign data you provide or connect.

After a campaign runs:

### Command reference — analytics

```
/campaign-analytics --campaign "Q2 launch" --period "last-30-days"
```

Analyzes the campaign data you provide or connect. The
`attribution-specialist` agent separates observed channel evidence from
assumptions that still need validation.

---

## Multi-channel coordination

> "Kick off the Q2 enterprise launch across email, social, blog, paid, and webinar. Keep messaging consistent and save the plan for review."

Your assistant orchestrates content creation across all channels with consistent messaging, proper sequencing, and cross-channel coordination.

Large campaigns spanning many channels:

### Command reference — coordination

```
/campaign-kickoff "Q2 Enterprise Launch" --channels "email,social,blog,paid,webinar"
```

This orchestrates content creation across all channels with consistent messaging, proper sequencing, and cross-channel coordination. The `campaign-orchestrator` agent ensures nothing conflicts and everything reinforces the core message.

**Agent-to-agent brief (example):**

```brief
Goal: draft launch emails for the Q2 enterprise launch. Inputs: campaign brief and messaging pillars. Boundaries: use approved claims only; no new offers. Result: three drafts with subject lines. Success check: each draft cites its brief section.
```

---

## Campaign retrospective

> "Write the retrospective for the Q2 launch: what worked, what did not, and what to change next time."

Your assistant documents performance against goals and recommendations for the next campaign.

When a campaign ends:

### Command reference — retrospective

```
/marketing-retrospective --campaign "Q2 launch"
```

Documents what worked, what didn't, performance against goals, and recommendations for the next campaign. Builds organizational memory so you don't repeat the same mistakes.

---

## Key references

- `/campaign-status` — Current campaign health dashboard
- `/marketing-status` — All campaigns overview
- `/content-planning` — Editorial calendar and content pipeline
- `@agentic/code/frameworks/media-marketing-kit/README.md` — Full framework documentation
