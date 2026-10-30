import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import type { SensitiveInputDependencies } from '../../../src/auth/sensitive-input.js';
import { PostgresStorageBackend } from '../../../src/storage/backends/postgres.js';
import { PostgrestStorageBackend } from '../../../src/storage/backends/postgrest.js';
import { loadFeaturePackage } from '../../../src/features/runtime.js';
import { LogseqAdapter } from '../../../src/storage/backends/logseq.js';

vi.mock('../../../src/features/runtime.js', () => ({ loadFeaturePackage: vi.fn() }));

const secret = 'logseq-fixture-token';
const roots: string[] = [];
let graph: string;
let output: string[];
let http: ReturnType<typeof vi.fn>;
let spawn: ReturnType<typeof vi.spyOn>;
let execFile: ReturnType<typeof vi.spyOn>;
function fixture(value = secret): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aiwg-storage-credential-'));
  roots.push(root);
  const file = path.join(root, 'private');
  writeFileSync(file, value, { mode: 0o600 });
  return file;
}
beforeEach(() => {
  graph = path.dirname(fixture());
  output = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(value => { output.push(String(value)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(value => { output.push(String(value)); return true; });
  for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...values) => { output.push(values.map(String).join(' ')); });
  }
  spawn = vi.spyOn(childProcess, 'spawn');
  execFile = vi.spyOn(childProcess, 'execFile');
  http = vi.fn(async () => new Response('null', { status: 200 }));
  vi.stubGlobal('fetch', http);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(reference?: string, dependencies: SensitiveInputDependencies = {}): Promise<unknown> {
  return new LogseqAdapter({ type: 'logseq', graph, apiTokenEnv: reference }, dependencies).init();
}
function assertPrivate(values = [secret]) {
  for (const value of values) {
    expect(output.join('')).not.toContain(value);
    expect(JSON.stringify(process.argv)).not.toContain(value);
  }
  // Backends use in-process drivers/HTTP. Store IO is injected.
  expect(spawn).not.toHaveBeenCalled();
  expect(execFile).not.toHaveBeenCalled();
  expect(JSON.stringify(process.argv)).not.toContain(secret);
}
async function failure(operation: Promise<unknown>, pattern: RegExp, values = [secret]) {
  const error = await operation.then(() => undefined, (error: Error) => error);
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).toMatch(pattern);
  for (const value of values) expect(`${error!.stack} ${JSON.stringify(error)}`).not.toContain(value);
  assertPrivate(values);
  return error;
}

describe('Logseq storage credential references (#3079)', () => {
  it('reads a private file without exposing the value on argv or output', async () => {
    await run(`file:${fixture()}`);
    expect(http.mock.calls.at(-1)?.[1].headers).toMatchObject({ Authorization: `Bearer ${secret}` });
    assertPrivate();
  });

  it('uses only the selected native store entry without prompting or falling back', async () => {
    const readStore = vi.fn(async () => secret);
    const prompt = vi.fn(async () => { throw new Error('unexpected prompt'); });
    await run('store:fixture-storage', { readStore, prompt, isTTY: true, environment: { LOGSEQ_API_TOKEN: 'unused' } });
    expect(readStore).toHaveBeenCalledExactlyOnceWith('fixture-storage');
    expect(prompt).not.toHaveBeenCalled();
    await failure(run('store:fixture-storage', { readStore: async () => null }), /no key/);
    await failure(run('store:fixture-storage', { readStore: async () => { throw new Error(secret); } }), /store entry could not be read/);
    assertPrivate();
  });

  it.each([0o640, 0o604])('rejects private-file mode %s', async mode => {
    const file = fixture();
    chmodSync(file, mode);
    await failure(run(`file:${file}`), /group or other access/);
    expect(http).not.toHaveBeenCalled();
  });

  it('rejects symlinks and hard links before delivering a credential', async () => {
    const file = fixture();
    symlinkSync(file, `${file}.symlink`);
    await failure(run(`file:${file}.symlink`), /symlink/);
    linkSync(file, `${file}.hardlink`);
    await failure(run(`file:${file}`), /hard link/);
  });

  it('rejects files owned by another user', async () => {
    const file = fixture();
    const uid = process.getuid!();
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    await failure(run(`file:${file}`), /not owned by the current user/);
  });

  it('preserves the legacy environment value and default selector', async () => {
    await run(undefined, { environment: { LOGSEQ_API_TOKEN: secret } });
    expect(http.mock.calls.at(-1)?.[1].headers).toMatchObject({ Authorization: `Bearer ${secret}` });
    assertPrivate();
  });

  it('names the configuration choices for a missing explicit environment value', async () => {
    await failure(run('FIXTURE_MISSING', { environment: {} }), /ENV_NAME.*file:ABSOLUTE_PATH.*store:NAME/);
  });
});

describe('Logseq storage error boundaries (#3079)', () => {
  it('keeps the optional Logseq missing-token fallback and ignores unused references', async () => {
    await run(undefined, { environment: {} });
    expect(output.join('')).toContain('LOGSEQ_API_TOKEN is not set');
    await new LogseqAdapter({ type: 'logseq', graph, useApi: false, apiTokenEnv: 'file:/missing' }).init();
    expect(http).not.toHaveBeenCalled();
  });

  it('keeps reflected Logseq HTTP errors out of its fallback warning', async () => {
    http.mockRejectedValueOnce(new Error(secret));
    await run(`file:${fixture()}`);
    expect(output.join('')).toContain('not reachable');
    assertPrivate();
  });
});


const password = 'fixture-postgres-password';
const connectionString = `postgresql://fixture:${password}@127.0.0.1:5432/fixture`;
const authorization = 'Bearer AIWG_FIXTURE_AUTHORIZATION';
const credentials = [connectionString, password, authorization, 'AIWG_FIXTURE_AUTHORIZATION'];
const identity = { tenant: 'fixture', subsystem: 'memory' };

function postgres(reference?: string, dependencies: SensitiveInputDependencies = {}) {
  return new PostgresStorageBackend({ ...identity, ssl: 'disable', connectionStringEnv: reference }, dependencies);
}
function postgrest(reference?: string, dependencies: SensitiveInputDependencies = {}) {
  return new PostgrestStorageBackend({ ...identity, baseUrl: 'http://127.0.0.1:3000', authorizationEnv: reference }, dependencies);
}
function driver() {
  const query = vi.fn(async () => ({ rows: [{ schema_version: 1 }], rowCount: 1 }));
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client), end: vi.fn(async () => undefined), on: vi.fn() };
  const Pool = vi.fn(function () { return pool; });
  vi.mocked(loadFeaturePackage).mockResolvedValue({ Pool });
  return { Pool, pool, client };
}

