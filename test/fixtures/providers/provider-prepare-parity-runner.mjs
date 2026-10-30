import path from 'node:path';
import { main as deployProvider } from '../../../tools/agents/deploy-agents.mjs';
import { prepareProviderDeployments } from '../../../tools/agents/providers/provider-prepare-coordinator.mjs';

const [mode, source, target, providerList = 'codex,hermes,pi'] = process.argv.slice(2);
if (!['serial', 'concurrent'].includes(mode) || !source || !target) throw new Error('Invalid parity fixture invocation');

const providers = providerList.split(',').filter(Boolean);
const jobs = providers.map((provider, order) => ({
  order,
  provider,
  target: path.resolve(target),
  args: ['--source', source, '--target', target, '--provider', provider, '--mode', 'all',
    '--deploy-commands', '--deploy-skills', '--deploy-rules', '--quiet'],
}));

if (mode === 'serial') {
  for (const job of jobs) await deployProvider(job.args);
} else {
  // This is the parent-owned migration preflight used by the TypeScript `use`
  // service before it creates the immutable shared input snapshot.
  for (const job of jobs) await deployProvider(job.args, { preflightOnly: true });
  const session = await prepareProviderDeployments({ srcRoot: path.resolve(source), jobs, maxConcurrency: 2 });
  try {
    for (const job of jobs) {
      await session.commit(job.order);
      await deployProvider(job.args, { finalizeOnly: true });
    }
  } finally {
    await session.dispose();
  }
}
