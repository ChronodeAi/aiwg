// Check declared build consumers in each YAML job without executing workflow commands.
import { parse } from 'yaml';
import { commands, unprefixed, scriptName } from '../../../tools/testing/workflow-commands.mjs';
import requiredCommands from '../../../ci/build-required-commands.json';

type Step = { name?: string; run?: string; if?: unknown; 'continue-on-error'?: unknown };
type Scripts = Record<string, string>;

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
