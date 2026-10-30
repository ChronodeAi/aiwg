// Resolve catalog identities and authorized native paths for the sessions tail verb.
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { readAiwgConfig } from '../../config/aiwg-config.js';
import { createSessionAdapterRegistry } from '../../sessions/adapter-registry.js';
import { assertSessionProviderId, SessionContractError, type Session } from '../../sessions/contracts.js';
import { redactSessionValue } from '../../sessions/policy.js';
import { resolveImportLimits } from '../../sessions/import-limits.js';
import { acquireImportLease, type ImportLease } from '../../sessions/import-lease.js';
import { SessionRepository } from '../../sessions/repository.js';
import { assertTailSupported, tailSession } from '../../sessions/tail.js';
import { defaultDiscoveryManifestPath, readDiscoveryManifest } from '../../sessions/workspace-discovery.js';
import type { ParsedArgs } from './sessions.js';
import type { HandlerContext, HandlerResult } from './types.js';

interface TailContext {
  databasePath(ctx: HandlerContext, args: ParsedArgs): string;
  readAuthorizationContext(ctx: HandlerContext, args: ParsedArgs, operation: string,
    repository: SessionRepository): { workspaceId: string };
}

export async function executeSessionsTail(
  ctx: HandlerContext, args: ParsedArgs, helpers: TailContext,
): Promise<HandlerResult> {
  const json = args.flags.has('--json');
  let repository: SessionRepository | undefined;
  let lease: ImportLease | undefined;
  const controller = new AbortController();
  const stop = () => controller.abort();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  process.on('SIGINT', stop);
  try {
    const latest = args.flags.has('--latest');
    const reference = args.positionals[0];
    const providerInput = args.values.get('--provider');
    if (args.positionals.length > 1 || (latest ? !providerInput || !!reference : !reference)) {
      throw new SessionContractError('INVALID_ARGUMENT',
        'tail requires <session-id> or --provider <p> --latest');
    }
    if (args.flags.has('--import') && (ctx.dryRun || args.flags.has('--dry-run'))) {
      throw new SessionContractError('INVALID_ARGUMENT', 'tail --import cannot be combined with --dry-run');
    }
    const provider = providerInput ? assertSessionProviderId(providerInput) : undefined;
    if (provider) assertTailSupported(createSessionAdapterRegistry().get(provider));
    let database = helpers.databasePath(ctx, args);
    repository = new SessionRepository(database, { readonly: true });
    const workspace = args.values.has('--workspace') || latest
      ? helpers.readAuthorizationContext(ctx, args, 'tail', repository).workspaceId : undefined;
    let matches = latest
      ? repository.listSessions({ provider, workspaceId: workspace, limit: 1 }).items
      : repository.findSessionsByReference(reference!, workspace);
    if (provider) matches = matches.filter(session => session.provider === provider);
    // Account-scoped providers live in the referenced host catalog (#3232).
    const references = repository.listHostSessionReferences().filter(item => !provider || item.provider === provider);
    const hosts = new Set(references.map(item => item.hostCatalog));
    const candidates = matches.map(session => ({ session, database }));
    for (const hostPath of hosts) {
      if (!existsSync(hostPath)) continue;
      const host = new SessionRepository(hostPath, { readonly: true });
      try {
        const allowed = new Set(references.filter(item => item.hostCatalog === hostPath)
          .map(item => item.sessionId));
        const sessions = latest
          ? references.filter(item => item.hostCatalog === hostPath)
            .flatMap(item => host.getSession(item.sessionId) ?? [])
          : host.findSessionsByReference(reference!);
        candidates.push(...sessions.filter(session => allowed.has(session.sessionId))
          .map(session => ({ session, database: hostPath })));
      } finally { host.close(); }
    }
    const selected = latest
      ? candidates.sort((a, b) => (b.session.updatedAt ?? '').localeCompare(a.session.updatedAt ?? '')
        || b.session.sessionId.localeCompare(a.session.sessionId)).slice(0, 1)
      : candidates;
    if (selected.length !== 1) {
      throw new SessionContractError('INVALID_ARGUMENT', selected.length
        ? 'session reference is ambiguous; select --workspace or an internal session ID'
        : 'session not found in the selected catalog and workspace');
    }
    const session = selected[0].session;
    if (selected[0].database !== database) {
      repository.close();
      database = selected[0].database;
      repository = new SessionRepository(database, { readonly: true });
    }
    const source = repository.getSource(session.sourceId);
    if (!source) throw new SessionContractError('SOURCE_NOT_AUTHORIZED', 'catalog source is unavailable');
    const config = await readAiwgConfig(isAbsolute(session.workspaceId) ? session.workspaceId : ctx.cwd);
    const limits = resolveImportLimits(config?.sessions?.import, {
      maxRecordBytes: args.values.get('--max-record-bytes'),
      maxSourceBytes: args.values.get('--max-source-bytes'),
    });
    const adapter = createSessionAdapterRegistry(limits).get(session.provider);
    assertTailSupported(adapter);
    const selectedSource = await resolveTailSource(ctx, args, session, source.locatorClass,
      config?.sessions?.discovery_manifests ?? [],
      resolve(dirname(helpers.databasePath(ctx, args)), 'discovery-manifest.json'));
    const importing = args.flags.has('--import');
    if (importing) {
      repository.close();
      repository = undefined;
      lease = await acquireImportLease(database, `sessions-tail-${process.pid}`);
      repository = new SessionRepository(database);
    }
    const checkpoint = repository.getCheckpoint(source.sourceId, adapter.adapterVersion);
    await tailSession({
      source, selectedSource, adapter, repository, sessionId: session.sessionId,
      workspaceId: session.workspaceId, policyVersion: checkpoint?.policyVersion ?? '1.0.0',
      limits, signal, follow: args.flags.has('--follow'), import: importing,
      onEvent: event => {
        if (json) console.log(JSON.stringify({ contractVersion: '1.0.0', command: 'sessions.tail',
          status: 'ok', data: { event }, error: null }));
        else console.log(`${event.occurredAt ?? '-'} ${session.provider} ${event.kind}: ${event.searchableText}`);
      },
      onPoll: flushStdout,
    });
    await flushStdout();
    return { exitCode: 0 };
  } catch (error) {
    if (signal.aborted) return { exitCode: 0 };
    const cliError = error instanceof Error && 'code' in error && 'exitCode' in error
      ? error as Error & { code: string; exitCode: number } : undefined;
    const code = error instanceof SessionContractError ? error.code
      : cliError ? cliError.code
      : 'code' in Object(error) && (error as { code: string }).code === 'IMPORT_LOCKED'
        ? 'IMPORT_LOCKED' : 'CATALOG_UNAVAILABLE';
    const message = redactSessionValue(error instanceof Error ? error.message : 'session tail failed').value;
    if (json) {
      console.log(JSON.stringify({ contractVersion: '1.0.0', command: 'sessions.tail', status: 'error',
        data: null, error: { code, message } }));
      await flushStdout();
    } else console.error(`${code}: ${message}`);
    return { exitCode: cliError?.exitCode ?? (code === 'UNSUPPORTED_PROVIDER' ? 3 : code === 'INVALID_ARGUMENT' ? 2
      : code === 'IMPORT_LOCKED' ? 7 : code === 'CATALOG_UNAVAILABLE' ? 6 : 5), message };
  } finally {
    process.removeListener('SIGINT', stop);
    repository?.close();
    await lease?.release();
  }
}

