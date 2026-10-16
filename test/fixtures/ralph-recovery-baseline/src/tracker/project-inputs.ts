/**
 * FROZEN REFERENCE FIXTURE -- NOT PRODUCTION CODE.
 * Source: src/tracker/project-inputs.ts at 8c812250d6e8e139eb52f798b92934bab9350021.
 * Only import routing and this pin header differ from the baseline body.
 * Refresh with: node test/fixtures/ralph-recovery-baseline/refresh.mjs --ref=8c812250d6e8e139eb52f798b92934bab9350021
 * Installation ownership and default input loading stay in this fixture graph.
 * Other dependencies use repository source. Never import from production.
 */

/**
 * Project inputs for tracker authority: the `.aiwg/aiwg.config` and the git
 * remote URLs. Shared by context finalization and the `aiwg effect` tracker
 * verifiers, so both resolve the tracker from the same facts.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readAiwgConfig, type AiwgConfig } from '../config/aiwg-config.ts';

const execFileAsync = promisify(execFile);

/** The project config, or `null` when it is missing or unreadable. */
export async function readConfig(projectPath: string): Promise<AiwgConfig | null> {
  try {
    return await readAiwgConfig(projectPath);
  } catch {
    return null;
  }
}

/** Git remote name to fetch URL; `{}` outside a repository or when git fails. */
export async function readGitRemoteUrls(projectPath: string): Promise<Record<string, string>> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', projectPath, 'remote', '-v'], {
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    const urls: Record<string, string> = {};
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (!match) continue;
      const [, name, url, direction] = match;
      if (direction === 'fetch' || !urls[name]) urls[name] = url;
    }
    return urls;
  } catch {
    return {};
  }
}
