import { z } from 'zod';
import { mcpError, mcpJson } from '../helpers.mjs';

const STATUS = z.enum(['success', 'abstained', 'denied', 'unavailable', 'error', 'cancelled']);
const ENVELOPE = z.object({ schema: z.string() }).passthrough();
const LIVE_PLAN = z.object({ mode: z.literal('live'), status: z.enum(['ready', 'skipped', 'denied']), reason: z.string(), executes: z.literal(false) }).passthrough();
const PATTERN_SUMMARY = z.object({
  id: z.string(),
  version: z.string(),
  status: z.string(),
  primitive: z.string().optional(),
}).passthrough();
const PATTERN_LIST = z.object({
  schema: z.literal('aiwg-decision-pattern-list/v1'),
  patterns: z.array(PATTERN_SUMMARY),
}).passthrough();
const PATTERN_SHOW = z.object({
  schema: z.literal('aiwg-decision-pattern-show/v1'),
  pack: PATTERN_SUMMARY,
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  livePlan: LIVE_PLAN,
}).passthrough();
const COMPACT_EVALUATION = z.object({
  status: STATUS,
  reason: z.string(),
  attempts: z.number(),
  value: z.unknown().nullable(),
}).passthrough();
const COMPACT_RESULT = z.object({
  status: STATUS,
  rulesetStatus: z.string(),
  reason: z.string(),
  matchedRules: z.array(z.string()),
  evaluations: z.record(z.string(), COMPACT_EVALUATION),
  outcome: z.unknown().nullable(),
}).passthrough();
const EVALUATE = z.object({
  schema: z.literal('aiwg-decision-evaluate/v1'),
  status: STATUS,
  reason: z.string(),
  exitCode: z.number(),
  compact: COMPACT_RESULT.nullable().optional(),
  result: z.unknown().nullable(),
}).passthrough();
const VALIDATION = z.object({
  schema: z.literal('aiwg-decision-validation/v1'),
  target: z.enum(['request', 'definition', 'ruleset', 'binding']),
  valid: z.boolean(),
  summary: z.object({
    kind: z.string().nullable().optional(),
    apiVersion: z.string().nullable().optional(),
    id: z.string().nullable().optional(),
    version: z.string().nullable().optional(),
  }).passthrough(),
  errors: z.array(z.string()),
}).passthrough();
const CAPABILITIES = z.object({
  schema: z.literal('aiwg-decision-driver-capabilities/v1'),
  enabled: z.boolean(),
  offlineReady: z.boolean(),
  primitives: z.array(z.string()),
  backend: z.object({ configured: z.boolean(), probed: z.boolean(), status: z.literal('not-probed') }).passthrough(),
}).passthrough();
const OFFLINE_RUN = z.object({
  schema: z.literal('aiwg-decision-offline-run/v1'),
  status: STATUS,
  route: z.enum(['accept', 'review', 'deny']),
  reason: z.string(),
  evaluations: z.array(z.object({
    alias: z.string(),
    primitive: z.string(),
    status: z.string(),
    reason: z.string(),
    attempts: z.number(),
    value: z.unknown(),
  }).passthrough()),
  checks: z.array(z.unknown()),
}).passthrough();
const SYNTHETIC_SETUP = z.object({
  schema: z.literal('aiwg-decision-synthetic-setup/v1'),
  pattern: z.object({ id: z.string(), version: z.string() }).passthrough(),
  files: z.record(z.string(), z.unknown()),
}).passthrough();

let driverPromise;

async function driver() {
  driverPromise ??= import('../../decision/driver.js');
  return driverPromise;
}

function options() {
  return { cwd: process.cwd(), env: process.env };
}

function registerJsonTool(server, name, config, handler, output = ENVELOPE) {
  server.registerTool(name, {
    outputSchema: { result: output },
    ...config,
  }, async (args) => {
    try {
      const result = await handler(args);
      return {
        ...mcpJson(result),
        structuredContent: { result },
      };
    } catch (error) {
      return mcpError(`${name}: ${error.message}`);
    }
  });
}

export function registerDecisionToolset(server) {
  registerJsonTool(server, 'decision-capabilities', {
    title: 'Decision runtime capabilities',
    description: 'Show offline readiness, primitives, experimental features and configured named request profiles.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => (await driver()).decisionCapabilities(options()), CAPABILITIES);

  registerJsonTool(server, 'decision-patterns-list', {
    title: 'List decision patterns',
    description: 'List governed decision pattern packs.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => (await driver()).listPatterns(), PATTERN_LIST);

  registerJsonTool(server, 'decision-pattern-show', {
    title: 'Show decision pattern',
    description: 'Show one pattern pack, schemas and disabled-by-default live plan.',
    inputSchema: { id: z.string().describe('Decision pattern id') },
    annotations: { readOnlyHint: true },
  }, async ({ id }) => (await driver()).showPattern(id), PATTERN_SHOW);

  registerJsonTool(server, 'decision-pattern-offline-run', {
    title: 'Run offline decision pattern fixture',
    description: 'Run a recorded offline fixture through the production decision runtime.',
    inputSchema: { id: z.string(), fixture_id: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ id, fixture_id }) => (await driver()).runOfflinePattern(id, fixture_id), OFFLINE_RUN);

  registerJsonTool(server, 'decision-pattern-live-plan', {
    title: 'Plan live decision pattern',
    description: 'Report whether an explicitly opted-in synthetic live pattern would be ready; does not execute.',
    inputSchema: {
      id: z.string(),
      explicit_opt_in: z.boolean().default(false),
      credential_resolved: z.boolean().default(false),
      egress_approved: z.boolean().default(false),
    },
    annotations: { readOnlyHint: true },
  }, async ({ id, explicit_opt_in, credential_resolved, egress_approved }) => (await driver()).livePlan(id, {
    explicitOptIn: explicit_opt_in,
    credentialResolved: credential_resolved,
    egressApproved: egress_approved,
  }), LIVE_PLAN);

  registerJsonTool(server, 'decision-validate', {
    title: 'Validate decision artifact',
    description: 'Validate a request, definition, ruleset or binding without importing modules or resolving secrets.',
    inputSchema: {
      target: z.enum(['request', 'definition', 'ruleset', 'binding']),
      document: z.unknown().describe('Inline decision document or dispatcher request object'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ target, document }) => (await driver()).validateDecisionValue(target, document, 'mcp-inline'), VALIDATION);

  registerJsonTool(server, 'decision-evaluate-profile', {
    title: 'Evaluate named decision request profile',
    description: 'Evaluate a server-configured named request profile only when env and per-call opt-in are present.',
    inputSchema: {
      profile: z.string().describe('Profile name from AIWG_DECISION_MCP_REQUESTS'),
      opt_in: z.boolean().default(false).describe('Required per-call opt-in'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ profile, opt_in }) => (await driver()).evaluateMcpProfile(profile, opt_in, options()), EVALUATE);

  registerJsonTool(server, 'decision-setup-synthetic-classification', {
    title: 'Prepare synthetic classification artifacts',
    description: 'Return reviewable pinned synthetic classification artifacts and a dispatcher request.',
    inputSchema: {
      allowed_options: z.array(z.string()).min(1).optional(),
      text: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ allowed_options, text }) => (await driver()).syntheticClassificationSetup({ allowedOptions: allowed_options, text }, options()), SYNTHETIC_SETUP);
}
