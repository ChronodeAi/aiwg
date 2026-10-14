#!/usr/bin/env node
/**
 * Sync Upstream - Sync Fork with Upstream Changes
 *
 * Implements upstream sync workflow for AIWG contributions.
 *
 * Usage:
 *   aiwg -contribute-sync <feature-name>
 *
 * Workflow:
 *   1. Check prerequisites (workspace exists, correct branch)
 *   2. Fetch upstream changes
 *   3. Show divergence (commits behind/ahead)
 *   4. Offer sync strategy (rebase or merge)
 *   5. Execute chosen strategy
 *   6. Handle conflicts if any
 *   7. Push to origin after successful sync
 *   8. Update workspace status
 */

import { boundedExecFileSync } from '../../src/process/bounded-child-process.mjs';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isMain } from '../_is-main.mjs';
import {
  loadWorkspaceData,
  updateWorkspaceStatus,
  workspaceExists
} from './lib/workspace-manager.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Mirrors `src/cli/env.ts`'s `isInteractive()` (same TTY/TERM/CI checks;
 * #3062 review item 12 — this script previously checked `process.stdin.isTTY`
 * alone, so a CI job with a pseudo-terminal could still reach its prompts).
 * Duplicated here, rather than imported, because this maintainer-only
 * script (not shipped in the npm package) runs directly via plain Node,
 * with no TypeScript build step to compile `env.ts` first.
 */
function isInteractiveTerminal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  if (process.env.TERM === 'dumb') return false;
  if (process.env.DEBIAN_FRONTEND === 'noninteractive') return false;
  const ciVars = [
    'CI', 'CONTINUOUS_INTEGRATION', 'BUILD_NUMBER', 'RUN_ID', 'GITHUB_ACTIONS',
    'GITLAB_CI', 'CIRCLECI', 'TRAVIS', 'BUILDKITE', 'JENKINS_URL', 'TF_BUILD', 'TEAMCITY_VERSION',
  ];
  if (ciVars.some((name) => {
    const value = process.env[name];
    return value && value !== '0' && value.toLowerCase() !== 'false';
  })) return false;
  return true;
}

/**
 * Strict `--on-conflict <choice>` parsing (#3062 review items 10/11): a
 * flag present without a usable value, or with a value outside 1-4, is a
 * usage error raised before any git command runs — never silently "not
 * given".
 */
function parseOnConflictArg(args) {
  // #3062 second review, finding 4: validate every occurrence (not just
  // the first found), stop at a bare `--` terminator, and accept
  // `--on-conflict=value` — mirrors `src/cli/flag-parsing.ts`'s
  // `scanFlagOccurrences()` semantics, duplicated here in plain JS for
  // the same reason as this file's own `isInteractiveTerminal()`: this
  // maintainer script runs directly via plain Node, with no TypeScript
  // build step. First occurrence wins (no pre-#3062 baseline to
  // preserve; matches this function's own prior `indexOf`-based
  // convention).
  let resolved;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--') break;

    let flag;
    let value;
    if (token.startsWith('--on-conflict=')) {
      flag = '--on-conflict';
      value = token.slice('--on-conflict='.length);
    } else if (token === '--on-conflict') {
      flag = token;
      value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--on-conflict requires a value (1-4)');
      }
      i += 1;
    } else {
      continue;
    }

    if (!['1', '2', '3', '4'].includes(value)) {
      throw new Error(`${flag} must be one of: 1, 2, 3, 4 (got '${value}')`);
    }
    if (resolved === undefined) resolved = value;
  }
  return resolved;
}

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

/**
 * Execute command with error handling
 * @param {string} file - Executable to run
 * @param {string[]} args - Command arguments
 * @param {Object} options - Execution options
 * @returns {Object} { success: boolean, stdout: string, stderr: string }
 */
function exec(file, args, options = {}) {
  try {
    const tier = options.tier ?? 'quick';
    const stdout = boundedExecFileSync(file, args, tier, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options
    });
    return { success: true, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    return {
      success: false,
      stdout: err.stdout?.toString() || '',
      stderr: err.stderr?.toString() || err.message
    };
  }
}

