// Offline child process paused at an adoption checkpoint until its parent kills it.
import { readFile } from 'node:fs/promises';
import { applyWorkerAdoption, recoverWorkerAdoption } from '../../../src/config/worker-adoption.js';
const [project, action, step, file] = process.argv.slice(2);
const proposal = JSON.parse(await readFile(file, 'utf8'));
const options = { regenerate: async () => {}, checkpoint: async (current: string) => {
  if (current !== step) return;
  process.send?.({ step });
  await new Promise(() => { setInterval(() => {}, 60_000); });
} };
try {
  if (action === 'apply') await applyWorkerAdoption(project, proposal, { digest: proposal.digest }, options);
  else await recoverWorkerAdoption(project, { digest: proposal.digest }, options);
  process.exit(0);
} catch (error) { console.error(error); process.exit(1); }
