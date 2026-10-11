import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { workerDefinitionBundleDigest } from '../../../src/mission-protocol/codecs.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');

// This fast loader check uses installed paths and local dependencies without
// subprocesses. Actual npm file selection is covered by the packaging lane.
describe('Mission schema loader in offline installed layouts', () => {
  it.each(['aiwg', '@aiwg/cli'])('resolves the bundled schema from %s outside the checkout', async name => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'aiwg-mission-layout-'));
    try {
      const manifestPath = path.join(ROOT, name === 'aiwg' ? 'package.json' : 'packages/cli/package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      expect(manifest.files).toContain('schemas/mission-v1.schema.json');
      const installed = path.join(scratch, 'node_modules', name);
      const modules = path.join(installed, 'dist/src/mission-protocol');
      mkdirSync(modules, { recursive: true });
      mkdirSync(path.join(installed, 'schemas'));
      writeFileSync(path.join(installed, 'package.json'), JSON.stringify(manifest));
      cpSync(path.join(ROOT, 'schemas/mission-v1.schema.json'), path.join(installed, 'schemas/mission-v1.schema.json'));
      for (const file of ['types', 'codecs']) {
        const source = readFileSync(path.join(ROOT, `src/mission-protocol/${file}.ts`), 'utf8');
        const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
        writeFileSync(path.join(modules, `${file}.js`), compiled.outputText);
      }
      const copied = new Set<string>();
      function copyDependency(dependency: string, requireFrom: ReturnType<typeof createRequire>) {
        if (copied.has(dependency)) return;
        copied.add(dependency);
        const location = requireFrom.resolve(`${dependency}/package.json`);
        const target = path.join(scratch, 'node_modules', dependency);
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(path.dirname(location), target, { recursive: true });
        const metadata = JSON.parse(readFileSync(location, 'utf8'));
        for (const child of Object.keys(metadata.dependencies ?? {})) copyDependency(child, createRequire(location));
      }
      const requireFrom = createRequire(path.join(ROOT, 'package.json'));
      for (const dependency of ['ajv', 'ajv-formats']) copyDependency(dependency, requireFrom);
      const installedCodecs = await import(/* @vite-ignore */ pathToFileURL(path.join(modules, 'codecs.js')).href);
      expect(installedCodecs.workerContractSchemaId()).toBe('https://aiwg.io/schemas/mission.aiwg.io/v1');
      expect(installedCodecs.workerDefinitionBundleDigest()).toBe(workerDefinitionBundleDigest());
      const claims = { version: 1, status: 'completed', summary: 'Synthetic', claims: [], artifacts: [], checks: [], limitations: [] };
      expect(installedCodecs.validateWorkerPayload('workerClaims', claims).valid).toBe(true);
      expect(installedCodecs.decodeWorkerPayload('workerClaims', installedCodecs.encodeWorkerPayload('workerClaims', claims))).toEqual(claims);
      expect(() => installedCodecs.encodeWorkerPayload('workerClaims', { ...claims, version: 999 })).toThrow(/Invalid workerClaims/);
      const mission = { apiVersion: 'mission.aiwg.io/v1', extensions: { 'aiwg.worker-dispatch': { version: 999 } } };
      expect(() => installedCodecs.decodeMission(mission, 'canonical')).toThrow(/OG_CONTRACT_UNSUPPORTED/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
