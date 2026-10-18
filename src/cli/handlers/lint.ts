/**
 * Lint Command Handler
 *
 * Routes `aiwg lint` to the lint CLI module.
 *
 * @issue #810
 */

import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { handlerResultFromError } from '../errors.js';

/**
 * Handler for lint command
 *
 * Lint AIWG-managed document sets against declarative rule sets.
 *
 * Usage:
 *   aiwg lint .aiwg/research/
 *   aiwg lint .aiwg/research/ --ruleset research
 *   aiwg lint --list-rulesets
 *   aiwg lint --list-rules research
 *   aiwg lint .aiwg/ --format json --ci --fail-on warn
 *   aiwg lint .aiwg/research/ --dry-run
 */
export const lintHandler: CommandHandler = {
  id: 'lint',
  name: 'Lint',
  description: 'Lint AIWG artifacts against declarative rule sets',
  category: 'utility',
  aliases: ['-lint', '--lint'],

  async help(): Promise<HandlerResult> {
    const { main } = await import('../../lint/cli.js');
    await main(['--help']);
    return { exitCode: 0 };
  },

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const { main } = await import('../../lint/cli.js');
      await main(ctx.args);

      return {
        exitCode: Number(process.exitCode) || 0,
      };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `Lint command failed: ${result.message}` };
    }
  },
};
