import { afterEach, describe, expect, it } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const projectRoot = resolve(import.meta.dirname, '../../..')
const temporaryDirectories: string[] = []
const execFileAsync = promisify(execFile)

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('schema lint control-plane report', () => {
  it('keeps the generated repository catalog deterministic and current', () => {
    expect(() => execFileSync(process.execPath, ['tools/scripts/build-schema-catalog.mjs', '--check'], { timeout: 60_000, cwd: projectRoot, stdio: 'pipe' })).not.toThrow()
  })

  it('uses the composed catalog, denies network resolution, and emits deterministic inventory fields', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aiwg-schema-lint-'))
    temporaryDirectories.push(directory)
    const reportPath = join(directory, 'report.json')

    // Full-catalog compilation competes with the other suite workers on CI.
    // Keep the child bounded and let Vitest's outer deadline cover its cleanup.
    await execFileAsync(process.execPath, ['tools/scripts/lint-schemas.mjs', '--report-json', reportPath], {
      timeout: 120_000,
      cwd: projectRoot,
    })

    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    expect(report.inventoryMode).toBe('catalog')
    expect(report.networkResolution).toBe('deny')
    expect(report.policy.strictDefault).toBe(true)
    expect(report.resources.length).toBeGreaterThan(0)
    expect(report.resources.every((resource: { compiled: boolean }) => resource.compiled)).toBe(true)
    expect(report.discoveredResources).toEqual([...report.discoveredResources].sort())
    expect(report.diagnostics.some((item: { code: string }) => item.code === 'SCHEMA_CATALOG_MISSING')).toBe(false)
  }, 130_000)

  it('compiles the catalog when network resolution APIs are unavailable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aiwg-schema-lint-offline-'))
    temporaryDirectories.push(directory)
    const preloadPath = join(directory, 'deny-network.mjs')
    const attemptsPath = join(directory, 'network-attempts')
    const reportPath = join(directory, 'report.json')
    writeFileSync(preloadPath, `
      import http from 'node:http';
      import https from 'node:https';
      import net from 'node:net';
      import { appendFileSync } from 'node:fs';
      const deny = () => {
        appendFileSync(${JSON.stringify(attemptsPath)}, 'attempt\\n');
        throw new Error('Network resolution forbidden in schema fixture');
      };
      globalThis.fetch = deny;
      http.request = http.get = https.request = https.get = deny;
      net.Socket.prototype.connect = deny;
    `)
    await execFileAsync(process.execPath, ['--import', pathToFileURL(preloadPath).href,
      'tools/scripts/lint-schemas.mjs', '--report-json', reportPath], {
      timeout: 120_000,
      cwd: projectRoot,
    })
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    expect(report.resources.length).toBeGreaterThan(0)
    expect(report.resources.every((resource: { compiled: boolean }) => resource.compiled)).toBe(true)
    expect(() => readFileSync(attemptsPath)).toThrow(/ENOENT/)
  }, 130_000)

  it('governs exceptions and dependency resolution as security policy', () => {
    const exceptions = JSON.parse(readFileSync(join(projectRoot, 'schemas/policy/strict-exceptions.json'), 'utf8'))
    for (const exception of exceptions.exceptions) {
      expect(exception).toEqual(expect.objectContaining({
        resource: expect.any(String),
        rule: expect.any(String),
        owner: expect.any(String),
        rationale: expect.any(String),
        approvedBy: expect.any(String),
        expires: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      }))
    }

    const lock = JSON.parse(readFileSync(join(projectRoot, 'schemas/policy/dependency-lock.json'), 'utf8'))
    expect(lock.networkResolution).toBe('deny')
    for (const dependency of lock.dependencies) {
      expect(dependency).toEqual(expect.objectContaining({
        uri: expect.any(String), dialect: expect.any(String), source: expect.any(String),
        version: expect.any(String), sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }))
    }
  })

  it('documents every required schema execution threat', () => {
    const threatModel = readFileSync(join(projectRoot, 'docs/security/schema-execution-threat-model.md'), 'utf8')
    for (const threat of [
      'Reference substitution', 'Namespace collision', 'Malicious regex', 'Resource exhaustion',
      'Diagnostic leakage', 'Projection tampering', 'Undeclared-schema bypass',
    ]) {
      expect(threatModel).toContain(threat)
    }
  })
})
