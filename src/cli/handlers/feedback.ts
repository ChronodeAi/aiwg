/**
 * Feedback Command Handler
 *
 * Submit a bug report, feature request, or feedback to the AIWG GitHub repository.
 * Prefills system context automatically (version, OS, Node, provider, frameworks).
 *
 * Usage:
 *   aiwg feedback                              # interactive (if TTY)
 *   aiwg feedback --type bug                   # skip type selection
 *   aiwg feedback --type feature               # feature request
 *   aiwg feedback --type doc                   # documentation gap
 *   aiwg feedback --title "X" --body "Y"       # fully non-interactive
 *   aiwg feedback --no-context                 # skip attaching system context
 *
 * Submission flow:
 *   1. If `gh` CLI is available → `gh issue create --repo jmagly/aiwg`
 *   2. Else → open browser with pre-filled GitHub issue URL
 *   3. If no browser → print the formatted issue body to stdout
 *
 * @issue #885
 */

import { boundedSpawnSync } from '../../process/bounded-child-process.mjs';
import os from 'os';
import { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { readAiwgConfig } from '../../config/aiwg-config.js';
import { createPromptInterface, askString, askChoice } from '../prompt-utils.js';
import { debug } from '../log.js';

// ── GitHub repo ───────────────────────────────────────────────────────────────

const GITHUB_REPO = 'jmagly/aiwg';
const GITHUB_ISSUES_URL = `https://github.com/${GITHUB_REPO}/issues/new`;

// ── Types ─────────────────────────────────────────────────────────────────────

type FeedbackType = 'bug' | 'feature' | 'doc' | 'other';

interface FeedbackArgs {
  type: FeedbackType | undefined;
  title: string | undefined;
  body: string | undefined;
  noContext: boolean;
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseFeedbackArgs(args: string[]): FeedbackArgs {
  let type: FeedbackType | undefined;
  let title: string | undefined;
  let body: string | undefined;
  let noContext = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--type' && args[i + 1]) {
      const raw = args[++i];
      if (['bug', 'feature', 'doc', 'other'].includes(raw)) {
        type = raw as FeedbackType;
      }
    } else if (a === '--title' && args[i + 1]) {
      title = args[++i];
    } else if (a === '--body' && args[i + 1]) {
      body = args[++i];
    } else if (a === '--no-context') {
      noContext = true;
    }
  }

  return { type, title, body, noContext };
}

// ── System context ────────────────────────────────────────────────────────────

interface SystemContext {
  aiwgVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  provider: string;
  frameworks: string[];
  shell: string;
}

