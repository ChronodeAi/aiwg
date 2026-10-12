#!/usr/bin/env node

import { deployKernelQuickref } from '../pm-os-codex-deployer.mjs';

try {
  process.exitCode = deployKernelQuickref(process.argv.slice(2));
} catch (error) {
  console.error(`[pm-os codex skills] ${error.message}`);
  process.exitCode = 2;
}
