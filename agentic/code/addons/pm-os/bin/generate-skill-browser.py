#!/usr/bin/env python3
"""generate-skill-browser.py

HTML generator for the Skill Browser.

Reads:
  registry/skills.json
  registry/workflows.json
  Each skill's SKILL.md (for the `## Required Inputs` body section)

Writes:
  skills/skill-browser/skill-browser.html

All HTML is rendered server-side here with explicit escaping. Browser-side
JS only toggles visibility, reads data-* attributes, and uses textContent
or cloneNode — it never writes HTML strings to the DOM. This sidesteps
XSS risk and keeps the script small.

Categories live in bin/skill-taxonomy.json (canonical 14 + 5 themes) and
bin/skill-categories.json (slug → category map). The bash validator at
bin/validate-skill-categories.sh enforces consistency across both files
and the on-disk SKILL.md set.
"""

from __future__ import annotations

import hashlib
import html as htmllib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Canonical taxonomy — categories + theme grouping + de-emphasis flag.
# Single source of truth shared by the generator and the bash validator
# (bin/validate-skill-categories.sh). Adding a category, reorganizing
# themes, or toggling de-emphasis is a one-file edit.
TAXONOMY_PATH = ROOT / "bin/skill-taxonomy.json"

# Curated assignments win over heuristics. Loaded from bin/skill-categories.json
# (the durable human-reviewed result of triage curation).
ASSIGNMENTS_PATH = ROOT / "bin/skill-categories.json"


def _load_taxonomy() -> dict:
    if not TAXONOMY_PATH.is_file():
        raise SystemExit(f"FATAL: {TAXONOMY_PATH.relative_to(ROOT)} not found.")
    try:
        return json.loads(TAXONOMY_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"FATAL: {TAXONOMY_PATH.relative_to(ROOT)} is not valid JSON: {exc}")


TAXONOMY = _load_taxonomy()
CATEGORIES: list[str] = TAXONOMY["categories"]
THEMES: list[dict] = TAXONOMY["themes"]  # each: {"name": str, "categories": list[str], "deemphasized"?: bool}


OVERRIDES: dict[str, str] = {
    "strategy": "Strategy & Vision",
    "decisions": "Decisions & Prioritization",
    "research": "Discovery & Research",
    "stakeholder": "Stakeholders & Politics",
    "meeting": "Meetings & Facilitation",
    "coaching": "Coaching, Self-Management & Career",
    "measure": "Metrics & Measurement",
    "prd": "PRD, Specs & Documentation",
    "opportunity": "Strategy & Vision",
    "assumptions": "Discovery & Research",
    "pm-help": "Coaching, Self-Management & Career",
    "pm-os-start": "Coaching, Self-Management & Career",
    "pm-os-skill": "Coaching, Self-Management & Career",
    "pm-os-framework": "Coaching, Self-Management & Career",
    "pm-os-tidy": "Coaching, Self-Management & Career",
    "pm-os-project": "Coaching, Self-Management & Career",
    "pm-os-capture-memory": "Coaching, Self-Management & Career",
    "pm-os-daily-drip": "Coaching, Self-Management & Career",
    "pm-os-upgrade": "Coaching, Self-Management & Career",
    "pm-os-feedback": "Coaching, Self-Management & Career",
    "pm-os-testimonial": "Coaching, Self-Management & Career",
    "pm-status": "Coaching, Self-Management & Career",
    "pm-review": "PRD, Specs & Documentation",
    "skill-browser": "Coaching, Self-Management & Career",
    "import-ai-memory": "Coaching, Self-Management & Career",
}

RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\b(prd|requirements?|user[-_ ]?stor|use[-_ ]?case|acceptance|gherkin|specifications?)\b", re.I), "PRD, Specs & Documentation"),
    (re.compile(r"\b(1[-_:]on[-_:]1|stand[-_]?up|agendas?|facilitat|meeting[-_ ]?(prep|summary)|hidden[-_ ]?agendas?)\b", re.I), "Meetings & Facilitation"),
    (re.compile(r"\b(design|prototype|wireframe|affordances?|signifiers?|figma|clickable|aesthetic|ux|ui)\b", re.I), "Design & Prototyping"),
    (re.compile(r"\b(metric|north[-_ ]?star|kpi|okr|analytics|measure(ment)?|experiments?|ab[-_ ]?tests?|funnel|conversion|fermi|rule[-_ ]?of[-_ ]?five|value[-_ ]?of[-_ ]?information|clarification|churn|aha[-_ ]?moment)\b", re.I), "Metrics & Measurement"),
    (re.compile(r"\b(research|interviews?|jtbd|user[-_ ]?(test|hypothesis)|discovery|transcripts?|persona|empathy|insights?)\b", re.I), "Discovery & Research"),
    (re.compile(r"\b(stakeholders?|politic|power[-_ ]?map|alignment|misalign|davci|raci|orchestrate)\b", re.I), "Stakeholders & Politics"),
    (re.compile(r"\b(comms|communications?|crisis[-_ ]?comms|exec[-_ ]?(deck|update|feedback)|narratives?|cta[-_ ]?copy|copywriting|story[-_ ]?deck|messaging|cialdini|influences?|persuad|presentations?)\b", re.I), "Communication, Writing & Influence"),
    (re.compile(r"\b(coach(ing)?|career|blind[-_ ]?spot|self[-_ ]|adhd|personals?|leadership|boss|difficult[-_ ]?conversation|feedback[-_ ]?loop|continuous[-_ ]?learning)\b", re.I), "Coaching, Self-Management & Career"),
    (re.compile(r"\b(strategy|strateg|vision|competitive|moats?|positioning|swot|value[-_ ]?chain|disruption|business)\b", re.I), "Strategy & Vision"),
    (re.compile(r"\b(decisions?|prioritiz|rice|tradeoffs?|two[-_ ]?way[-_ ]?door|reversibility|bug[-_ ]?triage)\b", re.I), "Decisions & Prioritization"),
    (re.compile(r"\b(trees?|brainstorm|mece|thinking|frameworks?|constrain|what[-_ ]?ifs?|ideation|5[-_ ]?whys|five[-_ ]?whys|issue[-_ ]?tree|causal|six[-_ ]?hats|critical[-_ ]?decision)\b", re.I), "Ideation & Analytical Thinking"),
]

FALLBACK_CATEGORY = "Ideation & Analytical Thinking"


def load_assignments() -> dict[str, str]:
    if ASSIGNMENTS_PATH.is_file():
        try:
            data = json.loads(ASSIGNMENTS_PATH.read_text())
            # Drop any entries pointing at categories we no longer support.
            valid = {s: c for s, c in data.items() if c in CATEGORIES}
            return valid
        except (OSError, json.JSONDecodeError):
            return {}
    return {}


_ASSIGNMENTS_CACHE: dict[str, str] | None = None


def categorize(slug: str, name: str, description: str) -> str:
    global _ASSIGNMENTS_CACHE
    if _ASSIGNMENTS_CACHE is None:
        _ASSIGNMENTS_CACHE = load_assignments()
    if slug in _ASSIGNMENTS_CACHE:
        return _ASSIGNMENTS_CACHE[slug]
    if slug in OVERRIDES:
        return OVERRIDES[slug]
    haystack = f"{slug} {name} {description}"
    for pattern, category in RULES:
        if pattern.search(haystack):
            return category
    return FALLBACK_CATEGORY


def derive_output(description: str) -> str:
    main = re.split(r"\s+Use when\b", description, maxsplit=1)[0].strip()
    main = re.split(r"\.\s+", main, maxsplit=1)[0].strip().rstrip(".")
    if len(main) > 110:
        main = main[:110].rsplit(" ", 1)[0] + "…"
    return main


def parse_required_inputs(skill_path_str: str) -> list[str]:
    """Parse the `## Required Inputs` section of a SKILL.md file.

    Returns a list of input name strings (just the bold-labeled bullets).
    Descriptions are intentionally elided for compactness on cards.
    Returns empty list when the section is absent.
    """
    skill_path = ROOT / skill_path_str
    if not skill_path.is_file():
        return []
    try:
        body = skill_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []

    heading_re = re.compile(r"^##\s+Required\s+Inputs\s*$", re.MULTILINE | re.IGNORECASE)
    m = heading_re.search(body)
    if not m:
        return []

    rest = body[m.end():]
    next_heading = re.search(r"^##\s+", rest, re.MULTILINE)
    section = rest[: next_heading.start()] if next_heading else rest

    inputs: list[str] = []
    for line in section.splitlines():
        bullet = re.match(r"^\s*-\s*\*\*(.+?)\*\*", line)
        if bullet:
            name = bullet.group(1).strip()
            if name:
                inputs.append(name)
    return inputs


def workflow_membership(slug: str, workflows: list[dict]) -> list[str]:
    members: list[str] = []
    for w in workflows:
        for skill_path in w.get("skills") or []:
            if f"/{slug}/" in skill_path:
                members.append(w["command"])
                break
    return members


def e(text) -> str:
    return htmllib.escape(str(text), quote=True)


