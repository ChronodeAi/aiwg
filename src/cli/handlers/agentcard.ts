/**
 * AgentCard CLI handler — `aiwg agentcard <verb> ...`.
 *
 * Verbs:
 *   verify  Fetch an agentic-sandbox AgentCard from the well-known route,
 *           /v1/extendedAgentCard, or legacy /v1/card, then verify its
 *           Ed25519 JWS signature against a supplied JWKS.
 *
 * @implements @src/a2a/agent-card.ts
 * @issue #1253
 */

import { fetchAgentCard } from '../../a2a/agent-card.js';
import { resolveSensitiveInput, sensitiveInputOptions } from '../../auth/sensitive-input.js';
import { loadJwkSet } from '../../a2a/jws.js';
import { AiwgError, EXIT_CODES, handlerResultFromError } from '../errors.js';
import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';

interface VerifyArgs {
  host: string;
  instance: string;
  jwks?: string;
  bearer?: string;
  skipVerify: boolean;
  json: boolean;
}

function parseVerifyArgs(args: string[]): VerifyArgs {
  const get = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
    return undefined;
  };

  const host = get('--host');
  const instance = get('--instance');
  if (!host) {
    throw new AiwgError({
      code: 'ERR_AGENTCARD_MISSING_HOST',
      message: 'Missing --host',
      exitCode: EXIT_CODES.USAGE,
      hint: 'Example: aiwg agentcard verify --host https://exec.test --instance inst-1 --jwks /path/to/jwks.json',
    });
  }
  if (!instance) {
    throw new AiwgError({
      code: 'ERR_AGENTCARD_MISSING_INSTANCE',
      message: 'Missing --instance',
      exitCode: EXIT_CODES.USAGE,
      hint: 'Example: aiwg agentcard verify --host https://exec.test --instance inst-1 --jwks /path/to/jwks.json',
    });
  }

  const jwks = get('--jwks');
  const bearer = get('--bearer');
  if (args.includes('--bearer') && (!bearer || bearer.startsWith('--'))) {
    throw new AiwgError({ code: 'ERR_AGENTCARD_BEARER', message: '--bearer requires a value; prefer --bearer-stdin, --bearer-file, --bearer-store or --bearer-env.', exitCode: EXIT_CODES.USAGE });
  }
  const skipVerify = args.includes('--skip-verify');
  const json = args.includes('--json');

  if (!jwks && !skipVerify) {
    throw new AiwgError({
      code: 'ERR_AGENTCARD_MISSING_JWKS',
      message: '--jwks is required unless --skip-verify is set',
      exitCode: EXIT_CODES.USAGE,
      hint: 'Provide a JWKS file path or URL; or pass --skip-verify to bypass signature verification.',
    });
  }

  const result: VerifyArgs = { host, instance, skipVerify, json };
  if (jwks !== undefined) result.jwks = jwks;
  if (bearer !== undefined) result.bearer = bearer;
  return result;
}

async function loadJwksFromSource(source: string): Promise<ReturnType<typeof loadJwkSet>> {
  if (/^https?:\/\//i.test(source)) {
    const resp = await fetch(source);
    if (resp.status !== 200) {
      throw new AiwgError({
        code: 'ERR_AGENTCARD_JWKS_FETCH',
        message: `JWKS fetch failed: ${source} returned ${resp.status}`,
        exitCode: EXIT_CODES.GENERAL,
      });
    }
    return loadJwkSet(await resp.text());
  }
  const { readFile } = await import('node:fs/promises');
  return loadJwkSet(await readFile(source, 'utf8'));
}