/**
 * Get current branch
 * @param {string} cwd - Working directory
 * @returns {Object} { success: boolean, branch: string|null, error: string|null }
 */
function getCurrentBranch(cwd) {
  const result = exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  if (!result.success) {
    return {
      success: false,
      branch: null,
      error: 'Failed to get current branch'
    };
  }
  return {
    success: true,
    branch: result.stdout,
    error: null
  };
}

/**
 * Fetch upstream changes
 * @param {string} cwd - Working directory
 * @returns {Object} { success: boolean, error: string|null }
 */
function fetchUpstream(cwd) {
  console.log('Fetching upstream changes...');
  // Network call (#3062 review item 6) — not the default 'quick' tier.
  const result = exec('git', ['fetch', 'upstream'], { cwd, tier: 'network' });
  if (!result.success) {
    return {
      success: false,
      error: `Failed to fetch upstream: ${result.stderr}`
    };
  }
  console.log(`${colors.green}✓${colors.reset} Fetched upstream changes`);
  return { success: true, error: null };
}

/**
 * Get divergence from upstream main
 * @param {string} cwd - Working directory
 * @returns {Object} { success: boolean, behind: number, ahead: number, conflicts: Array, error: string|null }
 */
function getDivergence(cwd) {
  // Get commits behind
  const behindResult = exec('git', ['rev-list', '--count', 'HEAD..upstream/main'], { cwd });
  if (!behindResult.success) {
    return {
      success: false,
      behind: 0,
      ahead: 0,
      conflicts: [],
      error: 'Failed to calculate commits behind'
    };
  }
  const behind = parseInt(behindResult.stdout) || 0;

  // Get commits ahead
  const aheadResult = exec('git', ['rev-list', '--count', 'upstream/main..HEAD'], { cwd });
  if (!aheadResult.success) {
    return {
      success: false,
      behind: 0,
      ahead: 0,
      conflicts: [],
      error: 'Failed to calculate commits ahead'
    };
  }
  const ahead = parseInt(aheadResult.stdout) || 0;

  // Check for potential conflicts
  const conflicts = [];
  if (behind > 0) {
    const diffResult = exec('git', ['diff', '--name-only', 'HEAD', 'upstream/main'], { cwd });
    if (diffResult.success) {
      const changedFiles = diffResult.stdout.split('\n').filter(f => f.trim());
      // Check if any of these files have local changes
      const statusResult = exec('git', ['diff', '--name-only', 'HEAD'], { cwd });
      if (statusResult.success) {
        const localChanges = statusResult.stdout.split('\n').filter(f => f.trim());
        const potentialConflicts = changedFiles.filter(f => localChanges.includes(f));
        conflicts.push(...potentialConflicts);
      }
    }
  }

  return {
    success: true,
    behind,
    ahead,
    conflicts,
    error: null
  };
}

/**
 * Show divergence summary
 * @param {Object} divergence - Divergence data
 */
function showDivergence(divergence) {
  console.log('');
  console.log('Upstream status:');
  console.log(`  ${colors.cyan}●${colors.reset} ${divergence.behind} commits behind upstream/main`);
  console.log(`  ${colors.cyan}●${colors.reset} ${divergence.ahead} commits ahead of upstream/main`);

  if (divergence.conflicts.length > 0) {
    console.log(`  ${colors.yellow}⚠${colors.reset} Potential conflicts in:`);
    divergence.conflicts.forEach(file => {
      console.log(`    - ${file}`);
    });
  }
  console.log('');
}

/**
 * Prompt user for sync strategy
 * @returns {Promise<string>} 'rebase'|'merge'|'cancel'
 */
async function promptSyncStrategy() {
  if (!isInteractiveTerminal()) {
    return 'cancel';
  }

  console.log('Sync strategy:');
  console.log('  [1] Rebase (recommended - creates linear history)');
  console.log('  [2] Merge (preserves exact history)');
  console.log('  [3] Cancel');
  console.log('');

  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('Choice [1-3]: ', (answer) => {
      rl.close();
      const choice = answer.trim();
      if (choice === '1') resolve('rebase');
      else if (choice === '2') resolve('merge');
      else resolve('cancel');
    });
  });
}