def render_card(idx_id: str, skill: dict) -> str:
    badges: list[str] = []
    if skill["is_workflow"]:
        badges.append('<span class="badge badge-workflow">Workflow</span>')
    elif skill["provenance"] == "external":
        badges.append('<span class="badge badge-external">External</span>')
    badge_html = "".join(badges)

    # Workflow membership pills — placed under the title, distinct treatment
    wf_pills = ""
    if skill["in_workflows"]:
        pills = "".join(
            f'<span class="wf-pill">/{e(w)}</span>'
            for w in skill["in_workflows"]
        )
        wf_pills = f'<div class="card-workflows"><span class="wf-prefix">Chained in</span>{pills}</div>'

    # Inputs row (only if present)
    inputs_row = ""
    if skill["inputs"]:
        bullets = "".join(f"<li>{e(i)}</li>" for i in skill["inputs"])
        inputs_row = (
            '<div class="meta-row">'
            '<span class="meta-label">Inputs</span>'
            f'<ul class="meta-list">{bullets}</ul>'
            '</div>'
        )

    return (
        f'<article class="card" id="{idx_id}" '
        f'data-category="{e(skill["category"])}" '
        f'data-slug="{e(skill["slug"])}">'
        '<div class="card-header">'
        f'<h3 class="card-name">{e(skill["name"])}</h3>'
        f'{badge_html}'
        '</div>'
        f'{wf_pills}'
        f'<p class="card-desc">{e(skill["description"])}</p>'
        '<div class="card-meta">'
        '<div class="meta-row">'
        '<span class="meta-label">Category</span>'
        f'<span class="meta-value" data-meta="category">{e(skill["category"])}</span>'
        '</div>'
        f'{inputs_row}'
        '<div class="meta-row">'
        '<span class="meta-label">Output</span>'
        f'<span class="meta-value">{e(skill["output"])}</span>'
        '</div>'
        '<div class="meta-row">'
        '<span class="meta-label">Run</span>'
        f'<span class="invocation">Run PMOS skill: {e(skill["slug"])}</span>'
        '</div>'
        '</div>'
        '</article>'
    )


def render_workflow_card(w: dict) -> str:
    chained_preview = ", ".join(e(c) for c in w["chained"][:5])
    suffix = "…" if len(w["chained"]) > 5 else ""
    count = w["chained_count"]
    plural = "" if count == 1 else "s"
    desc = (
        f"Chains {count} skill{plural}: {chained_preview}{suffix}"
        if count else "Standalone workflow."
    )
    return (
        '<article class="card workflow-card">'
        '<div class="card-header">'
        f'<h3 class="card-name">PMOS workflow: {e(w["command"])}</h3>'
        '<span class="badge badge-workflow">Workflow</span>'
        '</div>'
        f'<p class="card-desc">{desc}</p>'
        '<div class="card-meta">'
        '<div class="meta-row">'
        '<span class="meta-label">Run</span>'
        f'<span class="invocation">Run PMOS workflow: {e(w["command"])}</span>'
        '</div>'
        '</div>'
        '</article>'
    )


def render_sidebar() -> str:
    parts: list[str] = []

    # Workflows anchor at the top — distinct from category nav
    parts.append(
        '<button type="button" class="sidebar-workflows" data-cat="__landing__">'
        '<span class="workflows-kicker">Start here</span>'
        '<span class="workflows-title">Workflows</span>'
        '<span class="workflows-meta">11 sequenced playbooks</span>'
        '</button>'
    )

    # Themes with `deemphasized: true` get muted styling — utility categories
    # (e.g. "Inside PM OS") rendered below the main themes, smaller and dimmer.
    for theme in THEMES:
        theme_class = "theme theme-utility" if theme.get("deemphasized") else "theme"
        parts.append(f'<div class="{theme_class}"><div class="theme-header">{e(theme["name"])}</div>')
        for cat in theme["categories"]:
            count_id = f"count-{hashlib.md5(cat.encode()).hexdigest()[:8]}"
            parts.append(
                f'<button type="button" class="category" data-cat="{e(cat)}">'
                f'<span class="cat-name">{e(cat)}</span>'
                f'<span class="count" id="{count_id}"></span>'
                '</button>'
            )
        parts.append('</div>')
    return "".join(parts)


def render_category_sections(skills: list[dict]) -> str:
    sections: list[str] = []
    for cat in CATEGORIES:
        in_cat = [s for s in skills if s["category"] == cat]
        in_cat.sort(key=lambda s: s["name"].lower())
        n = len(in_cat)
        plural = "" if n == 1 else "s"
        cards = "".join(render_card(f"card-{s['slug']}", s) for s in in_cat)
        sections.append(
            f'<section class="category-section" data-cat="{e(cat)}" hidden>'
            f'<h2>{e(cat)}</h2>'
            f'<div class="section-meta">{n} skill{plural}</div>'
            f'<div class="cards">{cards}</div>'
            '</section>'
        )
    return "".join(sections)


