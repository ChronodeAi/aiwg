// Verify rule bodies are reached by a native loader or a live startup hook.
import fs from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { parseRuleFrontmatter } from '../../src/rules/activation.mjs';
import { projectOnDemandReferences } from '../../tools/agents/providers/rule-presentation.mjs';

export function readRuleDeliveryContext(report: { contributors: Array<{ path: string }>; pins?: Array<{ name: string }> }, provider: string): string {
  const files = report.contributors.map(file => file.path);
  const manifests = [...new Set(files.filter(file => /[/\\](?:rules|rule|instructions)[/\\]/.test(file))
    .map(file => path.dirname(file)).map(dir => path.join(dir, '.aiwg-manifest.json')))];
  const read = (file: string) => fs.readFileSync(file, 'utf8');
  const native = ['claude', 'cursor', 'grok-build', 'windsurf', 'opencode'].includes(provider);
  for (const file of manifests.filter(file => fs.existsSync(file))) {
    const manifest = JSON.parse(read(file));
    if (!manifest.delivery) continue; // Nested behavior files share the parent receipt.
    const projectRoot = path.resolve(path.dirname(file), manifest.delivery.projectFromRules);
    const entryPoint = path.resolve(projectRoot, manifest.delivery.entryPoint);
    const startupFiles = manifest.delivery.startupFiles.map((name: string) => path.resolve(projectRoot, name));
    expect(fs.existsSync(entryPoint), `${provider}: index entry point`).toBe(true);
    const startup = startupFiles.map(read).join('\n');
    if (!['claude', 'cursor'].includes(provider)) {
      for (const file of startupFiles) {
        expect(read(file), `${provider}: hook in ${file}`).toContain(`${provider}: Before every task and subagent task, read and follow`);
        expect(read(file)).toContain(path.relative(projectRoot, entryPoint).replaceAll('\\', '/'));
      }
    }
    const assertLoaded = (file: string) => {
      const data = parseRuleFrontmatter(read(file)).data as Record<string, unknown>;
      if (provider === 'windsurf') expect(data.trigger, `${provider}: always-on ${file}`).toBe('always_on');
      if (provider === 'cursor') expect(data.alwaysApply, `${provider}: alwaysApply ${file}`).toBe(true);
      if (provider === 'opencode') {
        const { instructions } = JSON.parse(read(path.join(projectRoot, 'opencode.json')));
        expect(instructions).toEqual(expect.arrayContaining(['AGENTS.md', 'AIWG.md']));
        const relative = path.relative(projectRoot, file).replaceAll('\\', '/');
        const dir = path.posix.dirname(relative);
        expect(instructions.some((item: string) => item === relative || item === `${dir}/*.md`), `${provider}: registered ${relative}`).toBe(true);
      }
    };
    if (native) assertLoaded(entryPoint);
    const rules = manifest.ruleSources.map((file: string) => {
      const content = read(file), parsed = parseRuleFrontmatter(content);
      return { ...parsed.rule, content, body: parsed.body, file,
        name: parsed.data.name || path.basename(file, '.md') };
    });
    const projected = projectOnDemandReferences(rules, ['claude', 'cursor', 'windsurf'].includes(provider));
    for (const rule of projected.filter((rule: any) => rule.activation === 'kernel' || report.pins?.some(pin => pin.name === rule.name))) {
      const name = path.basename(rule.file) === 'BEHAVIOR.md' ? `${['grok-build', 'windsurf'].includes(provider) ? 'behavior-' : 'behaviors/'}${path.basename(path.dirname(rule.file))}` : path.basename(rule.file, '.md');
      const dest = path.join(path.dirname(entryPoint), `${name}.${provider === 'cursor' ? 'mdc' : 'md'}`);
      expect(read(dest), `${provider}: complete ${name}`).toContain(rule.body.trim());
      const index = read(entryPoint);
      const link = `[${name}.${provider === 'cursor' ? 'mdc' : 'md'}](./${name}.${provider === 'cursor' ? 'mdc' : 'md'})`;
      const fetch = `aiwg show rule ${rule.name} --body`;
      expect(index.includes(link) || (native && index.includes(fetch)), `${provider}: index reaches ${name}`).toBe(true);
      if (native) assertLoaded(dest);
      expect(startup, `${provider}: no inline ${name}`).not.toContain(rule.body.trim());
    }
  }
  return files.map(read).join('\n');
}
