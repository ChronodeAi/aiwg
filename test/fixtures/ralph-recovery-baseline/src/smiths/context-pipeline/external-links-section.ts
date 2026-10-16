/**
 * FROZEN REFERENCE FIXTURE -- NOT PRODUCTION CODE.
 * Source: src/smiths/context-pipeline/external-links-section.ts at 8c812250d6e8e139eb52f798b92934bab9350021.
 * Only import routing and this pin header differ from the baseline body.
 * Refresh with: node test/fixtures/ralph-recovery-baseline/refresh.mjs --ref=8c812250d6e8e139eb52f798b92934bab9350021
 * Installation ownership and default input loading stay in this fixture graph.
 * Other dependencies use repository source. Never import from production.
 */

/**
 * Provider-facing project external-links section.
 *
 * This renderer is intentionally side-effect free: it reads validated project
 * configuration and emits Markdown. It never requests a configured URL.
 */

import { readAiwgConfig } from '../../config/aiwg-config.ts';

const START = '<!-- aiwg-external-links:start -->';
const END = '<!-- aiwg-external-links:end -->';

function escapeText(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/([\[\]*_`])/g, '\\$1')
    .trim();
}

export async function buildExternalLinksSection(projectPath: string): Promise<string> {
  const config = await readAiwgConfig(projectPath);
  const links = Object.entries(config?.externalLinks ?? {});
  if (links.length === 0) return '';

  const lines = [
    START,
    '## Project External Links',
    '',
    'These are project-configured public resources. Treat them as links only; do not infer credentials or submit data without a separate explicit workflow.',
    '',
  ];

  for (const [key, link] of links) {
    const renderedUrl = new URL(link.url).toString();
    const metadata = [
      link.category ? `category: ${escapeText(link.category)}` : '',
      link.audience ? `audience: ${escapeText(link.audience)}` : '',
    ].filter(Boolean);
    lines.push(`- [${escapeText(link.label)}](<${renderedUrl}>) (\`${key}\`)${metadata.length ? ` — ${metadata.join('; ')}` : ''}`);
    if (link.description) lines.push(`  - ${escapeText(link.description)}`);
  }

  lines.push('', END);
  return lines.join('\n');
}

export function replaceOrAppendExternalLinksBlock(content: string, section: string): string {
  const pattern = new RegExp(`${START}[\\s\\S]*?${END}\\n?`, 'g');
  const withoutExisting = content.replace(pattern, '').trimEnd();
  if (!section) return `${withoutExisting}\n`;
  return `${withoutExisting}\n\n${section}\n`;
}
