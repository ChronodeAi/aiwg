#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';

const frameworkRoot = process.env.AIWG_ROOT
  ? path.resolve(process.env.AIWG_ROOT)
  : path.resolve(import.meta.dirname, '../../../../../../..');
const tool = path.join(frameworkRoot, 'tools/quality/health.mjs');
const result = spawnSync(process.execPath, [tool, ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
