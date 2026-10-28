// Runs storage migrate through the protocol copy coordinator and preserves CLI output.
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { projectAiwgPath } from '../config/project-artifacts.js';
import { STORAGE_MIGRATION_PROTOCOL, StorageMigrationCoordinator, type MigrationCopyCheckpoint, type MigrationEndpointIdentity } from './migration-protocol.js';
import type { MigrationCopyAction, MigrationCopyItem } from './migration-copy.js';
import { isTextCorpusEntry, migrationEndpoint } from './migration-adapter.js';
import { sha256, stableStringify } from './migration-records.js';
import {
  buildAdapter, describeSpec, expandFsLocation, locationsEqual, parseMigrateArgs, specSlug, type BackendSpec,
} from './cli-migrate-options.js';

export async function handleMigrate(projectRoot: string, args: string[]): Promise<void> {
  const opts = parseMigrateArgs(args);
  if (locationsEqual(opts.from, opts.to, projectRoot)) {
    throw new Error(
      `Refusing to migrate: source and destination resolve to the same location.\n  ${describeSpec(opts.from)}\n  ${describeSpec(opts.to)}`,
    );
  }
  const source = buildAdapter(opts.subsystem, opts.from, projectRoot);
  const destination = buildAdapter(opts.subsystem, opts.to, projectRoot);
  const identity = (spec: BackendSpec): MigrationEndpointIdentity => ({
    backend: spec.type, instance: stableStringify({
      location: spec.type === 'fortemi' ? spec.location : expandFsLocation(spec.location, projectRoot),
      folder: spec.folder ?? '',
    }), tenant: projectRoot, subsystem: opts.subsystem, schemaVersion: '1',
  });
  const sourceEndpoint = migrationEndpoint(source, identity(opts.from));
  const destinationEndpoint = migrationEndpoint(destination, identity(opts.to));
  const migrationLogPath = projectAiwgPath(projectRoot, '.storage-cache', 'migrations',
    `${opts.subsystem}-${specSlug(opts.from)}-to-${specSlug(opts.to)}.jsonl`);
  // Bind checkpoint filenames to full, resolved identities, folders and selection policy.
  const binding = sha256(stableStringify([sourceEndpoint.identity, destinationEndpoint.identity, opts.textOnly]));
  const checkpointPath = `${migrationLogPath}.${binding}.checkpoint.json`;
  const receiptPath = `${checkpointPath}.receipt.json`;
  try {
    if (source.init) await source.init();
    if (!opts.dryRun && destination.init) await destination.init();
    console.log(`storage migrate (${opts.dryRun ? 'DRY RUN' : 'live'})`);
    console.log(`  subsystem: ${opts.subsystem}`);
    console.log(`  from:      ${describeSpec(opts.from)}`);
    console.log(`  to:        ${describeSpec(opts.to)}`);
    console.log('');
    const checkpoint = await loadCheckpoint(checkpointPath);
    const result = await StorageMigrationCoordinator.copy({
      source: sourceEndpoint, destination: destinationEndpoint, checkpoint, dryRun: opts.dryRun,
      exclude: path => opts.textOnly && !isTextCorpusEntry(path) ? 'non-text attachment skipped' : undefined,
      async save(value) {
        await atomicJson(checkpointPath, value);
        await atomicJson(receiptPath, { protocol: value.protocol, migrationId: value.migrationId, ...value.receipt });
      },
      async report(action: MigrationCopyAction, item: MigrationCopyItem) {
        if (action === 'errored') console.log(`  ✗ ${item.path} (${item.reason})`);
        else if (action === 'skipped') {
          const marker = item.reason === 'already migrated, skipped' ? '✓' : '·';
          console.log(`  ${marker} ${item.path} (${item.reason})`);
        } else if (opts.dryRun) {
          console.log(`  → ${item.path} (would ${action === 'deleted' ? 'delete' : 'copy'})`);
        } else {
          console.log(`  ✓ ${item.path}${action === 'copied' ? '' : ` (${action}: ${item.reason})`}`);
          await mkdir(dirname(migrationLogPath), { recursive: true });
          await appendFile(migrationLogPath, JSON.stringify({
            path: item.path, ts: new Date().toISOString(), action, reason: item.reason, protocol: STORAGE_MIGRATION_PROTOCOL,
          }) + '\n', 'utf-8');
        }
      },
    });
    const receipt = result.receipt;
    const unsupported = receipt.skipped.filter(item => item.reason === 'non-text attachment skipped').length;
    const copied = receipt.copied.length + receipt.recopied.length;
    const skipped = receipt.skipped.length - unsupported;
    if (!result.plan.length) console.log('No entries to migrate.');
    console.log('');
    console.log(`Summary: copied=${copied} skipped=${skipped} unsupported=${unsupported} ` +
      `errored=${receipt.errored.length} total=${result.plan.length} ` +
      `recopied=${receipt.recopied.length} deleted=${receipt.deleted.length}`);
    if (!opts.dryRun) {
      console.log(`Migration log: ${migrationLogPath}`);
      console.log(`Migration checkpoint: ${checkpointPath}`);
      console.log(`Migration receipt: ${receiptPath}`);
    }
    if (receipt.errored.length) {
      throw new Error(`${receipt.errored.length} entr${receipt.errored.length === 1 ? 'y' : 'ies'} failed to migrate.`);
    }
  } finally {
    await Promise.allSettled([source.close?.(), destination.close?.()]);
  }
}

async function loadCheckpoint(path: string): Promise<MigrationCopyCheckpoint | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as MigrationCopyCheckpoint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf-8');
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