def render_search_section(skills: list[dict]) -> str:
    sorted_skills = sorted(skills, key=lambda s: s["name"].lower())
    cards = "".join(render_card(f"sc-{s['slug']}", s) for s in sorted_skills)
    return (
        '<section class="search-section" hidden>'
        '<h2 id="search-heading"></h2>'
        '<div class="section-meta" id="search-meta"></div>'
        f'<div class="cards" id="search-cards">{cards}</div>'
        '<div class="zero-state" id="zero-state" hidden>'
        '<p>No skills matched. Try a broader term — or browse by category:</p>'
        '<div class="chips" id="zero-chips"></div>'
        '</div>'
        '</section>'
    )


def render_landing(workflows: list[dict], total: int) -> str:
    cards = "".join(render_workflow_card(w) for w in workflows)
    return (
        '<section class="landing-section">'
        '<div class="workflow-intro">'
        f'<h2>{total} skills. <span class="hl">Use one.</span> Or chain a dozen.</h2>'
        '<p>These 11 workflows are the highest-leverage way to use PM OS — each chains '
        'multiple skills end-to-end. Or pick a category on the left to browse the library.</p>'
        '</div>'
        '<div class="section-meta">11 workflows</div>'
        f'<div class="cards">{cards}</div>'
        '</section>'
    )


def main() -> int:
    skills_path = ROOT / "registry/skills.json"
    workflows_path = ROOT / "registry/workflows.json"
    out_path = ROOT / "skills/skill-browser/skill-browser.html"

    skills_raw = json.loads(skills_path.read_text())
    workflows_raw = json.loads(workflows_path.read_text())
    workflow_commands = {w["command"] for w in workflows_raw}

    enriched: list[dict] = []
    for s in skills_raw:
        cat = categorize(s["slug"], s["name"], s["description"])
        out = derive_output(s["description"])
        members = workflow_membership(s["slug"], workflows_raw)
        inputs = parse_required_inputs(s["path"])
        enriched.append({
            "slug": s["slug"],
            "name": s["name"],
            "description": s["description"],
            "provenance": s["provenance"],
            "category": cat,
            "output": out,
            "inputs": inputs,
            "is_workflow": s["slug"] in workflow_commands,
            "in_workflows": members,
        })

    counts: dict[str, int] = {c: 0 for c in CATEGORIES}
    for s in enriched:
        counts[s["category"]] += 1

    workflow_cards: list[dict] = []
    for w in workflows_raw:
        chained = [Path(p).parent.name for p in (w.get("skills") or [])]
        workflow_cards.append({
            "command": w["command"],
            "chained": chained,
            "chained_count": len(chained),
        })
    workflow_cards.sort(key=lambda w: w["command"])

    # Search index (lowercase only)
    search_index = [
        {
            "id": f"sc-{s['slug']}",
            "n": s["name"].lower(),
            "d": s["description"].lower(),
            "c": s["category"].lower(),
            "o": s["output"].lower(),
        }
        for s in sorted(enriched, key=lambda x: x["name"].lower())
    ]

    counts_payload = {
        f"count-{hashlib.md5(cat.encode()).hexdigest()[:8]}": counts[cat]
        for cat in CATEGORIES
    }

    sidebar_html = render_sidebar()
    category_sections_html = render_category_sections(enriched)
    search_section_html = render_search_section(enriched)
    landing_html = render_landing(workflow_cards, len(enriched))

    def js_safe(obj) -> str:
        return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).replace("</", "<\\/")

    hash_payload = {
        "skills": [(s["slug"], s["category"], s["output"], s["inputs"]) for s in enriched],
        "workflows": [(w["command"], w["chained"]) for w in workflow_cards],
        "categories": CATEGORIES,
    }
    data_hash = hashlib.sha256(
        json.dumps(hash_payload, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:16]

    html = TEMPLATE.format(
        total=len(enriched),
        sidebar=sidebar_html,
        category_sections=category_sections_html,
        search_section=search_section_html,
        landing=landing_html,
        search_data=js_safe(search_index),
        counts_json=js_safe(counts_payload),
        chip_categories=js_safe(CATEGORIES),
        data_hash=data_hash,
    )

    if "--check" in sys.argv:
        current = out_path.read_text(encoding="utf-8") if out_path.exists() else ""
        if current == html:
            print(f"OK: {out_path.relative_to(ROOT)} is current ({len(enriched)} skills)")
            return 0
        print(
            f"ERROR: {out_path.relative_to(ROOT)} is stale — run "
            "`python3 bin/generate-skill-browser.py` and commit the result.",
            file=sys.stderr,
        )
        return 1

    out_path.write_text(html, encoding="utf-8")

    size_kb = len(html) / 1024
    print(f"✓ Generated {out_path.relative_to(ROOT)} ({size_kb:,.1f} KB)")
    print(f"  Hash: {data_hash}")
    skills_with_inputs = sum(1 for s in enriched if s["inputs"])
    print(f"  Skills: {len(enriched)} | With inputs: {skills_with_inputs} | Workflows: {len(workflow_cards)}")
    print()
    print("Counts per category:")
    for c in CATEGORIES:
        print(f"  {counts[c]:>3}  {c}")
    print()
    print(f"file://{out_path.resolve()}")
    return 0


TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="pm-os-skill-browser-hash" content="{data_hash}">
<title>PM OS — {total} Skills</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@500;700;800&display=swap">
<style>
:root {{
  --background: oklch(0.9821 0 0);
  --foreground: oklch(0.2435 0 0);
  --primary: oklch(0.4341 0.0392 41.9938);
  --primary-foreground: oklch(1 0 0);
  --secondary: oklch(0.9200 0.0651 74.3695);
  --secondary-foreground: oklch(0.3499 0.0685 40.8288);
  --muted-foreground: oklch(0.5032 0 0);
  --accent: oklch(0.9310 0 0);
  --cream-paper: #f8f3e7;
  --cream-panel: #fbf7ee;
  --amber-highlight: #FFB36640;
  --amber-solid: #FFB366;
  --brown-accent: #6B4423;
  --heading-font: 'IBM Plex Sans', -apple-system, 'Segoe UI', system-ui, sans-serif;
  --body-font: -apple-system, 'Segoe UI', system-ui, sans-serif;
  --mono-font: 'SF Mono', Monaco, Menlo, Consolas, 'Liberation Mono', monospace;
}}

* {{ box-sizing: border-box; margin: 0; padding: 0; }}
html, body {{ background: var(--background); color: var(--foreground); }}
body {{
  font-family: var(--body-font);
  font-size: 15px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}}

[hidden] {{ display: none !important; }}
button {{ font-family: inherit; font-size: inherit; cursor: pointer; }}
kbd {{
  font-family: var(--mono-font);
  font-size: 0.75rem;
  background: var(--accent);
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid rgba(0,0,0,0.08);
  color: var(--foreground);
}}

header {{
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--cream-paper);
  border-bottom: 1px solid var(--accent);
  padding: 1rem 2rem;
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(280px, 2fr) minmax(160px, 1fr);
  align-items: center;
  gap: 1.5rem;
}}

