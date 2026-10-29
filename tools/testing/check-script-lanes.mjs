// Reconcile root gate scripts with main-push workflow jobs and reviewed exemptions.
import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';
import { parse } from 'yaml';
import { expandScripts, workflowRunSteps } from './workflow-commands.mjs';

export function runsOnMain(source) {
  const on = parse(source).on;
  if (typeof on === 'string') return on === 'push';
  if (Array.isArray(on)) return on.includes('push');
  if (!on || !Object.hasOwn(on, 'push')) return false;
  const push = on.push;
  if (!push) return true;
  if (push.tags && !push.branches) return false;
  if (push.branches && !push.branches.some(pattern => path.matchesGlob('main', pattern))) return false;
  return !(push['branches-ignore'] ?? []).some(pattern => path.matchesGlob('main', pattern));
}

export function inspectScriptLanes(root, scripts, exemptions = []) {
  const owners = new Map();
  for (const file of globSync(['.gitea/workflows/*.{yml,yaml}', '.github/workflows/*.{yml,yaml}'], { cwd: root }).sort()) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    if (!runsOnMain(source)) continue;
    for (const step of workflowRunSteps(source)) {
      const { names } = expandScripts(step.run, scripts);
      for (const name of names) {
        const lanes = owners.get(name) ?? new Set();
        lanes.add(`${file}#${step.job}`);
        owners.set(name, lanes);
      }
    }
  }
  const errors = [];
  const listed = new Map();
  for (const entry of exemptions) {
    if (!entry || typeof entry.script !== 'string') {
      errors.push('Script exemption is missing a script');
      continue;
    }
    const { script, owner, reason, kind } = entry;
    if (listed.has(script)) errors.push(`Duplicate script exemption: ${script}`);
    listed.set(script, entry);
    if (!Object.hasOwn(scripts, script)) errors.push(`Stale script exemption: ${script}`);
    if (typeof owner !== 'string' || !owner.trim() || typeof reason !== 'string' || !reason.trim()) {
      errors.push(`Script exemption requires owner and reason: ${script}`);
    }
    if (!['manual', 'release-only', 'live', 'unwired'].includes(kind)) errors.push(`Invalid script exemption kind: ${script}`);
    if (owners.has(script)) errors.push(`Script exemption is owned by main CI; remove it: ${script}`);
  }
  // Keep the release closure explicitly release-only even if a future edit wires it into main.
  for (const name of expandScripts('npm run test:release-slow', scripts).names) {
    if (Object.hasOwn(scripts, name) && /^(lint|test|check):/.test(name)
      && listed.get(name)?.kind !== 'release-only') errors.push(`Release-slow script requires release-only exemption: ${name}`);
  }
  const records = Object.keys(scripts).filter(name => /^(lint|test|check):/.test(name)).sort().map(script => {
    const workflows = [...(owners.get(script) ?? [])].sort();
    const exemption = listed.get(script);
    if (!workflows.length && !exemption) errors.push(`Script has no main CI lane or exemption: ${script}`);
    return { script, workflows, ...(exemption ? { exemption } : {}) };
  });
  return { records, errors };
}
