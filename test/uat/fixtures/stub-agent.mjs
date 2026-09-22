#!/usr/bin/env node
/**
 * Stub agent for UAT testing.
 *
 * Simulates a successful agent run by printing the completion marker that
 * output-analyzer.mjs recognizes, then exiting 0.
 *
 * Also logs each invocation to a file (UAT_LOG_FILE env var) so tests can
 * assert the agent was actually called.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const logFile = process.env.UAT_LOG_FILE;
if (logFile) {
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    args: process.argv.slice(2),
  }) + '\n');
}

// UAT_STUB_USAGE ("<totalTokens>:<costUsd>") makes the stub report provider usage
// the way a real stream-json provider does, so token and spend ceilings become
// observable through the genuine parse path (#1766). Without it the stub reports
// no usage at all, which is what keeps those dimensions correctly unobservable.
const usageSpec = process.env.UAT_STUB_USAGE;
if (usageSpec) {
  const [rawTokens, rawCost] = usageSpec.split(':');
  const totalTokens = Number(rawTokens);
  const costUsd = Number(rawCost);
  if (!Number.isFinite(totalTokens) || !Number.isFinite(costUsd)) {
    process.stderr.write(`stub-agent: invalid UAT_STUB_USAGE '${usageSpec}' (want "<tokens>:<cost>")\n`);
    process.exit(2);
  }
  const outputTokens = Math.floor(totalTokens / 2);
  process.stdout.write(JSON.stringify({
    type: 'result',
    usage: { input_tokens: totalTokens - outputTokens, output_tokens: outputTokens },
    total_cost_usd: costUsd,
  }) + '\n');
}

const output = process.env.UAT_STUB_OUTPUT || 'Ralph Loop: SUCCESS\nTask complete.\n';
process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
process.exit(0);
