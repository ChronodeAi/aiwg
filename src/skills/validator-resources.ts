// Diagnose bundled skill resource references without changing parser policy.
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_SKILLS_BASELINE, type AgentSkillDiagnostic } from './agent-skills.js';

const MARKDOWN_LINK = /!?\[[^\]]*]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\s*\)/g;

function diagnostic(
  code: string,
  severity: AgentSkillDiagnostic['severity'],
  file: string,
  yamlPath: string,
  message: string,
  remediation: string,
): AgentSkillDiagnostic {
  return {
    code,
    severity,
    file,
    yamlPath,
    message,
    upstreamBaseline: AGENT_SKILLS_BASELINE.revision,
    remediation,
  };
}


export function resourceDiagnostics(
  content: string,
  file: string,
  skillRoot: string | undefined,
  checkResources: boolean,
): AgentSkillDiagnostic[] {
  const diagnostics: AgentSkillDiagnostic[] = [];
  const references = new Set<string>();
  for (const match of content.matchAll(MARKDOWN_LINK)) {
    const raw = (match[1] ?? match[2] ?? '').trim();
    if (
      raw.length === 0
      || raw.startsWith('#')
      || /^(?:https?|mailto|data):/i.test(raw)
    ) {
      continue;
    }
    const withoutFragment = raw.split('#', 1)[0] ?? '';
    const decoded = (() => {
      try {
        return decodeURIComponent(withoutFragment);
      } catch {
        return withoutFragment;
      }
    })();
    references.add(decoded);
  }

  for (const reference of [...references].sort()) {
    const normalized = reference.replaceAll('\\', '/');
    if (
      path.isAbsolute(reference)
      || normalized === '..'
      || normalized.startsWith('../')
      || normalized.includes('/../')
    ) {
      diagnostics.push(diagnostic(
        'AS_RESOURCE_PATH',
        'warning',
        file,
        '$.body',
        `resource reference "${reference}" is not an in-skill relative path`,
        'Reference a file relative to SKILL.md without parent traversal.',
      ));
      continue;
    }

    const segments = normalized.split('/').filter(Boolean);
    if (segments.length > 2) {
      diagnostics.push(diagnostic(
        'AS_ADVISORY_RESOURCE_DEPTH',
        'warning',
        file,
        '$.body',
        `resource reference "${reference}" is deeper than one resource-directory level`,
        'Prefer resources such as references/topic.md, scripts/run.sh, or assets/example.json.',
      ));
    }

    if (!checkResources || !skillRoot) continue;
    const resolved = path.resolve(skillRoot, reference);
    const relative = path.relative(skillRoot, resolved);
    if (
      relative.startsWith('..')
      || path.isAbsolute(relative)
      || !fs.existsSync(resolved)
    ) {
      diagnostics.push(diagnostic(
        'AS_RESOURCE_MISSING',
        'warning',
        file,
        '$.body',
        `referenced resource "${reference}" does not exist`,
        'Add the referenced file or correct the relative resource path.',
      ));
      continue;
    }
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      diagnostics.push(diagnostic(
        'AS_RESOURCE_TYPE',
        'warning',
        file,
        '$.body',
        `referenced resource "${reference}" is not a regular file`,
        'Replace the reference target with an in-tree regular file.',
      ));
    }
  }
  return diagnostics;
}

