#!/usr/bin/env node
/**
 * Report AIWG rules that declare no discovery trigger phrases (#2544).
 *
 * Rules are indexed like skills and support `triggers` in frontmatter or a
 * `## Triggers` section — but a rule's name describes the policy, not the
 * question an agent asks, so a rule without triggers only ranks on lexical
 * overlap with its title and loses to any skill whose triggers cover a token.
 *
 * Reports by default rather than failing: coverage closes incrementally, and a
 * hard gate would block unrelated work. Pass --fail-on-missing to gate CI once
 * coverage is where you want it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CODE_ROOT = path.join(ROOT, 'agentic', 'code');
// Plugin trees mirror framework/addon sources; linting both double-reports.
const GROUPS = ['frameworks', 'addons', 'extensions'];

const TRIGGER_SECTION =
  /(?:^|\n)##\s+(?:(?:Natural\s+Language\s+)?Triggers|Activation\s+Phrases|When\s+to\s+invoke)\b/i;

function ruleFiles() {
  const found = [];
  for (const group of GROUPS) {
    const groupDir = path.join(CODE_ROOT, group);
    let units;
    try {
      units = readdirSync(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const unit of units) {
      if (!unit.isDirectory()) continue;
      const rulesDir = path.join(groupDir, unit.name, 'rules');
      let entries;
      try {
        entries = readdirSync(rulesDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        // Generated indexes are not authored rules.
        if (entry.name === 'RULES-INDEX.md' || entry.name === 'RULES-ONDEMAND.md') continue;
        found.push(path.join(rulesDir, entry.name));
      }
    }
  }
  return found.sort();
}

function triggerCount(file) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(content);
  let count = 0;
  if (fm) {
    // Count list items under a `triggers:` key, stopping at the next top-level key.
    const block = /(?:^|\n)triggers:\s*\n((?:\s*-\s+.*\n?)+)/.exec(fm[1]);
    if (block) count += (block[1].match(/^\s*-\s+/gm) || []).length;
  }
  if (TRIGGER_SECTION.test(content)) count += 1;
  return count;
}

const files = ruleFiles();
const missing = [];
let withTriggers = 0;
for (const file of files) {
  if (triggerCount(file) > 0) withTriggers += 1;
  else missing.push(path.relative(ROOT, file));
}

const json = process.argv.includes('--json');
if (json) {
  console.log(JSON.stringify({
    total: files.length,
    withTriggers,
    missing,
  }, null, 2));
} else {
  const pct = files.length ? Math.round((withTriggers / files.length) * 100) : 0;
  console.log(`Rule discovery triggers: ${withTriggers}/${files.length} rules (${pct}%) declare trigger phrases`);
  if (missing.length > 0) {
    console.log('');
    console.log(`Rules with no triggers (${missing.length}) — reachable only by lexical title overlap:`);
    for (const file of missing) console.log(`  ${file}`);
    console.log('');
    console.log('Add 3-6 phrases stating the question an agent would ask.');
    console.log('See docs/development/rule-creation-guide.md');
  }
}

if (missing.length > 0 && process.argv.includes('--fail-on-missing')) process.exit(1);