/**
 * Perform rebase
 * @param {string} cwd - Working directory
 * @returns {Object} { success: boolean, conflicts: boolean, error: string|null }
 */
function performRebase(cwd) {
  console.log('');
  console.log('Rebasing onto upstream/main...');

  const result = exec('git', ['rebase', 'upstream/main'], { cwd });

  if (!result.success) {
    // Check if it's a conflict
    const statusResult = exec('git', ['status'], { cwd });
    if (statusResult.stdout.includes('both modified') || statusResult.stdout.includes('rebase in progress')) {
      return {
        success: false,
        conflicts: true,
        error: 'Rebase conflicts detected'
      };
    }
    return {
      success: false,
      conflicts: false,
      error: `Rebase failed: ${result.stderr}`
    };
  }

  console.log(`${colors.green}✓${colors.reset} Rebase successful`);
  return { success: true, conflicts: false, error: null };
}

/**
 * Perform merge
 * @param {string} cwd - Working directory
 * @returns {Object} { success: boolean, conflicts: boolean, error: string|null }
 */
function performMerge(cwd) {
  console.log('');
  console.log('Merging upstream/main...');

  const result = exec('git', ['merge', 'upstream/main'], { cwd });

  if (!result.success) {
    // Check if it's a conflict
    const statusResult = exec('git', ['status'], { cwd });
    if (statusResult.stdout.includes('both modified') || statusResult.stdout.includes('Unmerged paths')) {
      return {
        success: false,
        conflicts: true,
        error: 'Merge conflicts detected'
      };
    }
    return {
      success: false,
      conflicts: false,
      error: `Merge failed: ${result.stderr}`
    };
  }

  console.log(`${colors.green}✓${colors.reset} Merge successful`);
  return { success: true, conflicts: false, error: null };
}

/**
 * Get conflicted files
 * @param {string} cwd - Working directory
 * @returns {Array<string>} List of conflicted files
 */
function getConflictedFiles(cwd) {
  const result = exec('git', ['diff', '--name-only', '--diff-filter=U'], { cwd });
  if (!result.success) {
    return [];
  }
  return result.stdout.split('\n').filter(f => f.trim());
}

/**
 * Show conflict resolution options
 * @param {Array<string>} conflicts - List of conflicted files
 * @param {string} strategy - 'rebase' or 'merge'
 */
function showConflictOptions(conflicts, strategy) {
  console.log('');
  console.log(`${colors.yellow}⚠ Conflicts detected${colors.reset}`);
  console.log('');
  console.log('Conflicted files:');
  conflicts.forEach(file => {
    console.log(`  - ${file}`);
  });
  console.log('');
  console.log('Resolution options:');
  console.log(`  1. Open in editor: $EDITOR ${conflicts[0]} (set EDITOR env var)`);
  console.log(`  2. Show conflict: git diff ${conflicts[0]}`);
  console.log(`  3. Abort ${strategy}: git ${strategy} --abort`);
  console.log('');
  console.log('After resolving conflicts:');
  if (strategy === 'rebase') {
    console.log('  git add <resolved-files>');
    console.log('  git rebase --continue');
  } else {
    console.log('  git add <resolved-files>');
    console.log('  git commit');
  }
  console.log('  aiwg -contribute-sync <feature>  (to complete sync)');
  console.log('');
}

/** Split EDITOR's executable and quoted arguments without invoking a shell. */
function editorArgs(editor) {
  const args = [];
  let value = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < editor.length; i++) {
    const char = editor[i];
    if (char === '\\' && quote !== "'" && i + 1 < editor.length &&
        /[\s\\"']/.test(editor[i + 1])) {
      value += editor[++i];
      started = true;
    } else if (quote && char === quote) {
      quote = '';
    } else if (!quote && (char === '"' || char === "'")) {
      quote = char;
      started = true;
    } else if (!quote && /\s/.test(char)) {
      if (started) args.push(value);
      value = '';
      started = false;
    } else {
      value += char;
      started = true;
    }
  }
  if (quote) throw new Error('Unclosed quote in EDITOR');
  if (started) args.push(value);
  if (!args[0]) throw new Error('EDITOR must name an executable');
  return args;
}

