// Static workflow command parsing shared by registration and the CI build-order oracle.
import { parse } from 'yaml';

// Keep quoted words together, discard shell comments, and retain command boundaries.
// This is a static ordering check for literal commands, not a shell interpreter.
export function commands(run) {
  const tokens = run.replace(/\\\r?\n/g, ' ').match(/#[^\n]*|"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[;\n|&]|[^\s;|&"']+/g) ?? [];
  const result = [[]];
  for (const token of tokens) {
    if (token.startsWith('#')) continue;
    if (/^(?:&&|\|\||[;\n|&])$/.test(token)) result.push([]);
    else result.at(-1).push(token.replace(/^(['"])(.*)\1$/, '$2'));
  }
  return result.filter(words => words.length);
}

export function unprefixed(words) {
  let index = words[0] === 'env' ? 1 : 0;
  while (/^[A-Za-z_][\w]*=/.test(words[index] ?? '')) index++;
  return words.slice(index);
}

export function scriptName(words) {
  if (words[0] !== 'npm') return undefined;
  if (words[1] === 'run' || words[1] === 'run-script') return words[2];
  return undefined;
}

export function workflowRunSteps(source) {
  const workflow = parse(source);
  return Object.entries(workflow.jobs ?? {}).flatMap(([job, value]) =>
    (value.steps ?? []).flatMap((step, index) => typeof step.run === 'string'
      ? [{ job, index, ...step }] : []));
}

// Recognize root npm scripts, including commands behind the CI timeout wrapper.
// Prefix/workspace invocations belong to other manifests, never the root graph.
export function npmScripts(run) {
  return commands(run).flatMap(raw => {
    const words = unprefixed(raw);
    const index = words.indexOf('npm');
    if (index < 0) return [];
    if (index > 0 && !['if', 'then', 'do', 'timeout', 'nice'].includes(words[0])
      && !(words[0] === 'node' && words[index - 1] === '--')) return [];
    const npm = words.slice(index);
    const name = scriptName(npm) ?? (npm[1] === 'test' ? 'test' : undefined);
    return name && /^[\w:-]+$/.test(name) ? [name] : [];
  });
}

export function expandScripts(run, scripts) {
  const names = new Set();
  let text = run;
  const pending = npmScripts(run);
  for (const name of pending) {
    if (names.has(name)) continue;
    names.add(name);
    if (typeof scripts[name] !== 'string') continue;
    text += '\n' + scripts[name];
    pending.push(...npmScripts(scripts[name]));
  }
  return { names, text };
}