.brand {{
  font-family: var(--heading-font);
  font-weight: 800;
  font-size: 1.05rem;
  letter-spacing: -0.015em;
  color: var(--foreground);
  cursor: pointer;
}}

.brand-hl {{
  background: var(--amber-highlight);
  padding: 0 6px;
  border-radius: 2px;
  font-weight: 700;
  white-space: nowrap;
}}

.search {{ position: relative; width: 100%; }}

.search input {{
  width: 100%;
  padding: 0.6rem 2.6rem 0.6rem 1rem;
  border: 1px solid var(--accent);
  border-radius: 8px;
  background: var(--background);
  font: inherit;
  color: inherit;
}}

.search input:focus {{
  outline: none;
  border-color: var(--brown-accent);
  box-shadow: 0 0 0 3px rgba(107, 68, 35, 0.08);
}}

.search button {{
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  font-size: 1.3rem;
  color: var(--muted-foreground);
  width: 28px;
  height: 28px;
  line-height: 1;
  padding: 0;
}}

.search button:hover {{ color: var(--foreground); }}

.search-hint {{
  position: absolute;
  right: 40px;
  top: 50%;
  transform: translateY(-50%);
  font-family: var(--mono-font);
  font-size: 0.7rem;
  color: var(--muted-foreground);
  background: var(--accent);
  padding: 2px 6px;
  border-radius: 3px;
  pointer-events: none;
}}

.counter {{
  font-family: var(--heading-font);
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--muted-foreground);
  text-align: right;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}}

.layout {{
  display: grid;
  grid-template-columns: 260px 1fr;
  max-width: 1280px;
  margin: 0 auto;
}}

.sidebar {{
  background: var(--cream-panel);
  padding: 2rem 1.25rem 3rem;
  border-right: 1px solid var(--accent);
  position: sticky;
  top: 73px;
  height: calc(100vh - 73px);
  overflow-y: auto;
}}

.sidebar .theme {{ margin-bottom: 1.4rem; }}
.sidebar .theme-header {{
  font-family: var(--heading-font);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--brown-accent);
  margin-bottom: 0.5rem;
  padding-left: 0.5rem;
}}

/* Workflows anchor — top of sidebar, distinct from category list */
.sidebar-workflows {{
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 0.85rem 0.85rem;
  margin-bottom: 1.5rem;
  background: var(--cream-paper);
  border: 1px solid rgba(107, 68, 35, 0.18);
  border-radius: 8px;
  text-align: left;
  color: var(--foreground);
  font-family: inherit;
  transition: background 120ms ease, border-color 120ms ease;
  gap: 0.05rem;
}}

