import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const read = (file: string): string => readFileSync(file, 'utf8');
const pinnedNode = 'node:24@sha256:050bf2bbe33c1d6754e060bec89378a79ed831f04a7bb1a53fe45e997df7b3bb';

function packageFiles(directory = '.'): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.git', 'test', 'tests', 'fixtures', 'dist'].includes(entry.name)) return [];
    const file = join(directory, entry.name);
    return entry.isDirectory() ? packageFiles(file) : entry.name === 'package.json' ? [file] : [];
  });
}

const workflows = ['.gitea/workflows', '.github/workflows'].flatMap(directory =>
  readdirSync(directory).filter(file => file.endsWith('.yml')).map(file => `${directory}/${file}`),
).filter(file => file !== '.github/workflows/npm-publish.yml');

describe('Node 24 runtime policy (#3132)', () => {
  it.each(packageFiles())('%s declares Node 24 whenever it has a Node engine', file => {
    const pkg = JSON.parse(read(file));
    if (!pkg.engines?.node) return;
    expect(pkg.engines.node).toBe('>=24');
    const lockfile = file.replace(/package.json$/, 'package-lock.json');
    if (existsSync(lockfile)) {
      expect(JSON.parse(read(lockfile)).packages[''].engines.node).toBe('>=24');
    }
  });

  it.each(['README.md', 'packages/cli/README.md', 'apps/cockpit/README.md'])('%s advertises the current engine floor', file => {
    expect(read(file)).toContain('node-%E2%89%A524-brightgreen');
    expect(read(file)).not.toMatch(/node-%E2%89%A5(?:18|20|22)/);
  });

  it('selects Node 24 for local development', () => {
    expect(read('.nvmrc').trim()).toBe('24');
    if (existsSync('.node-version')) expect(read('.node-version').trim()).toBe('24');
  });

  it.each(workflows)('%s uses the standard pinned runtime', file => {
    const inspect = (value: unknown, key = ''): void => {
      if (typeof value === 'string') {
        if (/^node:\d/.test(value)) expect(value).toBe(pinnedNode);
        if (key === 'node-version' || key === 'NODE_VERSION') expect(value).toMatch(/^24(?:\.x)?$/);
      } else if (Array.isArray(value)) {
        if (key === 'node-version' || key === 'node') expect(value.map(String)).toEqual(['24']);
        else value.forEach(item => inspect(item, key));
      } else if (value && typeof value === 'object') {
        Object.entries(value).forEach(([name, item]) => inspect(item, name));
      } else if (key === 'node-version' || key === 'NODE_VERSION') {
        expect(value).toBe(24);
      }
    };
    inspect(load(read(file)));
  });

  it.each([
    'templates/deploy/static-site/flow.aiwg.io/gitea-deploy.yml',
    'templates/deploy/static-site/per-site-container/gitea-deploy.yml',
  ])('%s deploys with the standard pinned runtime', file => {
    expect(read(file)).toContain(pinnedNode);
    expect(read(file)).not.toMatch(/node:(?:20|22)\b/);
  });

  it('keeps the workflow runtime preflight aligned with the engines floor', () => {
    const workflow = read('.gitea/workflows/fortemi-shard-conformance.yml');
    expect(workflow).toContain("major < 24) throw new Error('Node 24 or newer is required')");
  });

  it('requires Node 24 in generated MCP server manifests', () => {
    expect(read('src/smiths/mcpsmith/generator.ts')).toContain("runtime: ['node >= 24']");
  });

  it('targets Node 24 when bundling the CLI', () => {
    expect(read('tools/cli/build-bundle.mjs')).toContain("target: 'node24'");
  });

  it('uses Node 24 for daemon containers and generated Dockerfiles', () => {
    expect(read('tools/docker/Dockerfile.daemon')).toMatch(/^FROM node:24-slim/);
    const template = read('templates/deploy/docker/node.Dockerfile');
    expect(template).toContain('ARG NODE_VERSION=24');
    expect(template.match(/^FROM node:\$\{NODE_VERSION\}-alpine/gm)).toHaveLength(3);
  });

  it.each(Object.entries({
    'README.md': 'Node.js >=24',
    'packages/cli/README.md': 'Node.js 24 or newer',
    'CONTRIBUTING.md': '≥ 24',
    'WORKSPACE.md': 'node >=24',
    'docs/agentic-install-runbook.md': 'Node.js 24 or newer',
    'docs/getting-started/prerequisites.md': 'Node.js ≥24',
    'docs/getting-started/install-node.md': 'Node.js 24 or newer',
    'docs/getting-started/macos-install.md': 'AIWG requires Node 24 or newer',
    'docs/agents/node-toolchain-installation.md': 'Minimum AIWG runtime: Node.js 24.',
    'docs/contributing/contributor-quickstart.md': 'Version 24.0.0 or higher',
    'docs/contributing/versioning.md': 'Node 24 is required',
    'docs/development/aiwg-development-guide.md': '| **Node.js** | >= 24 |',
    'docs/development/vitest-4-migration.md': 'AIWG requires Node 24+',
    'docs/integrations/warp-terminal.md': 'Node.js 24+',
    'docs/integrations/grok-build-ci.md': 'Node (24+)',
    'docs/providers/omp.md': 'Node.js >=24',
    'docs/agents/providers/omp.md': 'Node.js 24 or newer',
    'docs/agents/providers/pi.md': 'required Node 24 runtime',
    'docs/agent-loop/manual-provider-testing.md': 'required Node 24 runtime',
    'docs/cli/reference.md': 'Node.js ≥24',
    'docs/security/supply-chain-hardening.md': 'Node 24+ for users',
    'docs/security/adopting-this-pattern.md': 'Node 24+',
    'docs/planning/pi-coding-agent/implementation-plan.md': 'AIWG requires Node 24',
    'docs/planning/pi-coding-agent/README.md': 'AIWG requires Node 24',
    'docs/planning/session-intelligence/conformance-and-release-gates.md': 'verification uses Node 24',
    'docs/decision/jev-json-parse.md': 'required Node 24 runtime',
    'setup.aiwg.yaml': 'AIWG requires Node 24 or newer',
    'vscode-extension/TESTING.md': 'Node 24+',
    'test/resources/README.md': 'Vitest on Node.js 24+',
    '.npmrc': 'Node 24 is the standard runtime',
    '.gitea/workflows/README.md': 'node 24.15.0',
    'docs/commands/development-commands-examples.md': 'FROM node:24-alpine',
    'docs/smithing/mcpsmith.md': 'node:24-alpine',
    'docs/frameworks/sdlc-complete/agent-examples/cost-optimizer-examples.md': 'FROM node:24-alpine',
    'docs/frameworks/sdlc-complete/agent-examples/architecture-designer-examples.md': 'Node.js 24.x',
    'docs/frameworks/sdlc-complete/agent-examples/mobile-developer-examples.md': 'node-version: 24',
    'docs/plugin-marketplace-guide.md': "node-version: '24'",
    'docs/daemon-guide.md': 'FROM node:24',
    'tools/daemon/README.md': 'FROM node:24-alpine',
    'tools/install/README.md': 'Node >= 24.0.0',
    'tools/contrib/lib/README.md': 'Node.js:** >= 24.0.0',
    'tools/contrib/start-contribution.mjs': 'Node.js 24.0.0+',
    'templates/deploy/README.md': '| `NODE_VERSION` build arg | Node.js version | `24` |',
  }))('%s documents the standard runtime', (file, requirement) => {
    expect(read(file)).toContain(requirement);
  });

  it('installs Node 24 across the supported shell installer paths', () => {
    const installer = read('tools/install/install.sh');
    expect(installer).toContain('MIN_NODE_VERSION="24.0.0"');
    expect(installer).toContain('Node.js >= 24.0.0');
    expect(installer.match(/setup_24\.x/g)).toHaveLength(5);
    expect(installer).toContain('nodejs24 npm24');
    expect(installer).toContain('brew install node@24');
    expect(installer).not.toMatch(/setup_(?:18|20|22)\.x|node@(?:18|20|22)\b|Hydrogen/);
  });
});
