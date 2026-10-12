import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommandHandler } from './types.js';
import { renderBotHandoff } from '../../providers/bot-handoff.js';
import { providerCommandOptions } from './provider-command-options.js';

export const botHandoffHandler: CommandHandler = {
  id: 'bot-handoff', name: 'Bot Handoff', category: 'utility', aliases: [],
  description: 'Generate provider-aware review drafts and let the selected provider handle native execution',
  async help() {
    return { exitCode: 0, rawOutput: true, message: [
      'aiwg bot-handoff --input <proposal.json> [--provider <id>] [--dry-run]',
      'Supports every registered provider. Uses the active provider if unambiguous; specify --provider in CI.',
      'Prints a Markdown review draft to stdout. Does not write provider state or call a product API.',
      'Fields: surface (routines|teammates|connectors|memory), name, summary (max 280 characters), references (1–10 pointers).',
      'Routines also require schedule and timezone. Use an IANA timezone, e.g. America/New_York.',
      'References: file paths, HTTP(S) URLs without credentials/query/fragment, or aiwg show pointers.',
      'Only the supplied JSON is read. Referenced sources are never read or executed. Do not include secrets.',
      'See docs/integrations/bot-handoff.md for examples and artifact export.',
    ].join('\n') };
  },
  async execute(ctx) {
    try {
      const { provider, flags } = await providerCommandOptions(ctx.args.filter(arg => arg !== '--dry-run'), ctx.cwd, ['--input']);
      if (!flags['--input']) throw new Error('Input is required');
      const source = await readFile(path.resolve(ctx.cwd, flags['--input']), 'utf8');
      if (Buffer.byteLength(source) > 16_384) throw new Error('Proposal too large');
      return { exitCode: 0, rawOutput: true, message: renderBotHandoff(JSON.parse(source), provider) };
    } catch {
      return { exitCode: 1, message: 'Cannot generate handoff: select a registered --provider and check the proposal file/options with --help. Input content is omitted.' };
    }
  },
};