.sidebar-workflows:hover {{
  background: var(--amber-highlight);
  border-color: var(--brown-accent);
}}

.sidebar-workflows.selected {{
  background: var(--primary);
  color: var(--primary-foreground);
  border-color: var(--primary);
}}

.workflows-kicker {{
  font-family: var(--heading-font);
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--brown-accent);
  opacity: 0.85;
}}

.sidebar-workflows.selected .workflows-kicker {{
  color: var(--primary-foreground);
  opacity: 0.75;
}}

.workflows-title {{
  font-family: var(--heading-font);
  font-weight: 800;
  font-size: 1.05rem;
  letter-spacing: -0.015em;
  margin-top: 0.15rem;
}}

.workflows-meta {{
  font-size: 0.74rem;
  opacity: 0.7;
  margin-top: 0.15rem;
}}

/* De-emphasized utility theme (Operating & executing) — meta categories */
.theme-utility {{
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--accent);
}}

.theme-utility .theme-header {{
  opacity: 0.55;
  font-size: 0.62rem;
}}

.theme-utility .category {{
  font-size: 0.85rem;
  opacity: 0.72;
  padding: 0.35rem 0.6rem;
}}

.theme-utility .category:hover {{
  opacity: 1;
  background: var(--accent);
}}

.theme-utility .category.selected {{
  opacity: 1;
  background: var(--brown-accent);
  color: var(--primary-foreground);
  font-weight: 600;
}}

.theme-utility .category .count {{
  font-size: 0.7rem;
}}

.sidebar .category {{
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 0.42rem 0.6rem;
  border-radius: 5px;
  transition: background 120ms ease, color 120ms ease;
  font-size: 0.92rem;
  color: var(--foreground);
  background: none;
  border: none;
  width: 100%;
  text-align: left;
}}

.sidebar .category:hover {{ background: var(--secondary); }}
.sidebar .category.selected {{
  background: var(--primary);
  color: var(--primary-foreground);
  font-weight: 600;
}}

.sidebar .category .count {{
  font-family: var(--mono-font);
  font-size: 0.78rem;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}}

.sidebar .category.selected .count {{
  color: var(--primary-foreground);
  opacity: 0.75;
}}

.content {{
  padding: 2.5rem 2.5rem 4rem;
  min-height: calc(100vh - 73px);
}}

.content h2 {{
  font-family: var(--heading-font);
  font-weight: 800;
  font-size: 1.8rem;
  letter-spacing: -0.02em;
  margin-bottom: 0.3rem;
  color: var(--foreground);
}}

.content .hl {{
  background: var(--amber-highlight);
  padding: 0 6px;
  border-radius: 2px;
}}

.section-meta {{
  color: var(--muted-foreground);
  font-size: 0.78rem;
  margin-bottom: 1.5rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 600;
}}

.workflow-intro {{
  background: var(--cream-paper);
  padding: 1.75rem 2rem;
  border-radius: 12px;
  margin-bottom: 2rem;
}}

.workflow-intro h2 {{
  font-size: 2rem;
  margin-bottom: 0.5rem;
}}

.workflow-intro p {{
  color: var(--foreground);
  opacity: 0.75;
  max-width: 60ch;
}}

.cards {{
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
  gap: 1.25rem;
}}

.card {{
  background: var(--background);
  border: 1px solid var(--accent);
  border-radius: 10px;
  padding: 1.2rem 1.35rem;
  transition: transform 150ms ease, box-shadow 150ms ease, border-color 150ms ease;
  display: flex;
  flex-direction: column;
}}

.card:hover {{
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(107, 68, 35, 0.08);
  border-color: rgba(107, 68, 35, 0.25);
}}

.card.hidden-by-search {{ display: none; }}

.card-header {{
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
}}

.card-name {{
  font-family: var(--heading-font);
  font-weight: 700;
  font-size: 1.02rem;
  letter-spacing: -0.012em;
  word-break: break-word;
  color: var(--foreground);
}}

.badge {{
  font-family: var(--heading-font);
  font-size: 0.6rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 0.2rem 0.55rem;
  border-radius: 4px;
  white-space: nowrap;
  flex-shrink: 0;
}}

.badge-workflow {{
  background: var(--brown-accent);
  color: var(--primary-foreground);
}}

.badge-external {{
  background: var(--accent);
  color: var(--muted-foreground);
}}

/* Workflow membership pills — directly under the title */
.card-workflows {{
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-bottom: 0.7rem;
}}

.wf-prefix {{
  font-family: var(--heading-font);
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--brown-accent);
  margin-right: 0.15rem;
}}

.wf-pill {{
  font-family: var(--mono-font);
  font-size: 0.72rem;
  background: var(--amber-highlight);
  color: var(--brown-accent);
  padding: 0.12rem 0.5rem;
  border-radius: 999px;
  font-weight: 600;
  border: 1px solid rgba(107, 68, 35, 0.2);
}}

