#!/usr/bin/env node

import { deployCommandAdapters } from '../pm-os-codex-deployer.mjs';

try {
  process.exitCode = deployCommandAdapters(process.argv.slice(2));
} catch (error) {
  console.error(`[pm-os codex commands] ${error.message}`);
  process.exitCode = 2;
}
