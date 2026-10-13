/**
 * Init Command Handler
 *
 * Implements `aiwg init` — the first-run wizard that creates
 * `.aiwg/aiwg.config` for the current project.
 *
 * Prompts:
 *   1. Which AI provider toolchains does this project target?
 *   2. Would you like to add any scripts? (optional)
 *
 * Runs automatically on first `aiwg use` when no config exists.
 * Can also be run explicitly to reconfigure.
 *
 * @implements #621
 */

import readline from 'readline';
import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import {
  readAiwgConfig,
  writeAiwgConfig,
  emptyConfig,
  populateDeployedTo,
  VALID_PROVIDERS,
  getConfigPath,
} from '../../config/aiwg-config.js';
import * as ui from '../ui.js';
import { askString as sharedAskString, askYesNo as sharedAskYesNo, askConsent } from '../prompt-utils.js';
import { normalizeProviderDefinitionId } from '../../providers/provider-definitions.js';
import { writeNormalizedAiwgMd } from '../../smiths/context-pipeline/finalization.js';
import { ensureWorkspaceContext } from '../../smiths/context-pipeline/workspace-context.js';
import {
  detectInstalledWorkerClis,
  evaluateWorkerDispatchOffer,
  workerDispatchOfferQuestion,
  workerDispatchOfferHint,
} from '../../models/worker-dispatch-offer.js';
import type { ParallelismConfig, SetupConfig } from '../../config/aiwg-config.js';

const PROVIDER_LABELS: Record<string, string> = {
  antigravity: 'Google Antigravity .agents/',
  claude:    'Claude Code       .claude/',
  copilot:   'GitHub Copilot    .github/',
  cursor:    'Cursor            .cursor/',
  opencode:  'OpenCode          .opencode/',
  warp:      'Warp Terminal     .warp/',
  windsurf:  'Windsurf          AGENTS.md',
  factory:   'Factory AI        .factory/',
  codex:     'OpenAI Codex      ~/.codex/',
  openclaw:  'OpenClaw          ~/.openclaw/',
  hermes:    'Hermes (MCP)      aiwg mcp',
  omp:       'Oh My Pi         .omp/ + .agents/skills/',
  pi:        'Pi Coding Agent   .pi/ + .agents/skills/',
};

// Local aliases for the shared prompt utilities. These preserve existing
// call sites (askYesNo/askString) while routing through a single timeout
// and unref-discipline implementation in `src/cli/prompt-utils.ts`.
// Phase 3 (#920) will replace these with @clack/prompts.

const askYesNo = sharedAskYesNo;
const askString = sharedAskString;

/**
 * Prompt for a comma-separated provider selection
 */
async function askProviders(rl: readline.Interface, signal?: AbortSignal): Promise<string[]> {
  const list = VALID_PROVIDERS.map((p, i) => `  ${i + 1}. ${PROVIDER_LABELS[p] ?? p}`).join('\n');
  console.log('');
  console.log('  Available providers:');
  console.log(list);
  console.log('');

  // Multi-select (comma-separated) — stays hand-rolled rather than adopting
  // listSelect because #926's POC targets single-select only. `signal`
  // threading is the full migration from the spike.
  const answer = await askString(
    rl,
    '  Enter provider numbers (comma-separated) or names [1]: ',
    '',
    signal,
  );

  if (!answer) return ['claude']; // default

  const parts = answer.split(',').map(s => s.trim()).filter(Boolean);
  const selected: string[] = [];

  for (const part of parts) {
    const num = parseInt(part, 10);
    if (!isNaN(num) && num >= 1 && num <= VALID_PROVIDERS.length) {
      selected.push(VALID_PROVIDERS[num - 1]);
      continue;
    }
    // Accept canonical ids and registered aliases (e.g. `dsh` for
    // `deepseek-harness`) so the picker honours the same names as `--provider`.
    const canonical = normalizeProviderDefinitionId(part);
    if (canonical && VALID_PROVIDERS.includes(canonical as typeof VALID_PROVIDERS[number])) {
      selected.push(canonical);
    } else {
      ui.warn(`  Unknown provider '${part}' — skipped`);
    }
  }

  return selected.length > 0 ? selected : ['claude'];
}

