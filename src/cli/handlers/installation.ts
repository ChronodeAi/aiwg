import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { getPackageRoot } from '../../channel/manager.mjs';
import {
  adoptInstallation,
  inspectInstallation,
  loadInstallationIdentity,
  switchInstallation,
} from '../../installation/manager.mjs';

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function display(status: ReturnType<typeof inspectInstallation>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log('\nCanonical AIWG Installation');
  console.log('===========================');
  console.log(`State:             ${status.state}`);
  console.log(`Canonical method:  ${status.identity?.method ?? '(unrecorded)'}`);
  console.log(`Canonical root:    ${status.identity?.root ?? '(unrecorded)'}`);
  console.log(`Manager:           ${status.identity?.managerExecutable ?? '(internal)'}`);
  console.log(`Update strategy:   ${status.identity?.updateStrategy ?? '(unrecorded)'}`);
  console.log(`Run mode:          ${status.identity?.runMode ?? '(unrecorded)'}`);
  console.log(`Release channel:   ${status.identity?.channel ?? '(unrecorded)'}`);
  console.log(`Actual method:     ${status.actualMethod}`);
  console.log(`Actual root:       ${status.actualRoot}`);
  console.log(`Framework root:    ${status.frameworkRoot}`);
  if (status.launcher) {
    console.log(`Launcher:          ${status.launcher.method} at ${status.launcher.root} (edge redirect — expected)`);
  }
  if (status.drift.length > 0) {
    console.log('Drift:');
    for (const item of status.drift) console.log(`  - ${item}`);
  }
  const remedy = remediation(status);
  if (remedy) {
    console.log('');
    console.log('Resolve:');
    for (const line of remedy) console.log(`  ${line}`);
  }
  console.log('');
}

/**
 * `switch` and `adopt` only write installation.json — they cannot change which
 * binary is on PATH. So when the declaration and reality disagree, neither command
 * resolves it and the operator needs a shell step this output never mentioned.
 * Print it, tailored to the direction of the drift (#2534).
 */
export function remediation(status: ReturnType<typeof inspectInstallation>): string[] | null {
  if (status.state !== 'mismatch') return null;
  const canonicalMethod = status.identity?.method;
  const canonicalRoot = status.identity?.root;
  const actualMethod = status.actualMethod;

  if (canonicalMethod === 'source' && canonicalRoot && actualMethod !== 'source') {
    return [
      `The declared source install is not what runs. Put it on PATH:`,
      `  cd ${canonicalRoot} && npm link`,
      `Then re-run 'aiwg installation show' to confirm State: aligned.`,
      `('aiwg installation switch' would only rewrite the declaration, which already says source.)`,
    ];
  }
  if (canonicalMethod === 'npm' && actualMethod === 'source') {
    return [
      `The declared npm install is not what runs. Restore it:`,
      `  npm i -g aiwg`,
      `If a source checkout was linked, unlink it first: npm unlink -g aiwg`,
    ];
  }
  return [
    `Declaration and reality disagree (${canonicalMethod ?? 'unrecorded'} vs ${actualMethod}).`,
    `'switch' and 'adopt' are declaration-only and cannot change PATH.`,
    `Install or link the intended root, then re-run 'aiwg installation show'.`,
  ];
}

function usage(): string {
  return `
  aiwg installation — inspect, adopt, or switch the canonical global installation

  Usage:
    aiwg installation show [--json]
    aiwg installation adopt --method <npm|web|source> [--run-mode <normal|development>] [--yes]
    aiwg installation switch --root <path> --method <npm|web|source> [--manager <absolute-path>]

  Options:
    --json            Machine-readable output
    --config-dir      Override the installation config directory
    --manager         Absolute path to the package manager executable
    --channel         Release channel (stable|edge)
    --run-mode        normal|development (derived from --method when omitted)
    --yes             Confirm an adopt that abandons the declared install

  Notes:
    These commands are declaration-only: they record which installation is
    canonical, they do not change which binary is on PATH. When \`show\` reports
    State: mismatch, it prints the concrete command that resolves it.
`;
}

export const installationHandler: CommandHandler = {
  id: 'installation',
  name: 'Installation',
  description: 'Inspect, adopt, or deliberately switch the canonical global installation',
  category: 'maintenance',
  aliases: [],

  async help(): Promise<HandlerResult> {
    return { exitCode: 0, message: usage(), rawOutput: true };
  },

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const [action = 'show'] = ctx.args;
    if (action === 'help') return { exitCode: 0, message: usage(), rawOutput: true };
    const json = ctx.args.includes('--json');
    const actualRoot = getPackageRoot();
    const common = {
      actualRoot,
      configDir: valueAfter(ctx.args, '--config-dir'),
      managerExecutable: valueAfter(ctx.args, '--manager'),
      channel: valueAfter(ctx.args, '--channel'),
    };

    if (action === 'show') {
      const identity = loadInstallationIdentity({ ...common, createIfMissing: true });
      display(inspectInstallation({ ...common, identity, probeManager: true }), json);
      return { exitCode: 0 };
    }
    if (action === 'adopt') {
      const method = valueAfter(ctx.args, '--method');
      // adopt resolves a mismatch by rewriting canonical to match whatever is
      // running — i.e. by abandoning the declared install. That is the opposite
      // of what an operator standardizing on a source checkout wants, so make it
      // a deliberate choice rather than a silent capitulation (#2534).
      const before = inspectInstallation({
        ...common,
        identity: loadInstallationIdentity({ ...common, createIfMissing: true }),
      });
      const declaredMethod = before.identity?.method;
      const abandoning = before.state === 'mismatch'
        && declaredMethod
        && declaredMethod !== before.actualMethod;
      if (abandoning && !ctx.args.includes('--yes')) {
        return {
          exitCode: 2,
          rawOutput: true,
          message: [
            `Refusing to adopt: this would abandon the declared ${declaredMethod} install.`,
            ``,
            `  declared: ${declaredMethod} at ${before.identity?.root ?? '(unrecorded)'}`,
            `  running:  ${before.actualMethod} at ${before.actualRoot}`,
            ``,
            `adopt rewrites the declaration to match what is running; it does not change`,
            `which binary is on PATH. If you meant to keep the declared install, run`,
            `'aiwg installation show' for the command that puts it back on PATH.`,
            `If you really mean to abandon it, re-run with --yes.`,
          ].join('\n'),
        };
      }
      const status = adoptInstallation({
        ...common,
        method,
        runMode: valueAfter(ctx.args, '--run-mode'),
      });
      if (abandoning) {
        console.log(`Warning: adopted the running ${status.actualMethod} install; the previously declared ${declaredMethod} install is no longer canonical.`);
      }
      display(status, json);
      return { exitCode: 0 };
    }
    if (action === 'switch') {
      const root = valueAfter(ctx.args, '--root');
      const method = valueAfter(ctx.args, '--method');
      if (!root || !method) {
        return { exitCode: 2, message: `switch requires --root and --method\n${usage()}`, rawOutput: true };
      }
      const status = switchInstallation({
        ...common,
        root,
        method,
        runMode: valueAfter(ctx.args, '--run-mode'),
      });
      display(status, json);
      return { exitCode: 0 };
    }
    return { exitCode: 2, message: `Unknown installation action: ${action}\n${usage()}`, rawOutput: true };
  },
};
