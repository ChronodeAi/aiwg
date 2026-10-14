import { importImpl } from '../../tools/_resolve-impl.mjs';

// Do not retain this graph across vi.resetModules(). The launcher's private
// capability reader captures the installation owner selected by importImpl,
// which may be source or packaged dist. Acquire its registrar and loader from
// that same resolver and cache generation, without copying any driver.
export async function loadRecoveryModuleGraph() {
  const installation = await importImpl(import.meta.url, 'models/worker-installation.mjs');
  const models = await importImpl(import.meta.url, 'cli/handlers/models.js');
  const config = await importImpl(import.meta.url, 'config/aiwg-config.js');
  const configLoader = await importImpl(import.meta.url, 'models/config-loader.js');
  const inventory = await importImpl(import.meta.url, 'providers/provider-inventory.js');
  const discovery = await importImpl(import.meta.url, 'models/model-discovery.js');
  const launcher = await import('../../tools/ralph-external/session-launcher.mjs');
  const isolation = await import('../../tools/ralph-external/lib/worker-isolation.mjs');
  const workerInvoke = await import('../../src/mcp/tools/worker-invoke.mjs');
  return { installation, models, config, configLoader, inventory, discovery,
    launcher, isolation, workerInvoke };
}
