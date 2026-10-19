/** Artifact worker uses the exact caller module: source never silently loads stale dist. */
import { parentPort, workerData } from 'node:worker_threads';
const module = workerData.moduleUrl.endsWith('.ts')
  ? await (await import('tsx/esm/api')).tsImport(workerData.moduleUrl, import.meta.url)
  : await import(workerData.moduleUrl);
parentPort.on('message', ({ index, job }) => {
  try { parentPort.postMessage({ index, result: module.prepareIndexArtifact(job) }); }
  catch (error) { parentPort.postMessage({ index, error: `${job.relativePath}: ${error.message}` }); }
});
