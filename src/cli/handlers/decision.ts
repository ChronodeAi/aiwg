import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import {
  askDecision,
  DecisionAskUsageError,
  decisionCapabilities,
  evaluateRequestPath,
  listPatterns,
  livePlan,
  materializeSyntheticClassificationSetup,
  readDecisionContextFile,
  runOfflinePattern,
  setupJev,
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
    '       aiwg decision ask --question "<q>" (--yes-no | --choices a,b,c | --scale 1-5) [--context <text> | --context-file <path> | --context-stdin] [--threshold 0.8] [--timeout-ms 15000] [--json]',
    '',
    'Commands:',
    '  capabilities|status                 Show offline readiness, primitives, config and feature availability',
    '  patterns list                       List governed decision pattern packs',
    '  patterns show <id>                  Show one pattern pack and schemas',
    '  patterns offline-run <id> [fixture] Run a recorded offline fixture through the decision runtime',
    '  patterns live-plan <id> [--opt-in] [--credential-resolved] [--egress-approved]',
    '  validate <request|definition|ruleset|binding> <path>',
    '  evaluate --request <path> [--host-policy-module <path>]',
    '  setup synthetic-classification [--output-dir <dir>]',
    '  setup jev [--token-stdin] [--region <r>] [--endpoint <url>] [--verify] [--remove]',
    '  ask --question "<q>" (--yes-no | --choices a,b,c | --scale 1-5)',
  ].join('\n');
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function takeRequiredOption(args: string[], name: string): string {
  const value = takeOption(args, name);
  if (!value || value.startsWith('--')) throw new DecisionAskUsageError(`missing-${name.slice(2)}`, `${name} requires a value`);
  return value;
}

function patternId(value: string | undefined): DecisionPatternId {
  if (!value) throw new Error('Pattern id is required');
  return value as DecisionPatternId;
}

function flagCount(args: string[], names: string[]): number {
  return args.filter(arg => names.includes(arg)).length;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

function parseNumber(value: string | undefined, name: string): number {
  if (value === undefined) throw new DecisionAskUsageError(`missing-${name.slice(2)}`, `${name} requires a value`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new DecisionAskUsageError(`invalid-${name.slice(2)}`, `${name} must be numeric`);
  return parsed;
}

function parseScale(value: string | undefined): { low: number; high: number } {
  if (!value) throw new DecisionAskUsageError('invalid-scale', '--scale requires a range like 1-5');
  const match = /^(-?\d+)-(-?\d+)$/.exec(value);
  if (!match) throw new DecisionAskUsageError('invalid-scale', '--scale requires a range like 1-5');
  return { low: Number(match[1]), high: Number(match[2]) };
}

async function decisionSetupJev(rest: string[]): Promise<HandlerResult> {
  const token = rest.includes('--token-stdin') ? (await readStdin()).trim() : undefined;
  const result = await setupJev({
    token,
    region: takeOption(rest, '--region'),
    endpoint: takeOption(rest, '--endpoint'),
    verify: rest.includes('--verify'),
    remove: rest.includes('--remove'),
  }, { env: process.env });
  return jsonResult(result);
}

async function decisionAsk(ctx: HandlerContext): Promise<HandlerResult> {
  const args = ctx.args.slice(1);
  const modeCount = flagCount(args, ['--yes-no']) + (args.includes('--choices') ? 1 : 0) + (args.includes('--scale') ? 1 : 0);
  if (modeCount !== 1) throw new DecisionAskUsageError('invalid-mode', 'Select exactly one of --yes-no, --choices, or --scale');
  const contextModes = flagCount(args, ['--context', '--context-file', '--context-stdin']);
  if (contextModes > 1) throw new DecisionAskUsageError('invalid-context', 'Select at most one context source');
  const question = args.includes('--question') ? takeRequiredOption(args, '--question') : '';
  let context: string | undefined = takeOption(args, '--context');
  if (args.includes('--context') && (context === undefined || context.startsWith('--'))) {
    throw new DecisionAskUsageError('missing-context', '--context requires text');
  }
  if (args.includes('--context-file')) {
    const filePath = takeRequiredOption(args, '--context-file');
    context = await readDecisionContextFile(filePath);
  }
  if (args.includes('--context-stdin')) context = await readStdin();
  const choices = args.includes('--choices') ? takeRequiredOption(args, '--choices') : undefined;
  const scale = args.includes('--scale') ? parseScale(takeOption(args, '--scale')) : null;
  const input = {
    question,
    mode: args.includes('--yes-no') ? { kind: 'yes-no' as const }
      : choices !== undefined ? { kind: 'choices' as const, choices: choices.split(',').map(value => value.trim()).filter(Boolean) }
        : { kind: 'scale' as const, ...scale! },
    ...(context === undefined ? {} : { context }),
    ...(args.includes('--threshold') ? { threshold: parseNumber(takeOption(args, '--threshold'), '--threshold') } : {}),
    ...(args.includes('--timeout-ms') ? { timeoutMs: parseNumber(takeOption(args, '--timeout-ms'), '--timeout-ms') } : {}),
  };
  const result = await askDecision(input, { env: process.env });
  if (args.includes('--json')) return jsonResult(result);
  if (result.status === 'fallback') return { exitCode: 0, message: `FALLBACK to LLM: ${result.reason}`, rawOutput: true };
  return { exitCode: 0, message: `${String(result.answer)} (confidence ${result.confidence?.toFixed(2) ?? 'unknown'}, ${result.model ?? 'unknown-model'})`, rawOutput: true };
}

async function executeDecision(ctx: HandlerContext): Promise<HandlerResult> {
  const [command, subcommand, ...rest] = ctx.args;
  const options = { cwd: ctx.cwd, frameworkRoot: ctx.frameworkRoot, env: process.env };
  try {
    if (!command || command === '--help' || command === '-h') return { exitCode: 0, message: usage(), rawOutput: true };
    if (command === 'capabilities' || command === 'status') return jsonResult(decisionCapabilities(options));
    if (command === 'ask') return await decisionAsk(ctx);
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
      const result = await evaluateRequestPath(request, options, {
        hostPolicyModulePath: takeOption(ctx.args, '--host-policy-module'),
      });
      return jsonResult(result, result.exitCode);
    }
    if (command === 'setup' && subcommand === 'synthetic-classification') {
      const outputDir = takeOption(ctx.args, '--output-dir');
      if (outputDir) return jsonResult(await materializeSyntheticClassificationSetup(outputDir, {}, options));
      return jsonResult(syntheticClassificationSetup({}, options));
    }
    if (command === 'setup' && subcommand === 'jev') return await decisionSetupJev(rest);
    return { exitCode: 2, message: usage(), rawOutput: true };
  } catch (error) {
    if (error instanceof DecisionAskUsageError) {
      return { exitCode: 2, message: JSON.stringify({ schema: 'aiwg-decision-error/v1', reason: error.reason, message: error.message }, null, 2), rawOutput: true };
    }
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