async function resolveTailSource(
  ctx: HandlerContext, args: ParsedArgs, session: Session, locatorClass: string, configured: string[],
  catalogManifest: string,
) {
  const workspace = isAbsolute(session.workspaceId) ? session.workspaceId : ctx.cwd;
  // Existing explicit input option also supports older direct imports, whose
  // catalog intentionally never retained the unredacted native pathname.
  const input = args.values.get('--input');
  if (input) {
    const locator = resolve(ctx.cwd, input);
    return { provider: session.provider, sourceId: session.sourceId, nativeSessionId: session.nativeSessionId, locatorClass, locator,
      authorizedScope: { workspaceId: session.workspaceId, allowedRoots: [dirname(locator)] } };
  }
  const paths = args.values.has('--manifest') ? [resolve(ctx.cwd, args.values.get('--manifest')!)] : [
    defaultDiscoveryManifestPath(workspace), defaultDiscoveryManifestPath(ctx.cwd), catalogManifest,
    ...configured.map(path => resolve(workspace, path)),
  ];
  for (const path of new Set(paths)) {
    if (!existsSync(path)) continue;
    const manifest = await readDiscoveryManifest(path);
    const source = manifest.sources.find(item => item.sourceId === session.sourceId
      && item.provider === session.provider && item.locatorClass === locatorClass && item.status !== 'excluded');
    if (source) return { provider: session.provider, sourceId: session.sourceId, nativeSessionId: session.nativeSessionId, locatorClass,
      locator: source.locator, authorizedScope: {
        workspaceId: session.workspaceId, allowedRoots: [source.authorizedRoot],
      } };
  }
  throw new SessionContractError('SOURCE_NOT_AUTHORIZED',
    'native source location is unavailable; pass its saved --manifest or explicitly authorize --input <native-source>');
}

function flushStdout(): Promise<void> {
  return new Promise((resolve, reject) => process.stdout.write('', error => error ? reject(error) : resolve()));
}
