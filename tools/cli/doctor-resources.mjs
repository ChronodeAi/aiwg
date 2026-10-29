// Read-only resource mode; stdout is one normalized report in JSON mode.
import { importImpl } from '../_resolve-impl.mjs';
const { readAiwgConfig } = await importImpl(import.meta.url, 'config/aiwg-config.js');
const { hostResourceReport } = await importImpl(import.meta.url, 'config/host-resource-report.mjs');

export async function runResourceDoctor(projectDir, { json = false, readers, config } = {}) {
  const report = hostResourceReport({ config: config ?? await readAiwgConfig(projectDir), readers, paths: [projectDir] });
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Host resources: ${report.ok ? 'OK' : 'BLOCK'}; slots=${report.slots}`);
    console.log(`Measured: ${JSON.stringify(report.measured)}`);
    console.log(`Counting: ${report.counting}`);
    for (const [key, value] of Object.entries(report.thresholds ?? {})) {
      console.log(`${key}=${value} (${report.origins[key].join(', ')})`);
    }
    for (const failure of report.failures) console.log(`${failure.signal}: ${failure.reason}`);
  }
  return report.ok ? 0 : 1;
}
