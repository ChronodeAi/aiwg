// Synthetic plugin projects and API probes for packed CLI deployment tests.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function writeJson(filename: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
}

export async function createExternalPluginProject(
  project: string,
  platforms: Record<string, 'full' | 'partial' | 'experimental' | 'none'> = { claude: 'full', codex: 'full' },
): Promise<string> {
  const wrapper = path.join(project, '.aiwg', 'plugins', 'bt6-maintainer');
  const payload = path.join(wrapper, 'payload');
  await writeJson(path.join(wrapper, 'manifest.json'), {
    id: 'bt6-maintainer',
    type: 'plugin',
    name: 'BT6 Maintainer',
    version: '0.2.0',
    description: 'External plugin fixture for packed CLI deployment',
    manifestVersion: '1',
    platforms,
    keywords: ['bt6', 'maintainer'],
    deployment: { pathTemplate: '.aiwg/plugins/bt6-maintainer' },
    pluginConfig: { payloadType: 'addon', payloadPath: 'payload/' },
  });
  await writeJson(path.join(payload, 'manifest.json'), {
    id: 'bt6-maintainer-core',
    type: 'addon',
    name: 'BT6 Maintainer Core',
    version: '0.2.0',
    description: 'Payload for the BT6 Maintainer external plugin fixture',
    manifestVersion: '1',
    platforms,
    keywords: ['bt6', 'maintainer'],
    deployment: { pathTemplate: '.aiwg/addons/bt6-maintainer-core' },
    addonConfig: { entry: { agents: 'agents/', skills: 'skills/', rules: 'rules/' } },
  });
  for (let index = 1; index <= 5; index += 1) {
    const agentName = `bt6-fixture-agent-${index}`;
    await mkdir(path.join(payload, 'agents'), { recursive: true });
    await writeFile(
      path.join(payload, 'agents', `${agentName}.md`),
      `---\nname: ${agentName}\ndescription: Packed CLI fixture agent ${index}\nmodel: claude-sonnet-4-6\ntools: Read, Bash\n---\n\n# ${agentName}\n`,
    );
    const skillName = `bt6-fixture-skill-${index}`;
    await mkdir(path.join(payload, 'skills', skillName), { recursive: true });
    await writeFile(
      path.join(payload, 'skills', skillName, 'SKILL.md'),
      `---\nname: ${skillName}\ndescription: Packed CLI fixture skill ${index}\n---\n\n# ${skillName}\n`,
    );
  }
  await mkdir(path.join(payload, 'rules'), { recursive: true });
  await writeFile(
    path.join(payload, 'rules', 'bt6-fixture-rule.md'),
    '---\nid: bt6-fixture-rule\nname: bt6-fixture-rule\n---\n\n# BT6 fixture rule\n',
  );
  return wrapper;
}

export async function listRelativeFiles(directory: string, relative = ''): Promise<string[]> {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryRelative = path.join(relative, entry.name);
    return entry.isDirectory()
      ? listRelativeFiles(directory, entryRelative)
      : [entryRelative];
  }));
  return files.flat().sort();
}

export function probeCliApi(args: string[], installRoot: string, tempRoot: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const requireFromPrefix = createRequire(path.join(path.dirname(installRoot), 'api-probe.mjs'));
  const entry = requireFromPrefix.resolve('@aiwg/cli');
  const script = [
    `const api = await import(${JSON.stringify(entry)});`,
    `await api.run(${JSON.stringify(args)}, { cwd: ${JSON.stringify(tempRoot)} });`,
    `process.exit(0);`,
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: tempRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function listFixtureEntries(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((entry) => entry.startsWith('bt6-fixture-')).sort();
}