/**
 * Apply one numbered conflict-resolution choice (shared by the interactive
 * prompt and the headless `--on-conflict` path below). Choice `1` (open
 * $EDITOR) is interactive by nature regardless of how it was selected;
 * callers MUST NOT invoke it without a terminal attached.
 *
 * @param {string} choice - '1'|'2'|'3'|'4'
 * @param {Array<string>} conflicts - List of conflicted files
 * @param {string} strategy - 'rebase' or 'merge'
 * @param {string} cwd - Working directory
 */
function applyConflictChoice(choice, conflicts, strategy, cwd) {
  const firstFile = conflicts[0];

  if (choice === '1') {
    const editor = process.env.EDITOR || 'vi';
    console.log(`Opening ${firstFile} in ${editor}...`);
    try {
      const [file, ...args] = editorArgs(editor);
      // sync-spawn: interactive conflict-editor-launch — opens $EDITOR on
      // the conflicted file; the user interacts with it directly (see
      // tools/testing/sync-spawn-allowlist.json). Callers of this function
      // only reach choice '1' when a terminal is attached (#3062) — see
      // `handleConflicts` below. Not a candidate for a bounded timeout.
      execFileSync(file, [...args, firstFile], { stdio: 'inherit', cwd });
    } catch (err) {
      console.log(`${colors.red}✗${colors.reset} Failed to open editor`);
    }
  } else if (choice === '2') {
    const diffResult = exec('git', ['diff', '--', firstFile], { cwd });
    console.log(diffResult.stdout);
  } else if (choice === '3') {
    const abortArgs = [strategy === 'rebase' ? 'rebase' : 'merge', '--abort'];
    console.log(`Aborting ${strategy}...`);
    exec('git', abortArgs, { cwd });
    console.log(`${colors.green}✓${colors.reset} ${strategy} aborted`);
  }
  // choice === '4' (or anything else reaching here): no-op — resolve manually.
}

/**
 * Prompt for conflict handling, or apply `onConflictChoice` headlessly
 * when given (#3062 review item 10: the interactive "Choice [1-4]" prompt
 * previously had no argument at all).
 *
 * @param {Array<string>} conflicts - List of conflicted files
 * @param {string} strategy - 'rebase' or 'merge'
 * @param {string} cwd - Working directory
 * @param {string|undefined} onConflictChoice - `--on-conflict` value, if given
 * @returns {Promise<void>}
 */
async function handleConflicts(conflicts, strategy, cwd, onConflictChoice) {
  const interactive = isInteractiveTerminal();

  if (onConflictChoice !== undefined) {
    // Headless answer already given — never prompt, regardless of whether
    // a terminal happens to be attached (#3062 review item 12: "with a
    // terminal we can skip steps for any params provided"). Choice '1'
    // (open $EDITOR) is still interactive by nature: refuse it specifically
    // without a terminal instead of spawning an editor that would hang.
    if (onConflictChoice === '1' && !interactive) {
      console.error(
        `${colors.red}✗${colors.reset} --on-conflict 1 opens $EDITOR, which requires an interactive terminal.`,
      );
    } else {
      applyConflictChoice(onConflictChoice, conflicts, strategy, cwd);
    }
    showConflictOptions(conflicts, strategy);
    return;
  }

  if (!interactive) {
    showConflictOptions(conflicts, strategy);
    return;
  }

  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const firstFile = conflicts[0];

  console.log('');
  console.log(`${colors.yellow}Conflict in ${firstFile}${colors.reset}`);
  console.log('');
  console.log('Options:');
  console.log('  [1] Open in editor: $EDITOR (requires EDITOR env var)');
  console.log('  [2] Show conflict: git diff');
  console.log(`  [3] Abort ${strategy}`);
  console.log('  [4] Exit (resolve manually)');
  console.log('');

  return new Promise((resolve) => {
    rl.question('Choice [1-4]: ', (answer) => {
      rl.close();
      const choice = answer.trim();

      // Choice '1' here reaches `applyConflictChoice`'s editor launch (see
      // its own `sync-spawn: interactive conflict-editor-launch` marker)
      // only when a terminal is attached — the no-terminal path above
      // returns before this `rl.question` is ever set up (#3062).
      applyConflictChoice(choice, conflicts, strategy, cwd);

      showConflictOptions(conflicts, strategy);
      resolve();
    });
  });
}

