import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import {
  ATTRIBUTION_FIELD_PATTERN,
  askDecision,
  DecisionAskUsageError,
  decisionCapabilities,
  DecisionLedgerSinceError,
  decisionLedgerHistory,
  decisionLedgerStats,
  evaluateRequestPath,
  listPatterns,
  livePlan,
  MAX_ATTRIBUTION_FIELD_LENGTH,
  materializeSyntheticClassificationSetup,
  parseDecisionLedgerSince,
  readDecisionContextFile,
  recordDecisionAsk,
  runOfflinePattern,
  setupJev,
  showPattern,
  syntheticClassificationSetup,
  validateDecisionInput,
  type DecisionLedgerGroupBy,
  type DecisionLedgerKind,
} from '../../decision/driver.js';
import type { DecisionPatternId } from '../../decision/index.js';

function jsonResult(value: unknown, exitCode = 0): HandlerResult {
  return { exitCode, message: JSON.stringify(value, null, 2), rawOutput: true };
}

function usage(): string {
  return [
    'Usage: aiwg decision <capabilities|status|patterns|validate|evaluate|setup|history|stats> [options]',
    '       aiwg decision ask --question "<q>" (--yes-no | --choices a,b,c | --scale 1-5) [--context <text> | --context-file <path> | --context-stdin] [--threshold 0.8] [--timeout-ms 15000] [--provider <id>] [--session <id>] [--caller <tag>] [--record-text] [--json]',
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
    '  ask --question "<q>" (--yes-no | --choices a,b,c | --scale 1-5) [--provider <id>] [--session <id>] [--caller <tag>] [--record-text]',
    '  history [--since <date>] [--provider <id>] [--session <id>] [--kind yes-no|choices|scale] [--status answered|fallback] [--json]',
    '  stats [--since <date>] [--provider <id>] [--session <id>] [--kind yes-no|choices|scale] [--status answered|fallback] [--group-by provider|session|kind|caller] [--json]',
    '',
    'Notes:',
    '  Every COMPLETED `ask` call (CLI and MCP) appends one record to the decision',
    '  ledger (.aiwg/decision/ledger.jsonl, resolved like `aiwg artifacts path`).',
    '  Usage errors (bad flags, oversized context) are never recorded. Question',
    '  and context text are never written unless --record-text is passed, and even',
    '  then only after redaction and truncation to a documented size cap. Every',
    '  other persisted field (session, caller, choice ids, answer, model, provider,',
    '  project root) is also redacted before being written. `questionDigest` and',
    '  `contextDigest` are plain SHA-256 over the raw text: a short, predictable',
    '  question can still be matched by hashing candidate guesses, so a digest is',
    '  not a confidentiality guarantee on its own.',
    '  `history` and `stats` read that ledger offline — no network, no Jev call.',
    '  `--since` is strict ISO-8601: a bare date or an offsetless timestamp is',
    '  interpreted as UTC; invalid calendar dates (e.g. 2026-02-30) are rejected,',
    '  including when an explicit offset is present.',
    `  --session and --caller must match ${ATTRIBUTION_FIELD_PATTERN.source} (<= ${MAX_ATTRIBUTION_FIELD_LENGTH} characters).`,
    '  The ledger has no built-in retention: it grows without bound and the',
    '  operator may truncate or delete it at any time; readers tolerate a missing',
    '  file. The ledger trusts only the local filesystem under the project',
    '  artifact root, owned by the same user running aiwg — it is not a defense',
    '  against a hostile process already running as that user.',
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

/** Shared by --session and --caller (review r1 finding 1): a conservative identifier shape, rejected with exit 2. */
function takeAttributionOption(args: string[], name: '--session' | '--caller', reason: 'invalid-session' | 'invalid-caller'): string | undefined {
  const value = takeOption(args, name);
  if (value === undefined) return undefined;
  if (!ATTRIBUTION_FIELD_PATTERN.test(value)) {
    throw new DecisionAskUsageError(reason, `${name} must match ${ATTRIBUTION_FIELD_PATTERN.source} (<= ${MAX_ATTRIBUTION_FIELD_LENGTH} characters)`);
  }
  return value;
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
  // Validated before any Jev call, so a malformed attribution flag never wastes one.
  const explicitSessionId = takeAttributionOption(args, '--session', 'invalid-session');
  const caller = takeAttributionOption(args, '--caller', 'invalid-caller');
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
  // Best-effort and bounded (recordDecisionAsk never throws and never hangs past its own
  // deadline): a ledger failure, timeout, or attribution-detection error can never change
  // `result` or the exit code decided below (review r1 findings 3 and 4).
  await recordDecisionAsk(input, result, {
    transport: 'cli',
    projectRoot: ctx.cwd,
    env: process.env,
    explicitProvider: takeOption(args, '--provider'),
    explicitSessionId,
    caller: caller ?? null,
    recordText: args.includes('--record-text'),
  });
  if (args.includes('--json')) return jsonResult(result);
  if (result.status === 'fallback') return { exitCode: 0, message: `FALLBACK to LLM: ${result.reason}`, rawOutput: true };
  return { exitCode: 0, message: `${String(result.answer)} (confidence ${result.confidence?.toFixed(2) ?? 'unknown'}, ${result.model ?? 'unknown-model'})`, rawOutput: true };
}

function parseSince(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  try {
    return parseDecisionLedgerSince(value);
  } catch (error) {
    if (error instanceof DecisionLedgerSinceError) throw new DecisionAskUsageError('invalid-since', error.message);
    throw error;
  }
}

const DECISION_LEDGER_KINDS: readonly DecisionLedgerKind[] = ['yes-no', 'choices', 'scale'];
const DECISION_LEDGER_STATUSES = ['answered', 'fallback'] as const;
const DECISION_LEDGER_GROUP_BYS: readonly DecisionLedgerGroupBy[] = ['provider', 'session', 'kind', 'caller'];

function parseKindFilter(value: string | undefined): DecisionLedgerKind | undefined {
  if (value === undefined) return undefined;
  if (!(DECISION_LEDGER_KINDS as readonly string[]).includes(value)) {
    throw new DecisionAskUsageError('invalid-kind', `--kind must be one of ${DECISION_LEDGER_KINDS.join(', ')}`);
  }
  return value as DecisionLedgerKind;
}

function parseStatusFilter(value: string | undefined): 'answered' | 'fallback' | undefined {
  if (value === undefined) return undefined;
  if (!(DECISION_LEDGER_STATUSES as readonly string[]).includes(value)) {
    throw new DecisionAskUsageError('invalid-status', `--status must be one of ${DECISION_LEDGER_STATUSES.join(', ')}`);
  }
  return value as 'answered' | 'fallback';
}

function parseGroupBy(value: string | undefined): DecisionLedgerGroupBy | undefined {
  if (value === undefined) return undefined;
  if (!(DECISION_LEDGER_GROUP_BYS as readonly string[]).includes(value)) {
    throw new DecisionAskUsageError('invalid-group-by', `--group-by must be one of ${DECISION_LEDGER_GROUP_BYS.join(', ')}`);
  }
  return value as DecisionLedgerGroupBy;
}

/** Shared by `history` and `stats` (review r1 finding 9): the same filters, parsed the same way. */
function parseLedgerFilters(args: string[]) {
  return {
    since: parseSince(takeOption(args, '--since')),
    provider: takeOption(args, '--provider'),
    sessionId: takeOption(args, '--session'),
    kind: parseKindFilter(takeOption(args, '--kind')),
    status: parseStatusFilter(takeOption(args, '--status')),
  };
}

async function decisionHistory(ctx: HandlerContext): Promise<HandlerResult> {
  const args = ctx.args.slice(1);
  const result = await decisionLedgerHistory(ctx.cwd, parseLedgerFilters(args));
  if (args.includes('--json')) return jsonResult(result);
  const header = result.skipped > 0 ? [`(${result.skipped} invalid line(s) skipped)`] : [];
  if (result.count === 0) return { exitCode: 0, message: [...header, 'No decision ledger records match the filters.'].join('\n'), rawOutput: true };
  const lines = result.records.map(record => `${record.timestamp}  ${record.status.padEnd(8)} provider=${record.provider} kind=${record.decisionKind} confidence=${record.confidence ?? '-'} caller=${record.caller ?? '-'} id=${record.id}`);
  return { exitCode: 0, message: [...header, ...lines].join('\n'), rawOutput: true };
}

async function decisionStats(ctx: HandlerContext): Promise<HandlerResult> {
  const args = ctx.args.slice(1);
  const result = await decisionLedgerStats(ctx.cwd, { ...parseLedgerFilters(args), groupBy: parseGroupBy(takeOption(args, '--group-by')) });
  if (args.includes('--json')) return jsonResult(result);
  const header = result.skipped > 0 ? [`(${result.skipped} invalid line(s) skipped)`] : [];
  if (result.groups.length === 0) return { exitCode: 0, message: [...header, 'No decision ledger records match the filters.'].join('\n'), rawOutput: true };
  const lines = result.groups.flatMap(group => [
    `${result.groupBy ?? 'all'}=${group.key ?? 'null'}: ${group.totalCalls} calls (${group.answered} answered, ${group.fallback} fallback, rate=${group.fallbackRate.toFixed(2)})`,
    `  confidence: mean=${group.confidence.mean?.toFixed(2) ?? '-'} min=${group.confidence.min?.toFixed(2) ?? '-'} max=${group.confidence.max?.toFixed(2) ?? '-'} (n=${group.confidence.count})`,
    `  jev usage: input=${group.jevUsage.inputTokens} output=${group.jevUsage.outputTokens}`,
    `  estimated LLM tokens avoided=${group.estimatedLlmTokensAvoidedTotal} net savings=${group.netSavingsTokens}`,
  ]);
  return { exitCode: 0, message: [...header, ...lines].join('\n'), rawOutput: true };
}

async function executeDecision(ctx: HandlerContext): Promise<HandlerResult> {
  const [command, subcommand, ...rest] = ctx.args;
  const options = { cwd: ctx.cwd, frameworkRoot: ctx.frameworkRoot, env: process.env };
  try {
    if (!command || command === '--help' || command === '-h') return { exitCode: 0, message: usage(), rawOutput: true };
    if (command === 'capabilities' || command === 'status') return jsonResult(decisionCapabilities(options));
    if (command === 'ask') return await decisionAsk(ctx);
    if (command === 'history') return await decisionHistory(ctx);
    if (command === 'stats') return await decisionStats(ctx);
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
