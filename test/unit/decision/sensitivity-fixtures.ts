import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../../..');
export const FIXTURE_DIR = 'test/fixtures/decision/sensitivity';
export type PatchOp = { op: 'add' | 'remove' | 'replace'; path: string; value?: unknown };
export interface AntiFixtureCase { id: string; base: string; layer: 'schema' | 'semantic'; patch: PatchOp[]; expect?: string }

export function readSensitivityFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, FIXTURE_DIR, name), 'utf8')) as T;
}

export function sensitivityRecords<T extends { id: string }>(name: string): Map<string, T> {
  return new Map(readSensitivityFixture<{ records: T[] }>(name).records.map(record => [record.id, record]));
}

export function applyPatch<T>(value: T, patch: readonly PatchOp[] = []): T {
  const target = structuredClone(value) as Record<string, unknown>;
  for (const op of patch) {
    const parts = op.path.split('/').slice(1);
    const key = parts.pop()!;
    const parent = parts.reduce<any>((node, part) => node[part], target);
    if (op.op === 'remove') {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    } else if (Array.isArray(parent) && key === '-') parent.push(op.value);
    else parent[key] = op.value;
  }
  return target as T;
}
