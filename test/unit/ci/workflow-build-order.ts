// Check declared build consumers in each YAML job without executing workflow commands.
import { parse } from 'yaml';
import requiredCommands from '../../../ci/build-required-commands.json';

type Step = { name?: string; run?: string; if?: unknown; 'continue-on-error'?: unknown };
type Scripts = Record<string, string>;

// Keep quoted words together, discard shell comments, and retain command boundaries.
// This is a static ordering check for literal commands, not a shell interpreter.
function commands(run: string): string[][] {
  const tokens = run.replace(/\\\r?\n/g, ' ').match(/#[^\n]*|"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[;\n|&]|[^\s;|&"']+/g) ?? [];
  const result: string[][] = [[]];
  for (const token of tokens) {
    if (token.startsWith('#')) continue;
    if (/^(?:&&|\|\||[;\n|&])$/.test(token)) result.push([]);
    else result.at(-1)!.push(token.replace(/^(['"])(.*)\1$/, '$2'));
  }
  return result.filter(words => words.length);
}

function unprefixed(words: string[]): string[] {
  let index = words[0] === 'env' ? 1 : 0;
  while (/^[A-Za-z_][\w]*=/.test(words[index] ?? '')) index++;
  return words.slice(index);
}

function scriptName(words: string[]): string | undefined {
  if (words[0] !== 'npm') return undefined;
  if (words[1] === 'run' || words[1] === 'run-script') return words[2];
  return undefined;
}

function events(run: string, scripts: Scripts, seen = new Set<string>()): string[] {
  return commands(run).flatMap(raw => {
    const words = unprefixed(raw);
    const script = scriptName(words);
    if (script === 'build:cli') return ['build'];
    const required = requiredCommands.find(entry =>
      (script && entry.npmScript === script)
      || (words[0] === 'node' && words[1]?.replace(/^\.\//, '') === entry.nodeScript));
    if (required) return [required.nodeScript];
    if (script && scripts[script] && !seen.has(script)) {
      return events(scripts[script], scripts, new Set([...seen, script]));
    }
    return [];
  });
}

export function buildOrderViolations(source: string, file: string, scripts: Scripts = {}): string[] {
  const workflow = parse(source);
  const violations: string[] = [];
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {}) as [string, { steps?: Step[] }][]) {
    let built = false;
    for (const [index, step] of (job.steps ?? []).entries()) {
      if (typeof step.run !== 'string') continue;
      // A skipped/allowed-to-fail build cannot establish output for later steps.
      const reliable = step.if === undefined && !step['continue-on-error'];
      for (const event of events(step.run, scripts)) {
        if (event === 'build') {
          if (reliable) built = true;
        } else if (!built) {
          violations.push(`${file}: job ${jobId}, step ${index + 1} (${step.name ?? 'unnamed'}): ${event} requires npm run build:cli first`);
        }
      }
    }
  }
  return violations;
}