.card-desc {{
  color: var(--foreground);
  opacity: 0.8;
  font-size: 0.88rem;
  margin-bottom: 0.9rem;
  flex: 1;
}}

.card-meta {{
  font-size: 0.78rem;
  border-top: 1px dashed var(--accent);
  padding-top: 0.7rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}}

.meta-row {{
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
}}

.meta-label {{
  font-family: var(--heading-font);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
  color: var(--brown-accent);
  font-size: 0.62rem;
  white-space: nowrap;
  min-width: 78px;
  flex-shrink: 0;
  padding-top: 1px;
}}

.meta-value {{
  color: var(--foreground);
  opacity: 0.85;
}}

.meta-list {{
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}}

.meta-list li {{
  color: var(--foreground);
  opacity: 0.82;
  font-size: 0.78rem;
}}

.meta-list li::before {{
  content: "•";
  color: var(--brown-accent);
  font-weight: 700;
  margin-right: 0.4rem;
}}

.invocation {{
  font-family: var(--mono-font);
  font-size: 0.78rem;
  background: var(--cream-paper);
  padding: 0.12rem 0.45rem;
  border-radius: 3px;
  color: var(--brown-accent);
  user-select: all;
  display: inline-block;
}}

.zero-state {{
  background: var(--cream-paper);
  border-radius: 12px;
  padding: 2rem;
  text-align: center;
}}

.zero-state p {{
  color: var(--foreground);
  opacity: 0.7;
  margin-bottom: 1rem;
}}

.zero-state .chips {{
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: center;
}}

.chip {{
  padding: 0.4rem 0.9rem;
  background: var(--background);
  border: 1px solid var(--accent);
  border-radius: 999px;
  font-size: 0.85rem;
  transition: background 120ms ease;
  font-family: inherit;
  color: inherit;
}}

.chip:hover {{ background: var(--secondary); }}

@media (prefers-reduced-motion: reduce) {{
  *, *::before, *::after {{
    animation-duration: 0.001ms !important;
    transition-duration: 0.001ms !important;
  }}
}}

@media (max-width: 900px) {{
  .layout {{ grid-template-columns: 1fr; }}
  .sidebar {{
    position: relative;
    top: auto;
    height: auto;
    border-right: none;
    border-bottom: 1px solid var(--accent);
  }}
  header {{ grid-template-columns: 1fr; gap: 0.75rem; }}
  .counter {{ text-align: left; }}
}}
</style>
</head>
<body>
<header>
  <div class="brand" id="brand">PM OS — <span class="brand-hl">{total}&nbsp;skills</span></div>
  <div class="search">
    <input id="search" type="search" placeholder="Search {total} skills…" autocomplete="off" spellcheck="false">
    <span class="search-hint" id="search-hint">/</span>
    <button id="clear" type="button" aria-label="Clear search" hidden>×</button>
  </div>
  <div class="counter" id="counter">{total} skills</div>
</header>

<div class="layout">
  <aside class="sidebar" id="sidebar">{sidebar}</aside>
  <main class="content" id="content">
    {landing}
    {category_sections}
    {search_section}
  </main>
</div>

<script>
"use strict";

const SEARCH = {search_data};
const COUNTS = {counts_json};
const CATEGORIES = {chip_categories};
const TOTAL = {total};

// ===== DOM refs =====
const $search = document.getElementById("search");
const $clear = document.getElementById("clear");
const $searchHint = document.getElementById("search-hint");
const $counter = document.getElementById("counter");
const $sidebar = document.getElementById("sidebar");
const $brand = document.getElementById("brand");
const $sidebarWorkflows = document.querySelector(".sidebar-workflows");
const $landing = document.querySelector(".landing-section");
const $categorySections = document.querySelectorAll(".category-section");
const $searchSection = document.querySelector(".search-section");
const $searchHeading = document.getElementById("search-heading");
const $searchMeta = document.getElementById("search-meta");
const $zeroState = document.getElementById("zero-state");
const $zeroChips = document.getElementById("zero-chips");
const $searchCards = document.getElementById("search-cards").children;

// ===== State =====
let mode = "landing";   // "landing" | "category" | "search"
let activeCat = null;

// ===== Sidebar count injection =====
for (const [id, n] of Object.entries(COUNTS)) {{
  const el = document.getElementById(id);
  if (el) el.textContent = String(n);
}}

// ===== Build zero-state chips (safe textContent) =====
for (const cat of CATEGORIES) {{
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.textContent = cat;
  chip.addEventListener("click", () => selectCategory(cat));
  $zeroChips.appendChild(chip);
}}