async function handleVerify(args: string[]): Promise<HandlerResult> {
  const parsed = parseVerifyArgs(args);
  const sources = sensitiveInputOptions(args, 'bearer');
  const hasSource = sources.interactive || sources.stdin || sources.file !== undefined || sources.store !== undefined || sources.env !== undefined;
  if (parsed.bearer !== undefined) {
    console.error('Warning: --bearer is deprecated and exposes the value on argv; use --bearer-interactive, --bearer-stdin, --bearer-file, --bearer-store or --bearer-env.');
  }
  // No source intentionally means public/unauthenticated access, even at a TTY.
  const bearer = hasSource
    ? await resolveSensitiveInput(sources)
    : parsed.bearer === undefined ? undefined : await resolveSensitiveInput(
      { prefix: 'bearer', env: 'LEGACY_BEARER' }, { readEnv: () => parsed.bearer });
  const redact = (text: string): string => bearer ? text.split(bearer).join('[REDACTED]') : text;
  const log = (text: string): void => console.log(redact(text));
  const error = (text: string): void => console.error(redact(text));
  const jsonReplacer = (_key: string, value: unknown): unknown => typeof value === 'string' ? redact(value) : value;

  const opts: Parameters<typeof fetchAgentCard>[2] = {
    skipVerify: parsed.skipVerify,
  };
  if (bearer !== undefined) opts.bearer = bearer;

  let verified: Awaited<ReturnType<typeof fetchAgentCard>>;
  try {
    if (parsed.jwks !== undefined && !parsed.skipVerify) {
      opts.jwks = await loadJwksFromSource(parsed.jwks);
    }
    verified = await fetchAgentCard(parsed.host, parsed.instance, opts);
  } catch (err) {
    const message = (err as Error).message;
    if (parsed.json) {
      log(
        JSON.stringify(
          {
            ok: false,
            host: parsed.host,
            instance: parsed.instance,
            error: message,
          },
          jsonReplacer,
          2
        )
      );
    } else {
      error(`AgentCard verification FAILED for ${parsed.host}/${parsed.instance}`);
      error(`  ${message}`);
    }
    return { exitCode: EXIT_CODES.GENERAL };
  }

  if (parsed.json) {
    log(
      JSON.stringify(
        {
          ok: true,
          host: parsed.host,
          instance: parsed.instance,
          verifiedAt: verified.verifiedAt,
          kid: verified.kid,
          skipVerify: parsed.skipVerify,
          card: {
            name: verified.card.name,
            protocolVersion: verified.card.protocolVersion,
            url: verified.card.url,
            version: verified.card.version,
            preferredTransport: verified.card.preferredTransport,
            capabilities: verified.card.capabilities,
            skills: verified.card.skills,
          },
        },
        jsonReplacer,
        2
      )
    );
  } else {
    const banner = parsed.skipVerify ? '(verification SKIPPED)' : 'VERIFIED';
    log(`AgentCard ${banner} for ${parsed.host}/${parsed.instance}`);
    log(`  name:               ${verified.card.name}`);
    log(`  protocolVersion:    ${verified.card.protocolVersion}`);
    log(`  url:                ${verified.card.url}`);
    log(`  version:            ${verified.card.version}`);
    if (verified.card.preferredTransport) {
      log(`  preferredTransport: ${verified.card.preferredTransport}`);
    }
    if (verified.kid) {
      log(`  signing kid:        ${verified.kid}`);
    }
    log(`  verifiedAt:         ${verified.verifiedAt}`);
    const exts = verified.card.capabilities?.extensions ?? [];
    if (exts.length > 0) {
      log(`  extensions:`);
      for (const e of exts) {
        const tag = e.required ? '[required]' : '[optional]';
        log(`    ${tag} ${e.uri}`);
      }
    }
    const skills = verified.card.skills ?? [];
    if (skills.length > 0) {
      log(`  skills (${skills.length}):`);
      for (const s of skills.slice(0, 5)) {
        log(`    - ${s.id}${s.name ? ' (' + s.name + ')' : ''}`);
      }
      if (skills.length > 5) log(`    ... and ${skills.length - 5} more`);
    }
  }
  return { exitCode: 0 };
}

function printUsage(): void {
  console.log('Usage: aiwg agentcard <verb> [options]');
  console.log('');
  console.log('Verbs:');
  console.log('  verify  Fetch and verify an AgentCard JWS signature');
  console.log('');
  console.log('verify options:');
  console.log('  --host <url>        Executor host (e.g. https://exec.test)');
  console.log('  --instance <id>     Instance id (UUIDv7)');
  console.log('  --jwks <path|url>   JWKS file path or URL (required unless --skip-verify)');
  console.log('  --bearer-interactive  Read optional bearer in a terminal without echo');
  console.log('  --bearer-stdin        Read optional bearer from piped stdin');
  console.log('  --bearer-file <path>  Read optional bearer from an owner-only private file');
  console.log('  --bearer-store <name> Read optional bearer from a named OS store entry');
  console.log('  --bearer-env <NAME>   Read optional bearer from a named shell variable');
  console.log('  --bearer <token>      Deprecated: exposes the value on argv');
  console.log('  --skip-verify       Skip JWS verification (NOT recommended)');
  console.log('  --json              Emit JSON output');
}

/**
 * agentcard command handler — dispatches on the first positional arg.
 */
export const agentcardHandler: CommandHandler = {
  id: 'agentcard',
  name: 'AgentCard',
  description: 'Fetch and verify an agentic-sandbox AgentCard',
  category: 'toolsmith',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const args = ctx.args;
      const verb = args[0];
      if (!verb || verb === '--help' || verb === '-h') {
        printUsage();
        return { exitCode: verb ? 0 : EXIT_CODES.USAGE };
      }
      const rest = args.slice(1);
      switch (verb) {
        case 'verify':
          return await handleVerify(rest);
        default:
          throw new AiwgError({
            code: 'ERR_AGENTCARD_UNKNOWN_VERB',
            message: `Unknown verb: ${verb}`,
            exitCode: EXIT_CODES.USAGE,
            hint: "Run 'aiwg agentcard --help' for usage.",
          });
      }
    } catch (err) {
      return handlerResultFromError(err as Error);
    }
  },
};