/**
 * Non-interactive / --yes / no-TTY runs never prompt and never touch the
 * config (#3050 item 2) — they only print one line naming the enable
 * command, when two or more worker CLIs are detected and dispatch is not
 * already on or declined.
 */
function renderWorkerDispatchHintIfApplicable(parallelism: ParallelismConfig | undefined, setup: SetupConfig | undefined): void {
  const offer = evaluateWorkerDispatchOffer(parallelism, setup, detectInstalledWorkerClis());
  if (offer.shouldOffer) ui.dim(`  ${workerDispatchOfferHint(offer.detected)}`);
}

/** A decision from the worker-dispatch consent prompt, keyed to where it is recorded. */
type WorkerDispatchDecision = { kind: 'enable' } | { kind: 'decline' };

/**
 * Interactive-only: asks the one consent question (default/unanswered is
 * no, strict `y`/`yes` parsing only) when two or more worker CLIs are
 * detected and dispatch is not already on or declined. Returns the
 * decision to apply, or `undefined` when there is nothing to offer, or
 * when the prompt timed out / stdin closed without an answer — only an
 * actually-answered "no" is recorded as a persistent decline (#3050
 * review item 4).
 */
async function askWorkerDispatchOffer(
  rl: readline.Interface,
  parallelism: ParallelismConfig | undefined,
  setup: SetupConfig | undefined,
  signal?: AbortSignal,
): Promise<WorkerDispatchDecision | undefined> {
  const offer = evaluateWorkerDispatchOffer(parallelism, setup, detectInstalledWorkerClis());
  if (!offer.shouldOffer) return undefined;
  console.log('');
  const outcome = await askConsent(rl, workerDispatchOfferQuestion(offer.detected), undefined, signal);
  if (outcome.kind !== 'answered') return undefined;
  if (outcome.value) {
    ui.success('  Will enable parallelism.worker_dispatch.');
    return { kind: 'enable' };
  }
  ui.dim('  Noted — enable later with `aiwg config set --project parallelism.worker_dispatch true`.');
  return { kind: 'decline' };
}