describe('PostgreSQL and PostgREST credential references (#3620)', () => {
  beforeEach(() => {
    driver();
    http.mockImplementation(async () => new Response('{"schemaVersion":"1","ready":true}', { status: 200 }));
  });

  it('delivers private file values only to the driver and Authorization header', async () => {
    const { Pool } = driver();
    const pg = postgres(`file:${fixture(connectionString)}`);
    await pg.init();
    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ connectionString }));
    await pg.close();
    await postgrest(`file:${fixture(authorization)}`).init();
    expect(http.mock.calls.at(-1)?.[1].headers).toMatchObject({ Authorization: authorization });
    assertPrivate(credentials);
  });

  it('preserves default and explicit raw environment lookups and optional unauthenticated HTTP', async () => {
    const { Pool } = driver();
    for (const reference of [undefined, 'FIXTURE_DATABASE']) {
      const pg = postgres(reference, { environment: { [reference ?? 'AIWG_POSTGRES_URL']: connectionString } });
      await pg.init();
      await pg.close();
    }
    expect(Pool).toHaveBeenCalledTimes(2);
    expect(Pool).toHaveBeenLastCalledWith(expect.objectContaining({ connectionString }));
    await postgrest('FIXTURE_AUTH', { environment: { FIXTURE_AUTH: authorization } }).init();
    expect(http.mock.calls.at(-1)?.[1].headers.Authorization).toBe(authorization);
    await postgrest().init();
    expect(http.mock.calls.at(-1)?.[1].headers.Authorization).toBeUndefined();
    assertPrivate(credentials);
  });

  it.each(['postgres', 'postgrest'] as const)('%s selects a store without prompting or falling back', async kind => {
    const value = kind === 'postgres' ? connectionString : authorization;
    const readStore = vi.fn(async () => value);
    const prompt = vi.fn(async () => { throw new Error('unexpected prompt'); });
    const create = kind === 'postgres' ? postgres : postgrest;
    const backend = create('store:fixture-db', { readStore, prompt, isTTY: true });
    await backend.init();
    if (backend instanceof PostgresStorageBackend) await backend.close();
    expect(readStore).toHaveBeenCalledExactlyOnceWith('fixture-db');
    expect(prompt).not.toHaveBeenCalled();
    for (const missing of [null, '']) {
      await failure(create('store:fixture-db', { readStore: async () => missing, prompt, isTTY: true,
        environment: { AIWG_POSTGRES_URL: connectionString, FIXTURE_AUTH: authorization } }).init(), /no key/, credentials);
    }
    await failure(create('store:fixture-db', { readStore: async () => { throw new Error(value); }, prompt }).init(), /store entry could not be read/, credentials);
    expect(prompt).not.toHaveBeenCalled();
    assertPrivate(credentials);
  });

  it.each(['postgres', 'postgrest'] as const)('%s rejects missing, unsafe and malformed selected references before transport', async kind => {
    const { Pool } = driver();
    const create = kind === 'postgres' ? postgres : postgrest;
    const prompt = vi.fn();
    const dependencies = { environment: { AIWG_POSTGRES_URL: connectionString }, prompt, isTTY: true };
    await failure(create('FIXTURE_MISSING', dependencies).init(), /ENV_NAME.*file:ABSOLUTE_PATH.*store:NAME/, credentials);
    await failure(create('file:/missing-fixture-3620', dependencies).init(), /file does not exist/, credentials);
    const file = fixture(kind === 'postgres' ? connectionString : authorization);
    chmodSync(file, 0o640);
    await failure(create(`file:${file}`, dependencies).init(), /group or other access/, credentials);
    for (const reference of ['file:relative', 'store:', connectionString, authorization]) {
      await failure(create(reference, dependencies).init(), /requires.*ENV_NAME/, credentials);
    }
    expect(Pool).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe('PostgreSQL and PostgREST secret error boundaries (#3620)', () => {
  it.each(['load', 'constructor', 'query', 'connect', 'transaction', 'release', 'end', 'snapshot-close'])(
    'sanitizes a driver %s error echoing the entire connection string and password', async stage => {
      const { pool, client } = driver();
      const reflected = Object.assign(new Error(`driver echoed ${connectionString} password=${password}`), { detail: connectionString });
      const pg = postgres('store:fixture-db', { readStore: async () => connectionString });
      if (stage === 'load') vi.mocked(loadFeaturePackage).mockRejectedValueOnce(reflected);
      if (stage === 'constructor') vi.mocked(loadFeaturePackage).mockResolvedValue({ Pool: class { constructor() { throw reflected; } } });
      if (stage === 'query') pool.query.mockRejectedValueOnce(reflected);
      if (stage === 'load' || stage === 'constructor' || stage === 'query') {
        await failure(pg.init(), /PostgreSQL operation failed/, credentials);
        return;
      }
      await pg.init();
      let operation: Promise<unknown>;
      if (stage === 'end') {
        pool.end.mockRejectedValueOnce(reflected);
        operation = pg.close();
      } else if (stage === 'snapshot-close') {
        const lease = await pg.openSnapshotLease();
        client.query.mockRejectedValueOnce(reflected);
        operation = lease.close();
      } else {
        if (stage === 'connect') pool.connect.mockRejectedValueOnce(reflected);
        if (stage === 'transaction') client.query.mockRejectedValueOnce(reflected);
        if (stage === 'release') client.release.mockImplementationOnce(() => { throw reflected; });
        operation = pg.withMigrationLock(async () => undefined);
      }
      await failure(operation, /PostgreSQL operation failed/, credentials);
    },
  );

  it('preserves classified retryable failures without exposing driver detail', async () => {
    const { pool } = driver();
    pool.query.mockRejectedValueOnce(Object.assign(new Error(connectionString), { code: '40001', detail: password }));
    const error = await failure(postgres(undefined, { environment: { AIWG_POSTGRES_URL: connectionString } }).init(), /retryable/, credentials);
    expect(error).toMatchObject({ code: 'AIWG_POSTGRES_RETRYABLE', retryable: true });
  });

  it.each(['Bearer  AIWG_FIXTURE_AUTHORIZATION', 'Basic AIWG_FIXTURE_AUTHORIZATION', 'Bearer ABCDE'])(
    'redacts reflected credential components from %s', async value => {
      const token = value.trim().split(/\s+/).at(-1)!;
      http.mockResolvedValue(new Response(JSON.stringify({ code: token, message: token }), { status: 400 }));
      const error = await failure(postgrest('FIXTURE_AUTH', { environment: { FIXTURE_AUTH: value } }).init(), /PostgREST/, [value, token]);
      expect(error).toMatchObject({ code: 'AIWG_POSTGREST_REQUEST_FAILED' });
    },
  );

  it.each(['transport', 'body', 'decoded-code', 'decoded-message', 'decoded-sqlstate', 'detail'])(
    'sanitizes reflected PostgREST %s errors after JSON decoding', async stage => {
      http.mockImplementation(async (_url, init) => {
        expect(init.headers.Authorization).toBe(authorization);
        if (stage === 'transport') throw new Error(authorization);
        if (stage === 'body') return { status: 400, headers: new Headers(), text: async () => { throw new Error(authorization); } };
        const body = JSON.stringify({
          code: stage === 'decoded-code' ? authorization : stage === 'decoded-sqlstate' ? 'AIWG_FIXTURE_AUTHORIZATION' : 'P0001',
          message: stage === 'decoded-message' ? 'AIWG_FIXTURE_AUTHORIZATION' : 'AIWG_POSTGREST_REVISION_CONFLICT',
          details: authorization, hint: authorization,
        }).replaceAll('A', '\\u0041');
        return new Response(body, { status: 400 });
      });
      await failure(postgrest('store:fixture-http', { readStore: async () => authorization }).init(), /PostgREST/, credentials);
    },
  );
});
