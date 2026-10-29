import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runResourceDoctor } from '../../../tools/cli/doctor-resources.mjs';
import { parseDoctorArgsOrExit } from '../../../tools/cli/doctor-args.mjs';
import { parsePublicDoctorFlags } from '../../../src/cli/handlers/doctor-args.js';
import { hostResourceReport } from '../../../src/config/host-resource-report.mjs';
import { hostResourceReaders, ownedWorkerReaders } from '../../fixtures/host-resources.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('accepts the resource mode in both strict doctor parsers and honors the terminator', () => {
  expect(parsePublicDoctorFlags(['--resources', '--json']).hasSwitch('--resources')).toBe(true);
  expect(parseDoctorArgsOrExit(['--resources', '--json'])).toMatchObject({ resources: true, json: true });
  expect(parseDoctorArgsOrExit(['--', '--resources'])).toMatchObject({ resources: false });
  for (const flag of ['--probe-workers', '--decision-offload', '--deployment', '--user', '--project-local', '--scope=user']) {
    expect(() => parsePublicDoctorFlags(['--resources', flag])).toThrow(/separately/);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => parseDoctorArgsOrExit(['--resources', flag])).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(2); expect(stderr).toHaveBeenCalled();
    exit.mockRestore(); stderr.mockRestore();
  }
});

it('emits exactly the shared resource report as one JSON document and a matching text exit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-doctor-resources-')); roots.push(root);
  const config = { parallelism: { max_parallel_subagents: 3, admission: { hostResources: { max_workers: 1 } } } } as any;
  const readers = { ...hostResourceReaders(), statfsPath: () => ({ bavail: 32, bsize: 1024 ** 3 }) };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runResourceDoctor(root, { json: true, readers, config })).toBe(1);
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual(hostResourceReport({ config, readers, paths: [root] }));
  log.mockClear();
  expect(await runResourceDoctor(root, { readers, config })).toBe(1);
  expect(log.mock.calls.flat().join('\n')).toContain('max_workers');
  config.parallelism.admission.hostResources.max_workers = 4;
  expect(await runResourceDoctor(root, { json: true, readers, config })).toBe(0);
});

it('reports owned-process fallback and labels raw CLI counts informational in text and JSON', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-doctor-owned-')); roots.push(root);
  const readers = { ...ownedWorkerReaders(undefined, [{ invocation: 'one' }, { invocation: 'one' }, {}]),
    statfsPath: () => ({ bavail: 32, bsize: 1024 ** 3 }) };
  const config = { parallelism: { max_parallel_subagents: 2 } } as any;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runResourceDoctor(root, { json: true, readers, config })).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ slots: 1, measured: {
    workers: 1, hostCliProcesses: { codex: 3, muse: 0 }, workerCountingSource: 'owned-process-fallback' } });
  log.mockClear();
  expect(await runResourceDoctor(root, { readers, config })).toBe(0);
  expect(log.mock.calls.flat().join('\n')).toContain('systemd unavailable: owned-process fallback');
  expect(log.mock.calls.flat().join('\n')).toContain('not used for admission');
});
