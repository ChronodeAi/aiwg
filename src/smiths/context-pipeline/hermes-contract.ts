/**
 * Hermes hybrid context contract (Hermes 0.21 alignment).
 *
 * Hermes loads exactly ONE project context file per turn, first-match-wins:
 * `.hermes.md` > `AGENTS.md` > `CLAUDE.md` > `.cursorrules`
 * (hermes-agent 0.21 `agent/prompt_builder.py:2540`). Two consequences the
 * generic context-pipeline must special-case for Hermes:
 *
 * 1. NO `.hermes.md` twin. The upstream twin (bootstrap pointer to
 *    WORKSPACE.md/AIWG.md) sits at the TOP of that priority chain — it
 *    suppresses AGENTS.md on every turn and pushes real context behind
 *    mid-session tool reads. Previously emitted AIWG twins and pre-alignment
 *    thin pointers are removed on regenerate; operator-authored `.hermes.md`
 *    files are preserved.
 * 2. AGENTS.md is the auto-loaded file, so it carries the CRITICAL rule
 *    directives inline (not behind a link), plus the Hermes 0.21 subagent
 *    context note: delegate_task children embed this file as binding
 *    conventions — briefings need the persona body, not re-inlined rules.
 *
 * The rule/note text is byte-for-byte shared with
 * `tools/agents/providers/hermes.mjs` (the direct-deploy generator) — the
 * sync test `context-pipeline-hermes.test.ts` fails if either copy drifts.
 */

export const HERMES_CRITICAL_RULES = `## CRITICAL Rules (always apply)

These are the highest-enforcement AIWG rules. Full bodies are reachable without
MCP:
- Find rules: \`aiwg discover "rule <topic>" --type rule\`
- Fetch a rule: \`aiwg show rule <name>\`

If the optional MCP sidecar is configured, the same surface is available through
\`mcp_aiwg_rule_list\` and \`mcp_aiwg_rule_show\`.

### Rule: skill-discovery (discover-first protocol)
Before declining a user request as "outside AIWG's scope" or improvising a
workflow from training data, you MUST run \`aiwg discover "<user need>"\`
against the user's need. Most AIWG skills are not in your context; they reach
you through \`aiwg discover\` + \`aiwg show <type> <name>\`. If MCP is available,
\`mcp_aiwg_discover\` and type-specific show tools are equivalent. Run discover
whenever the user mentions AIWG, a framework name (sdlc, research, forensics,
ops, marketing, security-engineering, media-curator, knowledge-base), or
capability keywords (skill, agent, command, rule, workflow).

### Rule: no-attribution
Never add AI-tool attribution to commits, PRs, code, or docs. No \`Co-Authored-By:\`,
no "Generated with", no "Written by [AI tool]". The AI is a tool; tools don't sign
their output. Applies to ALL platforms (Claude, Codex, Copilot, Cursor, etc.).

### Rule: anti-laziness
Never delete tests to make them pass. Never skip/disable tests. Never remove
features instead of fixing them. Never weaken assertions to be meaningless.
Never suppress CI/pipeline signals (\`continue-on-error\`, \`|| true\`, \`set +e\`).
If stuck after 3 honest attempts: escalate with full context, don't shortcut.
Within scope: leave nothing half-done — code + tests + docs + verification.

### Rule: citation-policy
Never fabricate citations, DOIs, URLs, or page numbers. Only cite sources that
exist in the research corpus (.aiwg/research/sources/). Match claim strength
to evidence quality (GRADE): HIGH = "demonstrates"; MODERATE = "suggests";
LOW = "limited evidence"; VERY LOW = "anecdotal". Document research gaps in
.aiwg/research/TODO.md when no source supports a claim.

### Rule: token-security
Never hard-code tokens, API keys, or secrets in source files or commit messages.
Never pass tokens as CLI arguments (visible in process list). Never echo or log
token values. Load from secure files (mode 600) or environment variables. Use
heredoc scope for multi-step operations so tokens don't persist beyond use.
Token files must NEVER be tracked in git (.gitignore enforced).

### Rule: versioning
CalVer format: \`YYYY.M.PATCH\` (e.g., \`2026.5.3\`). NEVER use leading zeros
(\`2026.01.5\` is broken — npm semver rejects it). Tags use \`v\` prefix.
CHANGELOG must use same format. PATCH resets each month.

### Rule: ops-safety
Detect interactive commands and flag for human execution (passwords, LUKS
passphrases, MFA — agents cannot type these). Gate destructive operations
(\`rm -rf\`, \`fdisk\`, \`mkfs\`, partition table changes) behind explicit
human confirmation. Assess blast radius before execution (CRITICAL = multi-host
/ data loss; HIGH = single-host outage). Dry-run first when the tool supports it.
Never cross host boundaries without confirmation.`;

export const HERMES_SUBAGENT_NOTE = `## Hermes Subagents (0.21+)

Use \`delegate_task(goal="...", context="...", output_schema={...})\` for AIWG workflows.
Hermes 0.21+ subagents embed the workspace's project context files (this
AGENTS.md) as binding conventions automatically — do not re-inline rules.
They still cannot call clarify/memory/cronjob/send_message: inline the AIWG
persona body and task specifics in \`context\`, and validate child returns
with \`output_schema\`.`;

// Pre-alignment hermes.mjs thin-pointer signatures (deployed 2026-08-28
// fleet). Matched exactly; anything else is operator content and preserved.
const AIWG_HERMES_MD_SIGNATURES = ['# Hermes Routing', 'thin Hermes pointer'];
const AIWG_MANAGED_SIGNATURE = '<!-- aiwg-managed -->';

import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

export interface HermesTwinAction {
  action: 'removed-managed-twin' | 'removed-stale-pointer' | 'preserved' | 'absent';
  warning: string;
}

/**
 * Remove previously emitted AIWG `.hermes.md` files. Never touches an
 * operator-authored file: a file is AIWG's only if it carries the managed
 * signature in its first lines OR matches the pre-alignment thin-pointer
 * signatures. Returns the action taken for logging.
 */
export async function removeStaleAiwgHermesTwin(
  _projectPath: string,
  twinPath: string,
): Promise<HermesTwinAction> {
  let content: string;
  try {
    content = await readFile(twinPath, 'utf8');
  } catch {
    return { action: 'absent', warning: '' };
  }
  const head = content.split('\n').slice(0, 4).join('\n');
  const isManagedTwin = head.includes(AIWG_MANAGED_SIGNATURE);
  const isStalePointer =
    !isManagedTwin &&
    content.length < 2_000 &&
    AIWG_HERMES_MD_SIGNATURES.every((s) => content.includes(s));
  if (!isManagedTwin && !isStalePointer) {
    return {
      action: 'preserved',
      warning: `.hermes.md is operator-authored — preserved (it still takes precedence over AGENTS.md in Hermes's first-match loading).`,
    };
  }
  await rm(twinPath);
  const why = isManagedTwin ? 'managed twin' : 'stale thin pointer';
  return {
    action: isManagedTwin ? 'removed-managed-twin' : 'removed-stale-pointer',
    warning: `Removed AIWG ${why} (${path.basename(twinPath)}) — AGENTS.md now loads on Hermes turns (0.21 first-match-wins: .hermes.md > AGENTS.md).`,
  };
}