// ===== Counter helpers =====
function setCounter(n) {{
  if (mode === "landing") {{
    $counter.textContent = TOTAL + " skills";
  }} else {{
    $counter.textContent = n + " of " + TOTAL + " skills";
  }}
}}

// ===== View switching =====
function showOnly(section) {{
  $landing.hidden = section !== "landing";
  $searchSection.hidden = section !== "search";
  for (const s of $categorySections) {{
    s.hidden = !(section === "category" && s.dataset.cat === activeCat);
  }}
}}

function selectCategory(cat) {{
  mode = "category";
  activeCat = cat;
  $search.value = "";
  $clear.hidden = true;
  $searchHint.hidden = false;
  $sidebarWorkflows.classList.remove("selected");
  for (const el of $sidebar.querySelectorAll(".category")) {{
    el.classList.toggle("selected", el.dataset.cat === cat);
  }}
  showOnly("category");
  const section = document.querySelector('.category-section[data-cat="' + cssEscape(cat) + '"]');
  const skillCount = section ? section.querySelectorAll(".card").length : 0;
  setCounter(skillCount);
  window.scrollTo({{ top: 0, behavior: "instant" }});
}}

function backToLanding() {{
  mode = "landing";
  activeCat = null;
  $search.value = "";
  $clear.hidden = true;
  $searchHint.hidden = false;
  $sidebarWorkflows.classList.add("selected");
  for (const el of $sidebar.querySelectorAll(".category")) {{
    el.classList.remove("selected");
  }}
  showOnly("landing");
  setCounter(TOTAL);
}}

function runSearch(query) {{
  mode = "search";
  activeCat = null;
  for (const el of $sidebar.querySelectorAll(".category")) {{
    el.classList.remove("selected");
  }}
  const q = query.toLowerCase();
  let matchCount = 0;
  for (let i = 0; i < SEARCH.length; i++) {{
    const card = $searchCards[i];
    const s = SEARCH[i];
    const hit = !!q && (s.n.includes(q) || s.c.includes(q) || s.o.includes(q) || s.d.includes(q));
    card.classList.toggle("hidden-by-search", !hit);
    if (hit) matchCount++;
  }}
  if (matchCount > 0) {{
    $searchHeading.textContent = matchCount + (matchCount === 1 ? " match" : " matches") + ' for "' + query + '"';
    $searchMeta.textContent = "across all categories";
    $zeroState.hidden = true;
  }} else {{
    $searchHeading.textContent = 'No matches for "' + query + '"';
    $searchMeta.textContent = "0 skills";
    $zeroState.hidden = false;
  }}
  showOnly("search");
  setCounter(matchCount);
  window.scrollTo({{ top: 0, behavior: "instant" }});
}}

function cssEscape(s) {{ return s.replace(/"/g, '\\"'); }}

// ===== General wiring =====
for (const el of $sidebar.querySelectorAll(".category")) {{
  el.addEventListener("click", () => selectCategory(el.dataset.cat));
}}

$sidebarWorkflows.addEventListener("click", backToLanding);
$brand.addEventListener("click", backToLanding);

$search.addEventListener("input", e => {{
  const v = e.target.value.trim();
  $clear.hidden = v.length === 0;
  $searchHint.hidden = v.length > 0;
  if (v.length === 0) {{
    if (activeCat) selectCategory(activeCat);
    else backToLanding();
  }} else {{
    runSearch(v);
  }}
}});

$search.addEventListener("focus", () => {{ $searchHint.hidden = true; }});
$search.addEventListener("blur", () => {{ if (!$search.value) $searchHint.hidden = false; }});

$clear.addEventListener("click", () => {{
  $search.value = "";
  $clear.hidden = true;
  $searchHint.hidden = false;
  if (activeCat) selectCategory(activeCat);
  else backToLanding();
  $search.focus();
}});

// Keyboard
document.addEventListener("keydown", e => {{
  // Always allow Esc
  if (e.key === "Escape") {{
    if (mode === "search") {{
      $search.value = "";
      $clear.hidden = true;
      $searchHint.hidden = false;
      if (activeCat) selectCategory(activeCat);
      else backToLanding();
      $search.blur();
      return;
    }}
    if (document.activeElement === $search) $search.blur();
    return;
  }}

  // Browse-mode shortcuts
  if (e.key === "/" && document.activeElement !== $search) {{
    e.preventDefault();
    $search.focus();
    $search.select();
  }}
}});

// Initial state — `?triage=1` is silently ignored (legacy URL from removed
// triage UI; no error, no artifacts, just lands on Workflows).
{{
  $sidebarWorkflows.classList.add("selected");
  showOnly("landing");
  setCounter(TOTAL);
}}
</script>
<!-- pm-os-skill-browser-hash: {data_hash} -->
</body>
</html>
"""


if __name__ == "__main__":
    sys.exit(main())
