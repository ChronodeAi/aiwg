// Extract stable existing-project context without provider-generated prose.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { sensitiveEvidence } from './workspace-audit.js';
import {
  ExistingProjectContext,
  isGeneratedRootContext,
  PROJECT_CONTEXT_PLACEHOLDER,
  PROJECT_EXTRACTION_END,
  PROJECT_EXTRACTION_START,
  readOptional,
  replaceBlock,
} from './workspace-context-shared.js';

export function cleanInlineMarkdown(value: string): string {
  return value
    .replace(/<!--.*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncateAtWord(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const candidate = value.slice(0, limit + 1);
  const boundary = candidate.lastIndexOf(' ');
  return `${candidate.slice(0, boundary > Math.floor(limit * 0.7) ? boundary : limit).trimEnd()}…`;
}

export function projectLink(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  return `[\`${normalized}\`](./${normalized})`;
}

export async function firstReadmePurpose(projectPath: string): Promise<{ source: string; purpose: string } | null> {
  for (const source of ['README.md', 'README.mdx', 'README.rst', 'README.txt']) {
    const content = await readOptional(path.join(projectPath, source));
    if (!content || isGeneratedRootContext(source, content)) continue;
    // Strip HTML before block-splitting. The per-line filter below drops lines
    // that *start* with `<`, which misses the continuation lines of a tag that
    // wraps — a hero `<a ...><img alt="..." width="1000"></a>` then yields its
    // own attribute text as the project purpose. Removing tags outright (dotall,
    // so multi-line tags are covered) leaves only prose for the filter to weigh.
    const prose = content
      .replace(/\r\n/g, '\n')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^<>]*>/g, ' ');
    const blocks = prose.split(/\n\s*\n/);
    for (const block of blocks) {
      const lines = block.split('\n').filter((line) => {
        const trimmed = line.trim();
        return trimmed
          && !trimmed.startsWith('#')
          && !trimmed.startsWith('![')
          && !trimmed.startsWith('[![')
          && !trimmed.startsWith('<')
          && !/^[-*+]\s/.test(trimmed)
          && !/^```/.test(trimmed);
      });
      const purpose = cleanInlineMarkdown(lines.join(' ')).slice(0, 360).trim();
      if (purpose.length >= 24) return { source, purpose };
    }
  }
  return null;
}

export async function existingPaths(projectPath: string, candidates: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of candidates) {
    try {
      await fs.access(path.join(projectPath, candidate));
      found.push(candidate);
    } catch {
      // Optional project evidence.
    }
  }
  return found;
}

export async function workflowFiles(projectPath: string): Promise<string[]> {
  const files: string[] = [];
  for (const directory of ['.gitea/workflows', '.github/workflows']) {
    let entries;
    try { entries = await fs.readdir(path.join(projectPath, directory), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isFile() && /^[A-Za-z0-9._-]+\.ya?ml$/i.test(entry.name)) files.push(`${directory}/${entry.name}`);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

export async function extractExistingProjectContext(projectPath: string): Promise<ExistingProjectContext> {
  const lines: string[] = [
    PROJECT_EXTRACTION_START,
    '',
    '## Existing Project Snapshot',
    '',
    '<!-- Generated from stable project metadata. Edit the linked sources, not this block. -->',
  ];
  const sources = new Set<string>();
  let sensitiveFindings: Array<{ path: string; evidence: string }> = [];
  const packageContent = await readOptional(path.join(projectPath, 'package.json'));
  if (packageContent) {
    try {
      const manifest = JSON.parse(packageContent) as {
        name?: unknown;
        description?: unknown;
        packageManager?: unknown;
        engines?: unknown;
        scripts?: unknown;
      };
      const facts: string[] = [];
      if (typeof manifest.name === 'string' && manifest.name.trim()) facts.push(`- Name: \`${cleanInlineMarkdown(manifest.name).slice(0, 120)}\``);
      if (typeof manifest.description === 'string' && manifest.description.trim()) {
        facts.push(`- Description: ${truncateAtWord(cleanInlineMarkdown(manifest.description), 360)}`);
      }
      if (typeof manifest.packageManager === 'string' && manifest.packageManager.trim()) {
        facts.push(`- Package manager: \`${cleanInlineMarkdown(manifest.packageManager).slice(0, 120)}\``);
      }
      if (manifest.engines && typeof manifest.engines === 'object' && !Array.isArray(manifest.engines)) {
        const engines = Object.entries(manifest.engines as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, constraint]) => `${name} ${cleanInlineMarkdown(constraint).slice(0, 80)}`);
        if (engines.length) facts.push(`- Runtime: ${engines.map((engine) => `\`${engine}\``).join(', ')}`);
      }
      if (facts.length) {
        lines.push('', `### Package (source: ${projectLink('package.json')})`, '', ...facts);
        sources.add('package.json');
      }
      if (manifest.scripts && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts)) {
        const preferred = ['build', 'test', 'lint', 'typecheck', 'check', 'start', 'dev'];
        const available = preferred.filter((name) => typeof (manifest.scripts as Record<string, unknown>)[name] === 'string');
        if (available.length) {
          lines.push('', `### Common Commands (source: ${projectLink('package.json')})`, '', ...available.map((name) => `- \`npm run ${name}\``));
          sources.add('package.json');
        }
      }
    } catch {
      // Invalid package metadata remains the owning tool's concern; extraction skips it.
    }
  }

  const readme = await firstReadmePurpose(projectPath);
  if (readme) {
    lines.push('', `### Purpose (source: ${projectLink(readme.source)})`, '', readme.purpose);
    sources.add(readme.source);
  }

  const stackSignals = await existingPaths(projectPath, [
    'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
    'tsconfig.json', 'deno.json', 'deno.jsonc', 'pyproject.toml', 'requirements.txt',
    'Pipfile', 'poetry.lock', 'Cargo.toml', 'Cargo.lock', 'go.mod', 'Gemfile',
    'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Makefile',
  ]);
  if (stackSignals.length) {
    lines.push('', '### Stack and Tooling', '', ...stackSignals.map((source) => `- ${projectLink(source)}`));
    for (const source of stackSignals) sources.add(source);
  }

  const architecture = await existingPaths(projectPath, [
    'ARCHITECTURE.md', 'docs/architecture.md', 'docs/architecture', 'docs/adr', 'docs/adrs',
    'src', 'app', 'apps', 'packages', 'services', 'crates',
  ]);
  const tests = await existingPaths(projectPath, [
    'test', 'tests', '__tests__', 'vitest.config.ts', 'vitest.config.js', 'vitest.config.mts',
    'jest.config.js', 'jest.config.ts', 'pytest.ini', 'tox.ini', 'playwright.config.ts',
  ]);
  const workflows = await workflowFiles(projectPath);
  if (architecture.length) {
    lines.push('', '### Architecture and Topology', '', ...architecture.map((source) => `- ${projectLink(source)}`));
  }
  if (tests.length) {
    lines.push('', '### Testing', '', ...tests.map((source) => `- ${projectLink(source)}`));
  }
  if (workflows.length) {
    // #3451: directory pointers with counts, not one line per workflow file.
    const byDirectory = new Map<string, number>();
    for (const source of workflows) {
      const directory = source.slice(0, source.lastIndexOf('/'));
      byDirectory.set(directory, (byDirectory.get(directory) ?? 0) + 1);
    }
    lines.push('', '### Continuous Integration', '', ...[...byDirectory].map(([directory, count]) =>
      `- ${projectLink(`${directory}/`)} (${count} workflow file${count === 1 ? '' : 's'})`));
  }
  for (const source of [...architecture, ...tests, ...workflows]) sources.add(source);

  const orderedSources = [...sources].sort((left, right) => left.localeCompare(right));
  if (orderedSources.length === 0) return { content: '', sources: [], sensitiveFindings };
  lines.push('', PROJECT_EXTRACTION_END);
  const content = lines.join('\n');
  sensitiveFindings = sensitiveEvidence(content).map((evidence) => ({ path: 'project extraction', evidence }));
  return { content, sources: orderedSources, sensitiveFindings };
}

export function mergeProjectExtraction(operatorContent: string, extraction: string): string {
  const existingStart = operatorContent.indexOf(PROJECT_EXTRACTION_START);
  const existingEnd = operatorContent.indexOf(PROJECT_EXTRACTION_END);
  let preserved = operatorContent.trim();
  if (existingStart >= 0 || existingEnd >= 0) {
    const replaced = replaceBlock(preserved, PROJECT_EXTRACTION_START, PROJECT_EXTRACTION_END, '');
    preserved = (replaced ?? preserved).trim();
  }
  if (preserved === PROJECT_CONTEXT_PLACEHOLDER || preserved === [
    '## Project Context',
    '',
    'Add provider-neutral project conventions and links here.',
  ].join('\n')) preserved = '';
  if (!extraction) return preserved || PROJECT_CONTEXT_PLACEHOLDER;
  return [preserved, extraction].filter(Boolean).join('\n\n');
}
