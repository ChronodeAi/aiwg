#!/usr/bin/env node
/** Warp setup uses the same activation selection and budget transaction as aiwg use. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveAIWGRoot } from './warp-content.mjs';
export { generateAIWGContent, mergeWarpMd } from './warp-content.mjs';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = parseArgs();
  const sourceAt = process.argv.indexOf('--source');
  const srcRoot = sourceAt >= 0 ? path.resolve(process.argv[sourceAt + 1]) : resolveAIWGRoot();
  const { deploy } = await import('../agents/providers/warp.mjs');
  await deploy({ ...cfg, srcRoot, provider: 'warp', deployRules: true, deployCommands: true });
}
