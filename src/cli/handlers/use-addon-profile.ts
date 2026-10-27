// Select and persist an optional bundled addon memory profile.
import fs from 'node:fs/promises';
import path from 'node:path';
import * as ui from '../ui.js';

export async function selectAddonProfile(options: {
  addonSource: string;
  framework: string;
  target: string;
  args: string[];
  dryRunAddon: boolean;
  bulkIntent: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  const { addonSource, framework, target, args, dryRunAddon, bulkIntent, signal } = options;
  try {
    const profileManifestPath = path.join(addonSource, 'manifest.json');
    const profileManifestContent = await fs.readFile(profileManifestPath, 'utf-8');
    const profileManifest = JSON.parse(profileManifestContent);

    const topology = profileManifest.memory?.topology;
    const templates = profileManifest.templates;

    if (topology && templates && templates.length > 1) {
      const profileIdx = args.findIndex(a => a === '--profile');
      let selectedProfile: string | undefined;

      if (profileIdx >= 0 && args[profileIdx + 1]) {
        // Explicit --profile flag
        selectedProfile = args[profileIdx + 1];
        const templateFile = templates.find((t: string) =>
          t.replace('.md', '') === selectedProfile || t === selectedProfile
        );
        if (!templateFile) {
          ui.warn(`Unknown profile "${selectedProfile}". Available: ${templates.map((t: string) => t.replace('.md', '')).join(', ')}`);
          selectedProfile = undefined;
        }
      } else if (bulkIntent || !process.stdin.isTTY) {
        // Bulk/automation or non-TTY: silently pick 'generic' default.
        // The profile picker is annoying during `aiwg use all`.
        selectedProfile = 'generic';
      } else if (process.stdin.isTTY) {
        // Interactive profile selection via the shared `listSelect` helper
        // (POC for spike #926). One call renders the option list, handles
        // number-or-name matching, threads `signal` for Ctrl-C
        // cancellation, and resolves to the fallback on timeout or empty
        // input. The hand-rolled parse-and-branch that used to live here
        // is now a one-liner.
        const { createPromptInterface, listSelect } = await import('../prompt-utils.js');
        ui.blank();
        ui.header('  Select a topology profile:');
        const templateNames = templates.map((t: string) => t.replace('.md', ''));
        const options = templateNames.map((name: string) => ({
          label: name === 'generic' ? `${name} (default)` : name,
          value: name,
        }));

        const rl = createPromptInterface();
        try {
          selectedProfile = await listSelect(
            rl,
            '  Enter number or name [generic]: ',
            options,
            'generic',
            signal,
          );
        } finally {
          rl.close();
        }
      }

      // Write profile config to project namespace
      if (selectedProfile && !dryRunAddon) {
        const namespace = topology.namespace || `.aiwg/${framework}`;
        const configDir = path.join(target, namespace);
        await fs.mkdir(configDir, { recursive: true });
        const profileConfig = {
          profile: selectedProfile,
          pageTemplate: `templates/${selectedProfile}.md`,
          selectedAt: new Date().toISOString(),
        };
        await fs.writeFile(
          path.join(configDir, 'config.json'),
          JSON.stringify(profileConfig, null, 2) + '\n'
        );
        ui.success(`Profile "${selectedProfile}" selected → ${namespace}/config.json`);
      }
    }
  } catch {
    // Profile selection is optional — don't fail deployment
  }
}
