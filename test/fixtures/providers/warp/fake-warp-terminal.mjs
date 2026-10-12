#!/usr/bin/env node
/**
 * Synthetic stand-in for `warp-terminal` (Oz v0.2026.10.07.08.29.stable_00,
 * roctinam/aiwg#2905). Implements only the live, no-model-probed argv
 * contract plus explicit fixture assumptions used by the direct-shell profile:
 *
 *   warp-terminal agent run --output-format json --model M --cwd DIR \
 *     --skill aiwg-brief-<invocation-id> --no-snapshot
 *   warp-terminal --version | --help
 *
 * No network, model, credential or real Warp/Oz code is involved. This
 * fixture REQUIRES the exact safe values the profile emits and refuses
 * every other documented value (never-emitted cloud/harness/bypass flags,
 * a wrong `--output-format`, an unknown model, a mismatched `--skill`), so
 * a drifted profile fails the test instead of silently "passing". The
 * scenario and record path come from the JSON file named by
 * AIWG_FAKE_WORKER_CONFIG ({ scenario, recordPath, knownModels, ... });
 * without it the success scenario runs and nothing is recorded.
 */
import { readFileSync, writeFileSync, writeSync } from 'node:fs';

const config = process.env.AIWG_FAKE_WORKER_CONFIG
  ? JSON.parse(readFileSync(process.env.AIWG_FAKE_WORKER_CONFIG, 'utf8')) : {};
const scenario = config.scenario ?? 'success';
const args = process.argv.slice(2);

let recorded = false;
function record(extra) {
  if (recorded || !config.recordPath) return;
  recorded = true;
  writeFileSync(config.recordPath, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(),
    envNames: Object.keys(process.env).sort(), pid: process.pid, ...extra }), { mode: 0o600 });
}

function fail(message, code = 1) {
  record({ error: message });
  // Flush refusal evidence before immediate exit, including when stderr is a pipe.
  writeSync(2, `error: ${message}\n`);
  process.exit(code);
}

if (!args.length || args[0] === '--help' || args[0] === 'help') {
  process.stdout.write('Usage: warp-terminal [OPTIONS] [COMMAND]\n');
  process.exit(0);
}
if (args[0] === '--version') {
  process.stdout.write('Oz v0.2026.10.07.08.29.stable_00\n');
  process.exit(0);
}

// Never-emitted cloud/third-party/bypass flags: the fixture refuses them
// outright so a drifted profile that ever emits one fails loudly.
const REFUSED_FLAGS = ['--environment', '-e', '--harness', '--team', '--dangerously-skip-permissions', '--api-key',
  '--saved-prompt', '--task-id', '--conversation'];
for (const flag of REFUSED_FLAGS) {
  if (args.some(arg => arg === flag || arg.startsWith(`${flag}=`))) fail(`refused: ${flag} is never part of the direct-shell profile`);
}

if (args[0] !== 'agent' || args[1] !== 'run') fail(`unknown subcommand: ${args.slice(0, 2).join(' ')}`);

let outputFormat = null, model = null, cwd = null, skill = null, prompt, noSnapshot = false;
for (let i = 2; i < args.length;) {
  const arg = args[i];
  if (arg === '--no-snapshot') {
    noSnapshot = true; i += 1;
  } else if (arg === '--output-format') {
    const next = args[i + 1];
    if (next === undefined || next.startsWith('-')) fail("a value is required for '--output-format <OUTPUT_FORMAT>' but none was supplied");
    outputFormat = next; i += 2;
  } else if (arg === '--model') {
    const next = args[i + 1];
    if (next === undefined || next.startsWith('-')) fail("a value is required for '--model <MODEL_ID>' but none was supplied");
    model = next; i += 2;
  } else if (arg === '--cwd' || arg === '-C') {
    const next = args[i + 1];
    if (next === undefined || next.startsWith('-')) fail("a value is required for '--cwd <CWD>' but none was supplied");
    cwd = next; i += 2;
  } else if (arg === '--skill') {
    const next = args[i + 1];
    if (next === undefined || next.startsWith('-')) fail("a value is required for '--skill <SKILL>' but none was supplied");
    skill = next; i += 2;
  } else if (arg === '--prompt' || arg === '-p') {
    const next = args[i + 1];
    if (next === undefined || next.startsWith('-')) fail("a value is required for '--prompt <PROMPT>' but none was supplied");
    prompt = next; i += 2;
  } else {
    fail(`unknown flag: ${arg}`);
  }
}

if (!['json', 'ndjson', 'pretty', 'text'].includes(outputFormat)) fail(`invalid value '${outputFormat}' for '--output-format <OUTPUT_FORMAT>' [possible values: json, ndjson, pretty, text]`);
if (outputFormat !== 'json') fail('this fixture only honors the profile-emitted --output-format json');
if (typeof prompt === 'string') fail('refused: --prompt is never part of the direct-shell profile (brief text never rides on argv)');
if (!skill) {
  fail("the following required arguments were not provided:\n  <--prompt <PROMPT>|--saved-prompt <SAVED_PROMPT>|--task-id <TASK_ID>|--skill <SKILL>>");
}
if (!/^aiwg-brief-[a-z0-9][a-z0-9-]{0,51}$/.test(skill)) fail(`unknown skill: ${skill}`);
if (!noSnapshot) fail('refused: --no-snapshot is required to disable workspace snapshot upload');
if (Array.isArray(config.knownModels) && !config.knownModels.includes(model)) fail(`unknown model: ${model ?? '(no model)'}`);
if (typeof cwd !== 'string' || !cwd) fail('a value is required for \'--cwd <CWD>\' but none was supplied');

// FIXTURE ASSUMPTION: model a missing skill as a failure. The real CLI's
// search root relative to --cwd and missing-skill behavior are UNVERIFIED;
// all real skill probes stopped at login. This is not live CLI evidence.
if (config.skillFileExists === false) {
  fail(`skill not found: ${skill} (searched .agents/skills, .warp/skills, .claude/skills, .codex/skills)`);
}

// Simulates the real, unauthenticated host: every probe on noodle stopped
// here before any of the above business logic even if requested.
if (config.simulateAuthGate) {
  fail('you are not logged in - please log in with `warp-terminal login` to continue.');
}

record({ outputFormat, model, cwd, skill, noSnapshot });

switch (scenario) {
  case 'success':
    process.stdout.write(`${JSON.stringify({ reply: 'synthetic warp reply' })}\n`);
    process.exit(0);
    break;
  case 'claims': {
    const claims = config.claimsPayload ?? { version: 1, status: 'completed', summary: 'synthetic claims summary',
      claims: [], artifacts: [], checks: [], limitations: [] };
    process.stdout.write(`${JSON.stringify(claims)}\n`);
    process.exit(0);
    break;
  }
  case 'malformed':
    process.stdout.write('{"reply": "unterminat');
    process.exit(0);
    break;
  case 'array-output':
    process.stdout.write('[1,2,3]\n');
    process.exit(0);
    break;
  case 'error-output':
    process.stdout.write('{"error":"synthetic failure"}\n');
    process.exit(0);
    break;
  case 'plain-text':
    process.stdout.write('synthetic plain text reply\n');
    process.exit(0);
    break;
  case 'empty-output':
    process.exit(0);
    break;
  case 'crash-mid':
    process.stdout.write('{"reply": "partial"');
    process.exit(1);
    break;
  case 'hang':
    setInterval(() => {}, 1000);
    break;
  default:
    fail(`unknown fixture scenario ${scenario}`, 64);
}
