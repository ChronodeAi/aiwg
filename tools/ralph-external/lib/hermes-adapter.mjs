/**
 * Hermes CLI Provider Adapter for External Ralph Loop
 *
 * Headless one-shot invocation: `hermes "<prompt>"` — one nonblank task,
 * fresh session per invocation, final assistant text on stdout. Modeled on
 * dsh-adapter.mjs per ADR-006 (dsh is the ratified template; this adapter
 * copies its structure and its honest-capability discipline).
 *
 * Credentials: NONE are materialized here — deliberately NOT the dsh lease
 * block. OPENROUTER_API_KEY lives in $HERMES_HOME/.env (never the process
 * environment) and is read by hermes itself; copying it into the spawn env
 * would be redundant at best and a process-environment leak vector at worst
 * (ADR-006, operator-verified). Model routing is owned by $HERMES_HOME
 * settings.
 *
 * @implements @.aiwg/architecture/ADR-006-hermes-provider-adapter.md
 */

import { ProviderAdapter, registerProvider } from './provider-adapter.mjs';

export class HermesAdapter extends ProviderAdapter {
  /** @returns {string} */
  getBinary() {
    // HERMES_BIN override for detached spawns whose PATH excludes the shim
    // location. Falls back to plain `hermes` (DSH_BIN pattern, ADR-006).
    return process.env.HERMES_BIN || 'hermes';
  }

  /** @returns {string} */
  getName() {
    return 'hermes';
  }

  /**
   * CAPABILITY-OPEN-QUESTIONS (ADR-006 — resolved only by observation, never
   * by guess; a flag flips to true only when the smoke test demonstrates the
   * corresponding observed behavior, and the comment must then cite the test
   * that proved it):
   *
   *   H-1: RESOLVED by observation (2026-08-30 E2E): hermes headless is
   *        `hermes -z "<prompt>"` — the prompt is a flag value, NOT a
   *        positional (argparse consumes a leading positional as the command).
   *   H-2: Does hermes accept a per-invocation model flag, or is model
   *        routing owned entirely by $HERMES_HOME config?
   *   H-3: Where hermes persists transcripts/sessions (blocks
   *        getTranscriptPath; invariant I3 — no host transcript crossing).
   *   H-4: Does hermes report token usage/cost per invocation (blocks any
   *        budgetControl: true flip; ADR-003 interlock)?
   *   H-5: Does hermes support session resumption across invocations
   *        (blocks sessionResume)?
   *   H-6: What is hermes' final-output contract on stdout (delimiters,
   *        exit codes on failure) for output-analyzer compatibility?
   *
   * @returns {import('./provider-adapter.mjs').ProviderCapabilities}
   */
  getCapabilities() {
    return {
      streamJson: false,   // H-1/H-6: unobserved — final assistant text on stdout
      sessionResume: false,// H-5: unobserved — one fresh session per invocation
      budgetControl: false,// H-4: unobserved — no mid-flight usage/cost reporting
      systemPrompt: false, // unobserved (H-1 family)
      agentMode: false,    // unobserved
      mcpConfig: false,    // unobserved
      maxTurns: false,     // unobserved
    };
  }

  /**
   * Build args for the main headless session: the minimal headless
   * invocation — the prompt as the final argument, nothing else.
   *
   * NOTE: no --resume and no --model and no budget/system-prompt flags.
   * None of these are observed on the hermes CLI surface (H-1/H-2/H-4/H-5);
   * model routing is owned by $HERMES_HOME settings, and each headless
   * invocation creates a fresh session by design. Session identity: the
   * sessionId carried in SessionArgs remains ralph-external bookkeeping
   * only and is never forwarded as a provider flag.
   *
   * @param {import('./provider-adapter.mjs').SessionArgs} options
   * @returns {string[]}
   */
  buildSessionArgs(options) {
    const args = [];

    // H-1 RESOLVED by observation (2026-08-30 E2E): hermes headless is
    // `hermes -z "<prompt>"`. The prompt is NOT a positional — argparse
    // consumes the first positional as the command name ('invalid choice'
    // error observed when the prompt led the argv).
    args.push('-z', options.prompt);

    return args;
  }

  /**
   * Short analysis calls use the same headless one-shot.
   *
   * @param {import('./provider-adapter.mjs').AnalysisArgs} options
   * @returns {string[]}
   */
  buildAnalysisArgs(options) {
    return this.buildSessionArgs(options);
  }

  /**
   * Provider-routed slugs pass through directly (H-2: model routing is
   * owned by the hermes side).
   * @param {string} genericModel
   * @returns {string}
   */
  mapModel(genericModel) {
    return genericModel;
  }

  /**
   * Environment for headless hermes sessions: HERMES_HOME passthrough ONLY.
   * No credential materialization — OPENROUTER_API_KEY stays in
   * $HERMES_HOME/.env and must never enter the spawn environment (ADR-006;
   * this is the one place the dsh template is deliberately not followed).
   * @returns {Object<string, string>}
   */
  getEnvOverrides() {
    const overrides = {};
    if (process.env.HERMES_HOME) overrides.HERMES_HOME = process.env.HERMES_HOME;
    return overrides;
  }

  /**
   * Where hermes persists transcripts is unobserved (H-3; invariant I3: no
   * host transcript crossing). Returns null so callers skip host transcript
   * collection.
   * @returns {null}
   */
  getTranscriptPath() {
    return null;
  }
}

// Self-register on import
registerProvider('hermes', () => new HermesAdapter());

export default HermesAdapter;
