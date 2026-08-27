/**
 * DeepSeek Harness (DSH) CLI Provider Adapter for External Ralph Loop
 *
 * Headless profile invocation: `dsh --profile <AGENTIC_DSH_PROFILE|headless>
 * "<prompt>"` — one nonblank task, fresh session, final assistant text on
 * stdout, exit (see deepseek-harness examples/headless-agent).
 *
 * Credentials: OPENROUTER_API_KEY from the environment, or materialized from
 * the standard credential lease (AGENTIC_CREDENTIAL_DIR/openrouter_api_key) —
 * mirroring agentic-dsh-automation. Model routing is provider-routed inside
 * DSH (e.g. z-ai/glm-5.3-flash via the worker DSH_HOME settings).
 *
 * @implements Plan: Multi-Provider Support for External Ralph Loop (issue #5)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { ProviderAdapter, registerProvider } from './provider-adapter.mjs';

const DEFAULT_CREDENTIAL_DIR = '/run/agentic-sandbox/credentials';

export class DshAdapter extends ProviderAdapter {
  /** @returns {string} */
  getBinary() {
    return 'dsh';
  }

  /** @returns {string} */
  getName() {
    return 'dsh';
  }

  /**
   * Honest capability surface for the dsh headless one-shot.
   * @returns {import('./provider-adapter.mjs').ProviderCapabilities}
   */
  getCapabilities() {
    return {
      streamJson: false,   // final assistant text on stdout
      sessionResume: true, // --resume <session-id> passthrough
      budgetControl: false,// provider does not report usage/cost mid-flight
      systemPrompt: false,
      agentMode: false,
      mcpConfig: false,
      maxTurns: false,
    };
  }

  /**
   * Build args for the main headless session.
   *
   * @param {import('./provider-adapter.mjs').SessionArgs} options
   * @returns {string[]}
   */
  buildSessionArgs(options) {
    const profile = process.env.AGENTIC_DSH_PROFILE || 'headless';
    const args = ['--profile', profile];

    // Session resume passthrough (provider-native)
    if (options.sessionId) {
      args.push('--resume', options.sessionId);
    }

    // Model selection (provider-routed slug, e.g. z-ai/glm-5.3-flash)
    if (options.model) {
      args.push('--model', options.model);
    }

    // The prompt itself (must be last)
    args.push(options.prompt);

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
   * Provider-routed slugs pass through directly.
   * @param {string} genericModel
   * @returns {string}
   */
  mapModel(genericModel) {
    return genericModel;
  }

  /**
   * Environment for headless dsh sessions: lease→env credential
   * materialization plus worker home passthrough.
   * @returns {Object<string, string>}
   */
  getEnvOverrides() {
    const overrides = { CI: 'true' };
    if (!process.env.OPENROUTER_API_KEY) {
      try {
        const dir = process.env.AGENTIC_CREDENTIAL_DIR || DEFAULT_CREDENTIAL_DIR;
        const value = readFileSync(join(dir, 'openrouter_api_key'), 'utf8').trim();
        if (value) overrides.OPENROUTER_API_KEY = value;
      } catch {
        // Fail closed at request time with a provider auth error.
      }
    }
    if (process.env.DSH_HOME) overrides.DSH_HOME = process.env.DSH_HOME;
    if (process.env.AGENTIC_DSH_PROFILE) {
      overrides.AGENTIC_DSH_PROFILE = process.env.AGENTIC_DSH_PROFILE;
    }
    return overrides;
  }

  /**
   * DSH sessions persist inside DSH_HOME (invariant I3: no host transcript
   * crossing). Returns null so callers skip host transcript collection.
   * @returns {null}
   */
  getTranscriptPath() {
    return null;
  }
}

// Self-register on import
registerProvider('dsh', () => new DshAdapter());

export default DshAdapter;
