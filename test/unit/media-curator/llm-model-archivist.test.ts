import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const AGENT = resolve('agentic/code/frameworks/media-curator/agents/llm-model-archivist.md');
const REUSED_SKILLS = [
  'find-sources', 'archive-acquisition', 'acquire', 'integrity-verification', 'verify-archive', 'provenance-tracking', 'check-completeness',
];

function frontmatter(path: string): { data: Record<string, unknown>; body: string } {
  const text = readFileSync(path, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${path}: missing frontmatter`);
  return { data: parse(match[1]) as Record<string, unknown>, body: match[2] };
}

describe('llm-model-archivist agent (#2554)', () => {
  const { data, body } = frontmatter(AGENT);

  it('uses the media-curator agent frontmatter convention', () => {
    expect(data).toMatchObject({
      name: 'LLM Model Archivist',
      category: 'media-curator',
      model: 'sonnet',
      'model-role': 'reasoning',
      'model-tier': 'standard',
    });
    expect(String(data.description)).toMatch(/open-weight/i);
    const tools = String(data['allowed-tools']).split(',').map(tool => tool.trim());
    expect(tools).toEqual(expect.arrayContaining(['WebSearch', 'WebFetch', 'Read', 'Write', 'Bash']));
    expect(data).not.toHaveProperty('tools');
    expect(data).not.toHaveProperty('capabilities');
    expect(data).not.toHaveProperty('keywords');
  });

  it('stays under the 16 KiB subagent-dispatch ceiling', () => {
    expect(statSync(AGENT).size).toBeLessThan(16 * 1024);
  });

  it('names every curator skill it reuses instead of reimplementing them', () => {
    for (const skill of REUSED_SKILLS) expect(body).toContain(`\`${skill}\``);
    expect(body).toContain('tools/media-curator/llm-model-archive.mjs');
    expect(body).toContain('tools/media-curator/llm-model-report.mjs');
  });

  it('flags quantized-only candidates and keeps them out of the archive by default', () => {
    expect(body).toContain('flagged-quantized-only');
    expect(body).toMatch(/archive them only when the operator explicitly requests/i);
  });

  it('reads hub credentials only at point of use and never as arguments', () => {
    expect(body).toMatch(/token-security/);
    expect(body).toMatch(/HF_TOKEN=\$\(cat /);
    expect(body).not.toMatch(/--token\s+\S/);
    expect(body).not.toMatch(/echo .*TOKEN/);
    expect(body).toMatch(/or write it into the inventory, report, PROV record, or work log/i);
  });

  it('carries the required inventory and report fields and the citation rule', () => {
    for (const field of ['model_id', 'revision', 'precision', 'parameter_count', 'license', 'downloads', 'benchmarks', 'archive_path', 'files', 'status']) {
      expect(body).toContain(`\`${field}`);
    }
    expect(body).toMatch(/citation-policy/);
    expect(body).toMatch(/GRADE/);
  });

  it('is registered in the framework manifest, the plugin mirror, the quickref, and the docs', () => {
    const manifest = JSON.parse(readFileSync('agentic/code/frameworks/media-curator/agents/manifest.json', 'utf8'));
    expect(manifest.files).toContain('llm-model-archivist.md');
    const mirrorManifest = JSON.parse(readFileSync('agentic/code/plugins/media-curator/agents/manifest.json', 'utf8'));
    expect(mirrorManifest.files).toContain('llm-model-archivist.md');
    expect(readFileSync('agentic/code/plugins/media-curator/agents/llm-model-archivist.md', 'utf8')).toBe(readFileSync(AGENT, 'utf8'));
    const quickref = readFileSync('agentic/code/frameworks/media-curator/skills/media-curator-quickref/SKILL.md', 'utf8');
    expect(quickref).toContain('aiwg discover "archive open-weight language models"');
    expect(quickref).toContain('llm-model-archivist');
    expect(readFileSync('docs/frameworks/media-curator/overview.md', 'utf8')).toContain('LLM Model Archivist');
    expect(readFileSync('docs/frameworks/media-curator/user-guide.md', 'utf8')).toContain('Open-Weight Model Archival');
    const templates = readFileSync('agentic/code/frameworks/media-curator/docs/llm-model-archive-templates.md', 'utf8');
    for (const field of ['`model_id`', '`revision`', '`precision`', '`parameter_count`', '`license`', '`downloads`', '`benchmarks`', '`archive_path`', '`files`', '`status`']) {
      expect(templates).toContain(field);
    }
    const framework = JSON.parse(readFileSync('agentic/code/frameworks/media-curator/manifest.json', 'utf8'));
    expect(framework.memory.creates.some((entry: { path: string }) => entry.path === '.aiwg/frameworks/media-curator/models/')).toBe(true);
  });
});
