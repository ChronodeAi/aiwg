import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';

function jsonResult(value: unknown, exitCode = 0): HandlerResult {
  return { exitCode, message: JSON.stringify(value, null, 2), rawOutput: true };
}

function usage(): string {
  return [
    'Usage: aiwg gates <validate|evaluate|show|list> [options]',
    '',
    'Commands:',
    '  validate <pack|binding|report> <path> [--pack-dir <dir>] [--aiwg-root <dir>]',
    '  evaluate --binding <file> --metrics <file> --holdout <file> [--upstream <file>] --now <iso> --trusted-binding-digest <sha256> [--pack-dir <dir>] [--aiwg-root <dir>]',
    '  show <id> [--pack-dir <dir>] [--aiwg-root <dir>]',
    '  list [--namespace <ns>] [--rule [<rule-id>]] [--pack-dir <dir>] [--aiwg-root <dir>]',
    '',
    'Packs live in <bundle>/gate-packs/*.gatepack.yaml|json and register as',
    'aiwg:<bundle>/<name> (shipped).',
    'Single files and bundle directories passed via --pack-dir are always',
    'project: packs; aiwg: is reserved for the installed tree, and a --pack-dir',
    'manifest claiming a shipped or installed bundle id refuses. An --aiwg-root',
    'override is untrusted:',
    'list/show/validate still inspect it, but evaluate refuses it.',
    'Evaluation is pure and offline: pass --now <iso> for the fake clock.',
    'The holdout and upstream files must already carry their sealed digests,',
    'and --upstream is required whenever the binding observes an',
    'upstream-ceiling gate. Project floors load from .aiwg/aiwg.config in the',
    'cwd (unreadable or invalid config refuses evaluation). Reports printed',
    "here carry attestation: 'offline-cli'.",
  ].join('\n');
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function takeAllOptions(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && index + 1 < args.length) values.push(args[index + 1]);
  }
  return values;
}

function driverOptions(ctx: HandlerContext) {
  // The shipped root resolves from the installed framework location, never
  // from the cwd: any checkout could otherwise impersonate the aiwg:
  // namespace. An explicit --aiwg-root is kept for inspection only; packs
  // loaded from it are marked untrusted and refused by evaluate.
  const aiwgRoot = takeOption(ctx.args, '--aiwg-root') ?? ctx.frameworkRoot;
  const packDirs = takeAllOptions(ctx.args, '--pack-dir');
  return { cwd: ctx.cwd, aiwgRoot, ...(packDirs.length ? { packDirs } : {}) };
}

/** Positional args with each known value-flag and its value skipped in order. */
function positionals(args: string[], skipCommand: string): string[] {
  const valueFlags = new Set(['--pack-dir', '--aiwg-root', '--binding', '--metrics', '--holdout', '--upstream', '--now', '--namespace', '--rule', '--trusted-binding-digest']);
  const found: string[] = [];
  let skipNext = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (valueFlags.has(arg)) {
      skipNext = true;
      continue;
    }
    if (arg.startsWith('-')) continue;
    if (arg === skipCommand && index === 0) continue;
    found.push(arg);
  }
  return found;
}

async function executeGates(ctx: HandlerContext): Promise<HandlerResult> {
  const [command] = ctx.args;
  try {
    if (!command || command === '--help' || command === '-h') return { exitCode: 0, message: usage(), rawOutput: true };
    const {
      validateGateFile, evaluateGatesFromFiles, showGatePack, listGatePacks, packsReferencedByRule,
    } = await import('../../gates/driver.js');
    const options = driverOptions(ctx);
    if (command === 'validate') {
      const args = positionals(ctx.args, 'validate');
      const target = (args[0] ?? '') as 'pack' | 'binding' | 'report' | 'auto';
      const targetPath = args[1] ?? '';
      if (!['pack', 'binding', 'report', 'auto'].includes(target) || !targetPath) {
        return { exitCode: 2, message: `gates validate requires <pack|binding|report|auto> <path>\n\n${usage()}`, rawOutput: true };
      }
      const result = await validateGateFile(target === 'auto' ? 'auto' : target, targetPath, options);
      return jsonResult(result, result.valid ? 0 : 2);
    }
    if (command === 'evaluate') {
      const binding = takeOption(ctx.args, '--binding');
      const metrics = takeOption(ctx.args, '--metrics');
      const holdout = takeOption(ctx.args, '--holdout');
      const upstream = takeOption(ctx.args, '--upstream');
      const now = takeOption(ctx.args, '--now');
      const trustedBindingDigest = takeOption(ctx.args, '--trusted-binding-digest');
      if (!binding || !metrics || !holdout || !now || !trustedBindingDigest) {
        return { exitCode: 2, message: `gates evaluate requires --binding <file> --metrics <file> --holdout <file> --now <iso> --trusted-binding-digest <sha256:..>\n\n${usage()}`, rawOutput: true };
      }
      if (!/^sha256:[0-9a-f]{64}$/.test(trustedBindingDigest)) {
        return { exitCode: 2, message: `gates evaluate requires --trusted-binding-digest <sha256:..> (64 hex chars)\n\n${usage()}`, rawOutput: true };
      }
      const report = await evaluateGatesFromFiles({
        bindingPath: binding, metricsPath: metrics, holdoutPath: holdout,
        ...(upstream ? { upstreamPath: upstream } : {}), now,
        trustedBindingDigest: trustedBindingDigest as `sha256:${string}`,
      }, options);
      return jsonResult(report, 0);
    }
    if (command === 'show') {
      const id = positionals(ctx.args, 'show')[0];
      if (!id) return { exitCode: 2, message: `gates show requires <id>\n\n${usage()}`, rawOutput: true };
      return jsonResult(showGatePack(id, options), 0);
    }
    if (command === 'list') {
      const namespace = takeOption(ctx.args, '--namespace');
      const ruleIndex = ctx.args.indexOf('--rule');
      const ruleValue = ruleIndex >= 0 ? ctx.args[ruleIndex + 1] : undefined;
      const rule = ruleIndex >= 0 ? (ruleValue && !ruleValue.startsWith('-') ? ruleValue : null) : undefined;
      const packs = listGatePacks({ ...options, ...(namespace ? { namespace } : {}) });
      if (rule === undefined) return jsonResult({ schema: 'aiwg-gates-list/v1', packs }, 0);
      if (rule === null) {
        return jsonResult({
          schema: 'aiwg-gates-list/v1', packs,
          enforcedBy: { status: 'stub', note: 'Rule enforcedBy coverage is tracked in #2839; rules without enforcedBy remain guidance.' },
        }, 0);
      }
      const referenced = new Set(await packsReferencedByRule(rule, options));
      return jsonResult({
        schema: 'aiwg-gates-list/v1', rule,
        packs: packs.filter(pack => referenced.has(pack.id)),
        enforcedBy: { status: 'stub', note: 'Rule enforcedBy coverage is tracked in #2839.' },
      }, 0);
    }
    return { exitCode: 2, message: usage(), rawOutput: true };
  } catch (error) {
    return { exitCode: 1, message: error instanceof Error ? error.message : String(error) };
  }
}

export const gatesHandler: CommandHandler = {
  id: 'gates',
  name: 'Gates',
  description: 'Validate, evaluate and inspect declarative gate packs offline',
  category: 'utility',
  aliases: [],
  help: async () => ({ exitCode: 0, message: usage(), rawOutput: true }),
  execute: executeGates,
};