async function collectSystemContext(cwd: string): Promise<SystemContext> {
  // aiwg version from package.json if available
  let aiwgVersion = 'unknown';
  try {
    const r = boundedSpawnSync(process.execPath, [process.argv[1]!, 'version'], 'quick', {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    const match = (r.stdout ?? '').match(/(\d{4}\.\d+\.\d+[^\s]*)/);
    if (match) aiwgVersion = match[1];
  } catch (err) {
    // Feedback command degrades gracefully when version detection fails; log
    // under AIWG_DEBUG=cli:feedback:* so the root cause is visible during
    // bug reproduction.
    debug('cli:feedback:version', 'version detect failed', err);
  }

  // Provider from project config
  let provider = 'claude';
  let frameworks: string[] = [];
  try {
    const config = await readAiwgConfig(cwd);
    if (config) {
      provider = config.providers[0] ?? 'claude';
      frameworks = Object.keys(config.installed);
    }
  } catch (err) {
    debug('cli:feedback:config', 'config read failed', err);
  }

  return {
    aiwgVersion,
    nodeVersion: process.version,
    platform: `${os.type()} ${os.release()} (${os.platform()})`,
    arch: os.arch(),
    provider,
    frameworks,
    shell: process.env.SHELL ?? process.env.COMSPEC ?? 'unknown',
  };
}

function formatContext(ctx: SystemContext): string {
  return [
    '**System context** (auto-collected by `aiwg feedback`):',
    '',
    `| Field | Value |`,
    `|-------|-------|`,
    `| aiwg version | \`${ctx.aiwgVersion}\` |`,
    `| Node.js | \`${ctx.nodeVersion}\` |`,
    `| OS | ${ctx.platform} |`,
    `| Arch | ${ctx.arch} |`,
    `| Provider | ${ctx.provider} |`,
    `| Frameworks | ${ctx.frameworks.length > 0 ? ctx.frameworks.join(', ') : '_none_'} |`,
    `| Shell | \`${ctx.shell}\` |`,
  ].join('\n');
}

// ── Issue templates ───────────────────────────────────────────────────────────

function bugTemplate(title: string, description: string, context: string): string {
  return `## Bug Report

**Title**: ${title}

## What happened

${description}

## Steps to reproduce

1.
2.
3.

## Expected behavior

<!-- What should have happened? -->

## Actual behavior

<!-- What actually happened? Paste error output here. -->

## Doctor output

<!-- Run \`aiwg doctor\` and paste the output here -->

---

${context}
`.trim();
}

function featureTemplate(title: string, description: string, context: string): string {
  return `## Feature Request

**Title**: ${title}

## Problem / motivation

${description}

## Proposed solution

<!-- How would you like this to work? -->

## Alternatives considered

<!-- Any alternative approaches? -->

---

${context}
`.trim();
}

function docTemplate(title: string, description: string, context: string): string {
  return `## Documentation Gap

**Title**: ${title}

## What is missing or wrong

${description}

## Where in the docs

<!-- Link to the relevant doc page or section, or paste the path -->

## What the docs should say

<!-- Your proposed correction or addition -->

---

${context}
`.trim();
}

function otherTemplate(title: string, description: string, context: string): string {
  return `## Feedback

**Title**: ${title}

${description}

---

${context}
`.trim();
}

function buildIssueBody(
  type: FeedbackType,
  title: string,
  description: string,
  sysCtx: SystemContext | null,
): string {
  const context = sysCtx ? formatContext(sysCtx) : '_System context omitted_';
  switch (type) {
    case 'bug':     return bugTemplate(title, description, context);
    case 'feature': return featureTemplate(title, description, context);
    case 'doc':     return docTemplate(title, description, context);
    default:        return otherTemplate(title, description, context);
  }
}

// ── Interactive prompts ───────────────────────────────────────────────────────
//
// Both prompts go through the shared prompt-utils wrapper so they inherit the
// AIWG_PROMPT_TIMEOUT_MS hard timeout (default 60s) and .unref()'d timer. A
// detached TTY can no longer hang the CLI on these prompts.

async function prompt(question: string, signal?: AbortSignal): Promise<string> {
  const rl = createPromptInterface();
  try {
    return await askString(rl, question, '', signal);
  } finally {
    rl.close();
  }
}

async function promptSelect(question: string, options: string[], signal?: AbortSignal): Promise<string> {
  console.log(`\n${question}`);
  options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
  const rl = createPromptInterface();
  try {
    return await askChoice(rl, '  Choice: ', options, options[0], signal);
  } finally {
    rl.close();
  }
}

// ── Submission ────────────────────────────────────────────────────────────────

function hasGhCli(): boolean {
  try {
    const r = boundedSpawnSync('gh', ['--version'], 'quick', { stdio: 'pipe' });
    return r.status === 0;
  } catch {
    return false;
  }
}

function submitViaGh(title: string, body: string, type: FeedbackType): boolean {
  const label = type === 'bug' ? 'bug' : type === 'feature' ? 'enhancement' : type === 'doc' ? 'documentation' : 'feedback';
  // Creates a GitHub issue via the `gh` CLI (network call); network tier (#3062).
  const result = boundedSpawnSync(
    'gh',
    ['issue', 'create', '--repo', GITHUB_REPO, '--title', title, '--body', body, '--label', label],
    'network',
    { stdio: 'inherit' },
  );
  return result.status === 0;
}

function submitViaBrowser(title: string, body: string): void {
  const url = new URL(GITHUB_ISSUES_URL);
  url.searchParams.set('title', title);
  // GitHub truncates long URLs — include as much of the body as fits
  const truncatedBody = body.length > 3000 ? body.slice(0, 2900) + '\n\n_[body truncated — paste full content manually]_' : body;
  url.searchParams.set('body', truncatedBody);

  const urlStr = url.toString();

  try {
    const openCmd = process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
    // Fire-and-forget local browser launch; quick tier (#3062).
    boundedSpawnSync(openCmd, [urlStr], 'quick', { stdio: 'ignore' });
    console.log(`\n  Opened GitHub in your browser to file the issue.`);
    console.log(`  If the browser did not open, visit:\n  ${urlStr}`);
  } catch {
    console.log(`\n  Could not open browser. Create the issue manually:\n  ${urlStr}`);
  }
}

function printIssue(title: string, body: string): void {
  console.log('\n── Issue body (copy-paste to GitHub) ──\n');
  console.log(`Title: ${title}\n`);
  console.log(body);
  console.log(`\n── Submit at: ${GITHUB_ISSUES_URL} ──`);
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const feedbackHandler: CommandHandler = {
  id: 'feedback',
  name: 'Feedback',
  description: 'Submit a bug report, feature request, or feedback to the AIWG GitHub repository',
  category: 'utility',
  aliases: ['report'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const args = parseFeedbackArgs(ctx.args);
    const cwd = ctx.cwd || process.cwd();
    const isTTY = Boolean(process.stdin.isTTY);

    // Collect system context
    const sysCtx = args.noContext ? null : await collectSystemContext(cwd);

    // ── Determine type ────────────────────────────────────────────
    let type: FeedbackType = args.type ?? 'other';
    if (!args.type && isTTY) {
      const choice = await promptSelect(
        'What kind of feedback?',
        ['Bug report', 'Feature request', 'Documentation gap', 'Other'],
        ctx.signal,
      );
      if (choice.startsWith('Bug')) type = 'bug';
      else if (choice.startsWith('Feature')) type = 'feature';
      else if (choice.startsWith('Doc')) type = 'doc';
      else type = 'other';
    }

    // ── Determine title ───────────────────────────────────────────
    let title = args.title ?? '';
    if (!title && isTTY) {
      title = await prompt('\n  Issue title (short phrase): ', ctx.signal);
    }
    if (!title) {
      title = `[${type}] Issue from aiwg feedback`;
    }

    // ── Determine description ─────────────────────────────────────
    let description = args.body ?? '';
    if (!description && isTTY) {
      description = await prompt('\n  Describe the issue (press Enter when done):\n  ', ctx.signal);
    }
    if (!description) {
      description = '_No description provided._';
    }

    // ── Build issue body ──────────────────────────────────────────
    const body = buildIssueBody(type, title, description, sysCtx);

    // ── Submit ────────────────────────────────────────────────────
    console.log(`\n  Submitting ${type} report: "${title}"`);

    if (hasGhCli()) {
      const ok = submitViaGh(title, body, type);
      if (ok) {
        console.log('\n  Issue filed successfully via `gh`.');
        return { exitCode: 0 };
      }
      console.warn('  gh issue create failed — falling back to browser.');
    }

    // Try browser
    if (isTTY) {
      submitViaBrowser(title, body);
    } else {
      printIssue(title, body);
    }

    return { exitCode: 0 };
  },
};
