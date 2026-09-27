import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import {
  decisionCapabilities,
  evaluateRequestPath,
  listPatterns,
  livePlan,
  materializeSyntheticClassificationSetup,
  runOfflinePattern,
  showPattern,
  syntheticClassificationSetup,
  validateDecisionInput,
} from '../../decision/driver.js';
import type { DecisionPatternId } from '../../decision/index.js';

function jsonResult(value: unknown, exitCode = 0): HandlerResult {
  return { exitCode, message: JSON.stringify(value, null, 2), rawOutput: true };
}

function usage(): string {
  return [
    'Usage: aiwg decision <capabilities|status|patterns|validate|evaluate|setup> [options]',
    '',
    'Commands:',
    '  capabilities|status                 Show offline readiness, primitives, config and feature availability',
    '  patterns list                       List governed decision pattern packs',
    '  patterns show <id>                  Show one pattern pack and schemas',
    '  patterns offline-run <id> [fixture] Run a recorded offline fixture through the decision runtime',
    '  patterns live-plan <id> [--opt-in] [--credential-resolved] [--egress-approved]',
    '  validate <request|definition|ruleset|binding> <path>',
    '  evaluate --request <path>           Evaluate only when AIWG_DECISION_ENABLED=1',
    '  setup synthetic-classification [--output-dir <dir>]',
  ].join('\n');
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function patternId(value: string | undefined): DecisionPatternId {
  if (!value) throw new Error('Pattern id is required');
  return value as DecisionPatternId;
}

async function executeDecision(ctx: HandlerContext): Promise<HandlerResult> {
  const [command, subcommand, ...rest] = ctx.args;
  const options = { cwd: ctx.cwd, frameworkRoot: ctx.frameworkRoot, env: process.env };
  try {
    if (!command || command === '--help' || command === '-h') return { exitCode: 0, message: usage(), rawOutput: true };
    if (command === 'capabilities' || command === 'status') return jsonResult(decisionCapabilities(options));
    if (command === 'patterns') {
      if (subcommand === 'list') return jsonResult(listPatterns());
      if (subcommand === 'show') return jsonResult(showPattern(patternId(rest[0])));
      if (subcommand === 'offline-run') return jsonResult(await runOfflinePattern(patternId(rest[0]), rest[1]));
      if (subcommand === 'live-plan') return jsonResult(livePlan(patternId(rest[0]), {
        explicitOptIn: rest.includes('--opt-in'),
        credentialResolved: rest.includes('--credential-resolved'),
        egressApproved: rest.includes('--egress-approved'),
      }));
    }
    if (command === 'validate') {
      const target = subcommand as 'request' | 'definition' | 'ruleset' | 'binding';
      const result = await validateDecisionInput(target, rest[0] ?? '', options);
      return jsonResult(result, result.valid ? 0 : 2);
    }
    if (command === 'evaluate') {
      const request = takeOption(ctx.args, '--request');
      if (!request) return { exitCode: 2, message: 'decision evaluate requires --request <path>' };
      const result = await evaluateRequestPath(request, options);
      return jsonResult(result, result.exitCode);
    }
    if (command === 'setup' && subcommand === 'synthetic-classification') {
      const outputDir = takeOption(ctx.args, '--output-dir');
      if (outputDir) return jsonResult(await materializeSyntheticClassificationSetup(outputDir, {}, options));
      return jsonResult(syntheticClassificationSetup({}, options));
    }
    return { exitCode: 2, message: usage(), rawOutput: true };
  } catch (error) {
    return { exitCode: 1, message: error instanceof Error ? error.message : String(error) };
  }
}

export const decisionHandler: CommandHandler = {
  id: 'decision',
  name: 'Decision Driver',
  description: 'Inspect, validate and run governed decision classification workflows',
  category: 'utility',
  aliases: [],
  help: async () => ({ exitCode: 0, message: usage(), rawOutput: true }),
  execute: executeDecision,
};
