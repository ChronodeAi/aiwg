import type { CommandHandler } from './types.js';
import { providerCommandOptions } from './provider-command-options.js';
import { readAiwgConfig } from '../../config/aiwg-config.js';
import { verifyProviderDeployment } from '../services/deployment-verification.js';

export const buildVerifyHandler: CommandHandler = {
  id: 'build-verify', name: 'Build Verification', category: 'utility', aliases: [],
  description: 'Verify AIWG deployment before a provider runs a build or CI task',
  async help() {
    return { exitCode: 0, rawOutput: true, message: [
      'aiwg build-verify [--provider <id>]',
      'Run from the project root. Uses the shared provider deployment, registry, context and discovery checks.',
      'Uses the active provider if unambiguous; specify --provider in CI.',
      'Documented native inspection is required when the provider adapter supports it.',
      'Other providers report deployment-only verification; no native execution or model compliance is claimed.',
      'Prints JSON and fails for missing deployment or blocking findings. Does not run build commands or inference.',
      'See docs/integrations/build-verify.md.',
    ].join('\n') };
  },
  async execute(ctx) {
    try {
      if (ctx.dryRun) throw new Error('Verification is already read-only');
      const { provider } = await providerCommandOptions(ctx.args, ctx.cwd);
      const config = await readAiwgConfig(ctx.cwd);
      const bundles = Object.entries(config?.installed ?? {})
        .filter(([, bundle]) => Boolean(bundle.deployedTo?.[provider.id])).map(([name]) => name);
      if (!bundles.length) {
        return { exitCode: 1, rawOutput: true, message: JSON.stringify({
          schema: 'aiwg.build.verify.v1', provider: provider.id, status: 'failed',
          message: `No project deployment recorded. Run aiwg use all --provider ${provider.id} --scope project first.`,
        }) };
      }
      const result = await verifyProviderDeployment({
        projectRoot: ctx.cwd, frameworkRoot: ctx.frameworkRoot, provider: provider.id,
        scope: 'project', requestedBundles: bundles, requireNativeInspection: true,
      });
      const failed = result.findings.some(finding => finding.severity === 'blocking');
      return { exitCode: failed ? 1 : 0, rawOutput: true, message: JSON.stringify({
        schema: 'aiwg.build.verify.v1', provider: provider.id,
        status: failed ? 'failed' : 'ready', verification: result.verificationLevel,
        restartRequired: result.restartRequired, restartAction: result.restartAction,
        // Do not echo raw provider output or configuration values into CI logs.
        findings: result.findings.map(({ id, severity, message, remediation }) => ({ id, severity, message, remediation })),
      }, null, 2) };
    } catch {
      return { exitCode: 1, message: 'Cannot verify build readiness. Select a registered --provider, check project configuration, and see build-verify --help.' };
    }
  },
};