export const initHandler: CommandHandler = {
  id: 'init',
  name: 'Init',
  description: 'Initialise the baseline .aiwg/aiwg.config for an agent-led project setup',
  category: 'project',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const force = ctx.args.includes('--force');
    // Treat a missing stdin TTY as non-interactive so piped/backgrounded
    // invocations never attempt to create a readline interface. This is a
    // single authoritative check — downstream code MUST NOT re-derive
    // interactive-ness from process.stdin.isTTY again.
    const nonInteractive =
      ctx.args.includes('--non-interactive') ||
      ctx.args.includes('--yes') ||
      !process.stdin.isTTY ||
      !process.stdout.isTTY ||
      process.env['CI'] === 'true';
    const projectDir = ctx.cwd;

    ui.blank();
    console.log(`  ${ui.brandMark()} ${ui.bold('AIWG Baseline Config')}`);
    ui.rule();

    // Check for existing config
    const existing = await readAiwgConfig(projectDir);
    if (existing && !force) {
      ui.info(`Config already exists: ${getConfigPath(projectDir)}`);
      await writeNormalizedAiwgMd(projectDir);
      console.log(`  Providers: ${existing.providers.join(', ')}`);
      const scriptCount = Object.keys(existing.scripts).length;
      if (scriptCount > 0) {
        console.log(`  Scripts: ${Object.keys(existing.scripts).join(', ')}`);
      }
      ui.blank();
      ui.dim('  Ask your AIWG agent to review repo, tracker, delivery, signing, and provider policy.');
      ui.dim('  Agents may use `aiwg setup project --dry-run` as the CLI helper for that review.');
      ui.dim('  Run `aiwg init --force` only when you need to recreate the baseline config.');
      // #3050: guide users to direct worker dispatch from the setup step they
      // already run, instead of leaving it undiscoverable. `--dry-run` must
      // never prompt and never write (review item 1) — it degrades to the
      // same hint-only behavior as non-interactive runs.
      if (nonInteractive || ctx.dryRun) {
        renderWorkerDispatchHintIfApplicable(existing.parallelism, existing.setup);
      } else {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
          const decision = await askWorkerDispatchOffer(rl, existing.parallelism, existing.setup, ctx.signal);
          if (decision?.kind === 'enable') {
            await writeAiwgConfig(projectDir, { ...existing, parallelism: { ...existing.parallelism, worker_dispatch: true } });
          } else if (decision?.kind === 'decline') {
            await writeAiwgConfig(projectDir, { ...existing, setup: { ...existing.setup, worker_dispatch_offer: 'declined' } });
          }
        } finally {
          rl.close();
        }
      }
      ui.blank();
      return { exitCode: 0 };
    }

    let providers: string[];
    let scripts: Record<string, string> = {};
    let workerDispatchDecision: WorkerDispatchDecision | undefined;

    if (nonInteractive) {
      // Non-interactive: use defaults
      providers = ['claude'];
      scripts = {
        deploy: 'aiwg use all',
        doctor: 'aiwg doctor',
        sync: 'aiwg sync',
      };
      renderWorkerDispatchHintIfApplicable(undefined, undefined);
    } else {
      // Interactive wizard
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        // Thread ctx.signal through every prompt so Ctrl-C during the wizard
        // cancels cleanly instead of being absorbed by readline (POC #926).
        providers = await askProviders(rl, ctx.signal);

        console.log('');
        const addScripts = await askYesNo(rl, '  Add default scripts (deploy, doctor, sync)? [Y/n]: ', true, ctx.signal);
        if (addScripts) {
          scripts = {
            deploy: 'aiwg use all',
            doctor: 'aiwg doctor',
            sync: 'aiwg sync',
          };

          const addCustom = await askYesNo(rl, '  Add a custom script? [y/N]: ', false, ctx.signal);
          if (addCustom) {
            const name = await askString(rl, '  Script name: ', '', ctx.signal);
            const cmd = await askString(rl, '  Command: ', '', ctx.signal);
            if (name && cmd) {
              scripts[name] = cmd;
            }
          }
        }

        // #3050: offer direct worker dispatch inside the same wizard — but
        // `--dry-run` must never prompt or write anything from the offer
        // (review item 1), so it degrades to the hint instead.
        if (ctx.dryRun) {
          renderWorkerDispatchHintIfApplicable(undefined, undefined);
        } else {
          workerDispatchDecision = await askWorkerDispatchOffer(rl, undefined, undefined, ctx.signal);
        }
      } finally {
        rl.close();
      }
    }

    // Build config
    let config = emptyConfig(providers);
    config.scripts = scripts;
    if (workerDispatchDecision?.kind === 'enable') {
      config.parallelism = { ...config.parallelism, worker_dispatch: true };
    } else if (workerDispatchDecision?.kind === 'decline') {
      config.setup = { ...config.setup, worker_dispatch_offer: 'declined' };
    }

    // Populate deployedTo from disk for entries with empty deployedTo (#721)
    config = await populateDeployedTo(config, projectDir);

    // Write
    await writeAiwgConfig(projectDir, config);
    const normalizedAiwgMdPath = await writeNormalizedAiwgMd(projectDir);
    const workspace = await ensureWorkspaceContext(projectDir);

    ui.blank();
    ui.success(`Created ${getConfigPath(projectDir)}`);
    ui.success(`Created ${normalizedAiwgMdPath}`);
    ui.success(`${workspace.action === 'created' ? 'Created' : 'Preserved'} WORKSPACE.md`);
    ui.success(`Providers: ${providers.join(', ')}`);
    if (Object.keys(scripts).length > 0) {
      ui.success(`Scripts: ${Object.keys(scripts).join(', ')}`);
    }
    ui.blank();
    console.log('  Next steps:');
    console.log('    Ask your AIWG agent: "Help me set up this project for AIWG."');
    console.log('    The agent may use `aiwg setup project --dry-run` to preview policy choices.');
    console.log('    aiwg use sdlc                 Deploy SDLC framework to configured providers');
    console.log('    aiwg run                      List all defined scripts');
    ui.blank();

    return { exitCode: 0 };
  },
};
