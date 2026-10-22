import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const templates = join(process.cwd(), 'agentic/code/frameworks/sdlc-complete/add-ons/legal/templates');

function section(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe('legal add-on export-control templates (GH #347)', () => {
  const exportControl = readFileSync(join(templates, 'export-control-assessment-template.md'), 'utf8');

  it('does not list Syria as an OFAC comprehensive embargo', () => {
    const embargoes = section(exportControl, '**Comprehensive Embargoes**', '**Policy**');
    expect(embargoes).not.toMatch(/\|\s*Syria\s*\|/);
    expect(embargoes).toMatch(/\|\s*Cuba\s*\|/);
  });

  it('explains that Syria remains subject to EAR license requirements', () => {
    const note = section(exportControl, '**Syria**:', '### 3.2');
    expect(note).toContain('E.O. 14312');
    expect(note).toContain('31 CFR part 542');
    expect(note).toContain('15 CFR 746.9');
    expect(note).toContain('E:1');
  });

  it('keeps Syria in EAR Country Group E:1', () => {
    expect(exportControl).toMatch(/\| \*\*E:1\*\* \|[^\n]*Syria/);
  });

  it('does not call Syria an embargoed country in the legal risk template', () => {
    const legalRisk = readFileSync(join(templates, 'legal-risk-assessment-template.md'), 'utf8');
    expect(legalRisk).not.toMatch(/embargoed countries \([^)]*Syria/);
  });
});
