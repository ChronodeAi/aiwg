import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inspectMuseNative,
  isMuseDeployedProject,
} from '../../../src/mcp/muse-native-config.mjs';
import {
  AIWG_MANAGED_HOOKS,
  MUSE_HOOKS_REL,
  MUSE_HOOKS_SIDECAR_REL,
  assertMuseUserSettingsPath,
} from '../../../tools/agents/providers/muse-hooks.mjs';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-muse-native-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function env(extra: Record<string, string> = {}) {
  return { ...process.env, PATH: '', XDG_CONFIG_HOME: path.join(root, 'xdg'), ...extra };
}

describe('Muse native doctor inspector', () => {
  it('reports an absent CLI as informational inventory', async () => {
    const result = await inspectMuseNative({ projectDir: root, env: env() });
    expect(result.cli).toBe('absent');
  });

  it('reports hooks as absent, managed, or operator-only', async () => {
    await expect(inspectMuseNative({ projectDir: root, env: env() }))
      .resolves.toMatchObject({ hooks: 'absent' });

    writeJson(path.join(root, MUSE_HOOKS_REL), {
      hooks: { SessionStart: [AIWG_MANAGED_HOOKS[0].group] },
    });
    writeJson(path.join(root, MUSE_HOOKS_SIDECAR_REL), {
      version: 1,
      hooks: [{ id: AIWG_MANAGED_HOOKS[0].id, event: 'SessionStart', group: AIWG_MANAGED_HOOKS[0].group }],
    });
    await expect(inspectMuseNative({ projectDir: root, env: env() }))
      .resolves.toMatchObject({ hooks: 'managed' });

    writeJson(path.join(root, MUSE_HOOKS_REL), {
      hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: './operator.sh' }] }] },
    });
    await expect(inspectMuseNative({ projectDir: root, env: env() }))
      .resolves.toMatchObject({ hooks: 'operator-only' });
  });

  it('does not claim a canonical-looking group without the AIWG sidecar record', async () => {
    writeJson(path.join(root, MUSE_HOOKS_REL), {
      hooks: { SessionStart: [AIWG_MANAGED_HOOKS[0].group] },
    });
    await expect(inspectMuseNative({ projectDir: root, env: env() }))
      .resolves.toMatchObject({ hooks: 'operator-only' });
  });

  it('reads commented hooks.json without corrupting URLs or globs in strings', async () => {
    const group = { matcher: 'src/**/*.ts', hooks: [{ type: 'command', command: 'curl -s https://hooks.example.com' }] };
    fs.mkdirSync(path.join(root, '.muse'), { recursive: true });
    fs.writeFileSync(path.join(root, MUSE_HOOKS_REL), `// operator note\n${JSON.stringify({ hooks: { SessionStart: [group] } })}\n`);
    writeJson(path.join(root, MUSE_HOOKS_SIDECAR_REL), { version: 1, hooks: [{ id: 'x', event: 'SessionStart', group }] });
    await expect(inspectMuseNative({ projectDir: root, env: env() }))
      .resolves.toMatchObject({ hooks: 'managed' });
  });

  it('reports MCP as absent, configured, or unreadable without exposing settings', async () => {
    await expect(inspectMuseNative({ projectDir: root, env: env() }))
      .resolves.toMatchObject({ mcp: 'absent' });

    const settings = assertMuseUserSettingsPath(env());
    writeJson(settings, { mcp_servers: { aiwg: { command: 'aiwg', args: ['mcp', 'serve'] } } });
    await expect(inspectMuseNative({ projectDir: root, env: env() }))
      .resolves.toMatchObject({ mcp: 'configured' });

    fs.rmSync(settings);
    fs.mkdirSync(settings);
    await expect(inspectMuseNative({ projectDir: root, env: env() }))
      .resolves.toMatchObject({ mcp: 'unreadable' });

    await expect(inspectMuseNative({ projectDir: root, env: env({ XDG_CONFIG_HOME: 'relative' }) }))
      .resolves.toMatchObject({ mcp: 'unreadable' });
  });

  it('recognizes Muse as deployed only from project configuration', async () => {
    await expect(isMuseDeployedProject(root)).resolves.toBe(false);

    writeJson(path.join(root, '.aiwg', 'aiwg.config'), { providers: ['muse'] });
    await expect(isMuseDeployedProject(root)).resolves.toBe(true);

    writeJson(path.join(root, '.aiwg', 'aiwg.config'), {
      installed: { sdlc: { deployedTo: { muse: { skills: 1 } } } },
    });
    await expect(isMuseDeployedProject(root)).resolves.toBe(true);
  });
});
