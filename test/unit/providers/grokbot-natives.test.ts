import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GROKBOT_NATIVE_CREATE_AGENT_ENV,
  GROKBOT_NATIVE_CONNECTORS_ENV,
  GROKBOT_NATIVE_EVIDENCE_CATALOG,
  GROKBOT_NATIVE_MACHINE_PROBE_ENV,
  GROKBOT_NATIVE_MEMORY_REF_ENV,
  GROKBOT_NATIVE_ROUTINES_ENV,
  GROKBOT_NATIVE_SURFACE_ORDER,
  buildConnectorInstallProfileStub,
  collectGrokbotNativeOptionalStatus,
  generateRoutinesImportStub,
  listGrokbotNativeFlagNames,
  memoryReferenceHelper,
  projectCreateAgentStub,
  registeredMachineHealthProbe,
} from '../../../src/providers/grokbot-natives/index.js';

describe('grokbot natives scaffolding — default off', () => {
  it('lists five surfaces with safest-first order', () => {
    expect(GROKBOT_NATIVE_SURFACE_ORDER).toEqual([
      'registered-machine-health',
      'memory-reference-helper',
      'routines',
      'create-agent',
      'connector-install-profile',
    ]);
    expect(listGrokbotNativeFlagNames()).toHaveLength(5);
  });

  it('returns disabled for every entry when flags unset', () => {
    const env = {};
    expect(registeredMachineHealthProbe({ env }).status).toBe('disabled');
    expect(memoryReferenceHelper({}, { env }).status).toBe('disabled');
    expect(generateRoutinesImportStub({}, { env }).status).toBe('disabled');
    expect(projectCreateAgentStub({}, { env }).status).toBe('disabled');
    expect(buildConnectorInstallProfileStub({}, { env }).status).toBe('disabled');
  });

  it('optional status collector is skippable and empty when default-off', () => {
    const summary = collectGrokbotNativeOptionalStatus({ env: {} });
    expect(summary.skippable).toBe(true);
    expect(summary.enabledResults).toEqual([]);
    for (const surface of GROKBOT_NATIVE_SURFACE_ORDER) {
      expect(summary.flags[surface].enabled).toBe(false);
    }
  });
});

describe('grokbot natives — enable without contract still fail-closed', () => {
  it('#244 probe is blocked, read-only, never mutates', () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-grokbot-244-'));
    try {
      const marker = join(root, 'must-not-change.txt');
      writeFileSync(marker, 'unchanged\n');
      const before = readdirSync(root);

      const result = registeredMachineHealthProbe({
        env: { [GROKBOT_NATIVE_MACHINE_PROBE_ENV]: '1' },
      });

      expect(result.status).toBe('blocked');
      expect(result.enabled).toBe(true);
      expect(result.wrote).toBe(false);
      expect(result.probe.machineBridgePresent).toBe(false);
      expect(result.probe.localExecutionMutated).toBe(false);
      expect(result.probe.credentialsWritten).toBe(false);
      expect(result.probe.machinesRegistered).toBe(false);
      expect(result.evidence.importContractAvailable).toBe(false);
      expect(result.evidence.childIssue).toBe(244);
      expect(result.evidence.catalogPath).toBe(GROKBOT_NATIVE_EVIDENCE_CATALOG);
      expect(result.message).toMatch(/no AIWG machine bridge/i);

      expect(readdirSync(root)).toEqual(before);
      expect(readFileSync(marker, 'utf8')).toBe('unchanged\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('#245 proposals are reference-like only; rejects secrets; never writes', () => {
    const env = { [GROKBOT_NATIVE_MEMORY_REF_ENV]: 'true' };
    const ok = memoryReferenceHelper(
      {
        paths: ['/workspace/docs/integrations/grokbot-native-surfaces-evidence.md'],
        issueUrls: ['https://github.com/jmagly/aiwg/issues/245'],
        aiwgShowPointers: ['aiwg show agent founding-engineer'],
        summaries: ['Refs #245 memory helper scaffolding'],
      },
      { env },
    );
    expect(ok.status).toBe('proposed');
    expect(ok.wrote).toBe(false);
    expect(ok.proposals?.length).toBe(4);
    for (const p of ok.proposals ?? []) {
      expect(p.text.length).toBeLessThanOrEqual(240);
      expect(p.text).not.toMatch(/token|password|cookie|bearer/i);
      expect(p.text).not.toContain('\n');
    }

    const rejected = memoryReferenceHelper(
      {
        summaries: ['Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb'],
        paths: ['api_key=sk-super-secret'],
      },
      { env },
    );
    expect(rejected.status).toBe('blocked');
    expect(rejected.proposals).toBeUndefined();
    expect(rejected.wrote).toBe(false);
  });

  it('#241 routines stub refuses to write even with dry-run proposal', () => {
    const result = generateRoutinesImportStub(
      {
        proposal: {
          title: 'Nightly status',
          scheduleDescription: 'every weekday at 9am',
        },
      },
      { env: { [GROKBOT_NATIVE_ROUTINES_ENV]: '1' } },
    );
    expect(result.status).toBe('blocked');
    expect(result.wrote).toBe(false);
    expect(result.dryRunProposal?.mode).toBe('dry-run');
    expect(result.evidence.childIssue).toBe(241);
    expect(result.message).toMatch(/refused to write/i);
  });

  it('#242 create-agent stub never writes profiles', () => {
    const result = projectCreateAgentStub(
      {
        projection: {
          name: 'Founding Engineer',
          sourceAgentId: 'founding-engineer',
        },
      },
      { env: { [GROKBOT_NATIVE_CREATE_AGENT_ENV]: 'yes' } },
    );
    expect(result.status).toBe('blocked');
    expect(result.wrote).toBe(false);
    expect(result.dryRunProjection?.mode).toBe('dry-run');
    expect(result.evidence.childIssue).toBe(242);
  });

  it('#243 connector profile is recommend-only; no secret storage', () => {
    const result = buildConnectorInstallProfileStub(
      {
        recommendations: [
          {
            name: 'GitHub',
            rationale: 'Issue/PR context for AIWG workflows',
            operatorSteps: ['Settings → Plugins → Add', 'Authorize in browser'],
            docsUrl: 'https://docs.x.ai/grok-bot/computer-and-apps',
          },
        ],
      },
      { env: { [GROKBOT_NATIVE_CONNECTORS_ENV]: 'on' } },
    );
    expect(result.status).toBe('blocked');
    expect(result.wrote).toBe(false);
    expect(result.profile?.applyMode).toBe('recommend-only');
    expect(JSON.stringify(result.profile)).not.toMatch(/token|oauth|cookie|password/i);
    expect(result.evidence.childIssue).toBe(243);
  });
});

describe('grokbot natives — optional status wiring stays skippable', () => {
  it('runs only the read-only machine probe when that flag is on', () => {
    const summary = collectGrokbotNativeOptionalStatus({
      env: { [GROKBOT_NATIVE_MACHINE_PROBE_ENV]: '1' },
    });
    expect(summary.skippable).toBe(true);
    expect(summary.enabledResults).toHaveLength(1);
    expect(summary.enabledResults[0]?.surface).toBe('registered-machine-health');
    expect(summary.enabledResults[0]?.wrote).toBe(false);
  });
});