/**
 * Push changes to origin
 * @param {string} cwd - Working directory
 * @param {boolean} force - Force push (for rebase)
 * @returns {Object} { success: boolean, error: string|null }
 */
function pushToOrigin(cwd, force = false) {
  console.log('');
  console.log('Pushing changes to origin...');

  const forceArgs = force ? ['--force-with-lease'] : [];
  // Network call (#3062 review item 6) — not the default 'quick' tier.
  const result = exec('git', ['push', 'origin', 'HEAD', ...forceArgs], { cwd, tier: 'network' });

  if (!result.success) {
    return {
      success: false,
      error: `Failed to push: ${result.stderr}`
    };
  }

  console.log(`${colors.green}✓${colors.reset} Pushed changes to origin`);
  return { success: true, error: null };
}

/**
 * Check if in clean state (no rebase/merge in progress)
 * @param {string} cwd - Working directory
 * @returns {Object} { clean: boolean, inProgress: string|null }
 */
function checkCleanState(cwd) {
  const gitDir = path.join(cwd, '.git');

  // Check for rebase in progress
  if (fs.existsSync(path.join(gitDir, 'rebase-merge')) ||
      fs.existsSync(path.join(gitDir, 'rebase-apply'))) {
    return { clean: false, inProgress: 'rebase' };
  }

  // Check for merge in progress
  if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
    return { clean: false, inProgress: 'merge' };
  }

  return { clean: true, inProgress: null };
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log('Usage: aiwg -contribute-sync <feature-name> [--on-conflict 1-4]');
    console.log('');
    console.log('Sync fork with upstream changes using rebase or merge strategy.');
    console.log('');
    console.log('Options:');
    console.log('  --on-conflict 1-4  Answer the conflict-resolution prompt headlessly:');
    console.log('                     1=open $EDITOR (requires a terminal), 2=show diff,');
    console.log('                     3=abort, 4=exit (resolve manually).');
    console.log('');
    console.log('Without an interactive terminal and without --on-conflict, a conflict');
    console.log('prints its resolution options and stops before changing anything.');
    console.log('');
    console.log('Example:');
    console.log('  aiwg -contribute-sync cursor-integration');
    process.exit(0);
  }

  const feature = args[0];
  const cwd = process.cwd();

  // #3062 review item 10: `--on-conflict <choice>` answers the interactive
  // "Choice [1-4]" conflict-resolution prompt directly. Parsed before any
  // git command runs, so a bad/missing value never gets past this point.
  let onConflictChoice;
  try {
    onConflictChoice = parseOnConflictArg(args);
  } catch (err) {
    console.error(`${colors.red}✗${colors.reset} ${err.message}`);
    process.exit(2);
  }

  console.log('Syncing with upstream...');
  console.log('Feature:', feature);
  console.log('');

  // Check if workspace exists
  if (!workspaceExists(feature, cwd)) {
    console.error(`${colors.red}✗${colors.reset} Workspace not found: ${feature}`);
    console.error('');
    console.error('Run: aiwg -contribute-start ' + feature);
    process.exit(1);
  }

  // Load workspace data
  const workspaceData = loadWorkspaceData(feature, 'status.json', cwd);
  if (!workspaceData.success) {
    console.error(`${colors.red}✗${colors.reset} Failed to load workspace: ${workspaceData.error}`);
    process.exit(1);
  }

  const expectedBranch = workspaceData.data.branch;

  // Check current branch
  const branchResult = getCurrentBranch(cwd);
  if (!branchResult.success) {
    console.error(`${colors.red}✗${colors.reset} Failed to get current branch`);
    process.exit(1);
  }

  if (branchResult.branch !== expectedBranch) {
    console.error(`${colors.red}✗${colors.reset} Wrong branch: ${branchResult.branch}`);
    console.error(`Expected: ${expectedBranch}`);
    console.error('');
    console.error('Run: git checkout ' + expectedBranch);
    process.exit(1);
  }

  console.log(`${colors.green}✓${colors.reset} On correct branch: ${expectedBranch}`);

  // Check if already in rebase/merge
  const stateCheck = checkCleanState(cwd);
  if (!stateCheck.clean) {
    console.log('');
    console.log(`${colors.yellow}⚠ ${stateCheck.inProgress} in progress${colors.reset}`);

    // Get conflicted files
    const conflicts = getConflictedFiles(cwd);
    if (conflicts.length > 0) {
      await handleConflicts(conflicts, stateCheck.inProgress, cwd, onConflictChoice);
      process.exit(1);
    } else {
      console.log('');
      console.log('Complete the ' + stateCheck.inProgress + ' with:');
      if (stateCheck.inProgress === 'rebase') {
        console.log('  git rebase --continue');
      } else {
        console.log('  git commit');
      }
      console.log('');
      console.log('Then re-run: aiwg -contribute-sync ' + feature);
      process.exit(1);
    }
  }

  // Fetch upstream
  const fetchResult = fetchUpstream(cwd);
  if (!fetchResult.success) {
    console.error(`${colors.red}✗${colors.reset} ${fetchResult.error}`);
    process.exit(1);
  }

  // Get divergence
  const divergence = getDivergence(cwd);
  if (!divergence.success) {
    console.error(`${colors.red}✗${colors.reset} ${divergence.error}`);
    process.exit(1);
  }

  // Show divergence
  showDivergence(divergence);

  // Check if already up to date
  if (divergence.behind === 0) {
    console.log(`${colors.green}✓${colors.reset} Already up to date with upstream/main`);
    process.exit(0);
  }

  // Prompt for strategy
  const strategy = await promptSyncStrategy();

  if (strategy === 'cancel') {
    console.log('');
    console.log('Sync cancelled.');
    process.exit(0);
  }

  // Execute strategy
  let syncResult;
  if (strategy === 'rebase') {
    syncResult = performRebase(cwd);
  } else {
    syncResult = performMerge(cwd);
  }

  if (!syncResult.success) {
    if (syncResult.conflicts) {
      const conflicts = getConflictedFiles(cwd);
      await handleConflicts(conflicts, strategy, cwd, onConflictChoice);
      process.exit(1);
    } else {
      console.error(`${colors.red}✗${colors.reset} ${syncResult.error}`);
      process.exit(1);
    }
  }

  // Push to origin
  const pushResult = pushToOrigin(cwd, strategy === 'rebase');
  if (!pushResult.success) {
    console.error(`${colors.red}✗${colors.reset} ${pushResult.error}`);
    console.error('');
    console.error('Push manually with:');
    if (strategy === 'rebase') {
      console.error('  git push origin HEAD --force-with-lease');
    } else {
      console.error('  git push origin HEAD');
    }
    process.exit(1);
  }

  // Update workspace status
  updateWorkspaceStatus(feature, workspaceData.data.status, {
    lastSync: new Date().toISOString(),
    syncStrategy: strategy
  }, cwd);

  // Print success
  console.log('');
  console.log('='.repeat(60));
  console.log(`${colors.green}✅ Sync complete!${colors.reset}`);
  console.log('='.repeat(60));
  console.log('');
  console.log('Next steps:');
  console.log('  - Continue development');
  console.log('  - Run tests: aiwg -contribute-test ' + feature);
  console.log('  - Check status: aiwg -contribute-status ' + feature);
  console.log('');

  process.exit(0);
}

// Run main function
if (isMain(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}

export { applyConflictChoice, pushToOrigin };
