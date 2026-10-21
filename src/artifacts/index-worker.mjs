/** Artifact worker uses the exact caller module: source never silently loads stale dist. */
const moduleUrl = process.argv[2];
const module = moduleUrl.endsWith('.ts')
  ? await (await import('tsx/esm/api')).tsImport(moduleUrl, import.meta.url)
  : await import(moduleUrl);
process.on('message', ({ index, job }) => {
  try { process.send({ index, result: module.prepareIndexArtifact(job) }); }
  catch (error) { process.send({ index, error: `${job.relativePath}: ${error.message}` }); }
});
// The parent may itself be interrupted; do not leave orphaned preparation processes.
process.on('disconnect', () => process.exit(0));
