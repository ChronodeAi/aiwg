#!/usr/bin/env node

/**
 * Behavior management CLI
 *
 * Manage behavior YAML bundles that bind directives and toolsets to agent types.
 * Usage: aiwg behavior <list|info|apply|remove> [name] [options]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { createClient } from './ipc-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');

const SOCKET_PATH = '.aiwg/daemon/daemon.sock';

const args = process.argv.slice(2);
const subcommand = args[0];
const name = args[1];

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    return yaml.load(match[1]);
  } catch {
    return null;
  }
}

function readYamlFile(filePath) {
  try {
    const parsed = yaml.load(fs.readFileSync(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function runtimeBehaviorFromFile(filePath, scope) {
  const meta = readYamlFile(filePath);
  if (!meta?.name) return null;
  const fileName = path.basename(filePath, '.yaml');
  if (meta.name !== fileName) return null;
  return { name: meta.name, path: filePath, scope, kind: 'runtime', meta };
}

function deployableBehaviorFromDir(dirPath, scope) {
  const behaviorPath = path.join(dirPath, 'BEHAVIOR.md');
  if (!fs.existsSync(behaviorPath)) return null;
  let meta = {};
  try {
    meta = parseFrontmatter(fs.readFileSync(behaviorPath, 'utf-8')) || {};
  } catch {
    meta = {};
  }
  return { name: meta.name || path.basename(dirPath), path: behaviorPath, scope, kind: 'deployable', meta };
}

function discoverRuntimeYaml(dir, scope) {
  const entries = [];
  if (!fs.existsSync(dir)) return entries;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue;
    const behavior = runtimeBehaviorFromFile(path.join(dir, entry.name), scope);
    if (behavior) entries.push(behavior);
  }
  return entries;
}

function discoverDeployableDirs(dir, scope) {
  const entries = [];
  if (!fs.existsSync(dir)) return entries;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const behavior = deployableBehaviorFromDir(path.join(dir, entry.name), scope);
    if (behavior) entries.push(behavior);
  }
  return entries;
}

function getBehaviorEntries() {
  const entries = [];

  // Cross-framework behaviors
  const globalDir = path.join(repoRoot, 'agentic', 'code', 'behaviors');
  entries.push(...discoverRuntimeYaml(globalDir, 'framework'));
  entries.push(...discoverDeployableDirs(globalDir, 'global'));

  // Per-framework behaviors
  const frameworksDir = path.join(repoRoot, 'agentic', 'code', 'frameworks');
  if (fs.existsSync(frameworksDir)) {
    for (const fw of fs.readdirSync(frameworksDir, { withFileTypes: true })) {
      if (!fw.isDirectory()) continue;
      const fwBehaviorsDir = path.join(frameworksDir, fw.name, 'behaviors');
      if (!fs.existsSync(fwBehaviorsDir)) continue;
      entries.push(...discoverRuntimeYaml(fwBehaviorsDir, fw.name));
      entries.push(...discoverDeployableDirs(fwBehaviorsDir, fw.name));
    }
  }

  const userDir = path.join(process.env.HOME || '', '.config', 'aiwg', 'behaviors');
  const projectDir = path.join(process.cwd(), '.aiwg', 'behaviors');
  const ordered = [
    ...discoverRuntimeYaml(userDir, 'user'),
    ...entries,
    ...discoverRuntimeYaml(projectDir, 'project'),
  ];

  const byName = new Map();
  for (const entry of ordered) byName.set(entry.name, entry);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function listBehaviors() {
  const behaviors = getBehaviorEntries();
  if (behaviors.length === 0) {
    console.log('No behaviors found.');
    return;
  }

  console.log(`\nBehaviors (${behaviors.length}):\n`);
  for (const b of behaviors) {
    if (b.kind === 'runtime') {
      const agentTypes = (b.meta.agentTypes || []).join(', ') || '-';
      const directives = Array.isArray(b.meta.directives) ? b.meta.directives.length : 0;
      const tools = Array.isArray(b.meta.tools) ? b.meta.tools.length : 0;
      console.log(`  ${b.name}  (${b.scope}, runtime)  agents: ${agentTypes}  directives: ${directives}  tools: ${tools}`);
    } else {
      console.log(`  ${b.name}  (${b.scope}, deployable)`);
    }
  }
  console.log('');
}

function infoBehavior(behaviorName) {
  if (!behaviorName) {
    console.error('Usage: aiwg behavior info <name>');
    process.exit(1);
  }

  const behaviors = getBehaviorEntries();
  const found = behaviors.find(b => b.name === behaviorName);
  if (!found) {
    console.error(`Behavior not found: ${behaviorName}`);
    process.exit(1);
  }

  const content = fs.readFileSync(found.path, 'utf-8');
  console.log(content);
}

function printHelp() {
  console.log(`
Usage: aiwg behavior <subcommand> [name] [options]

Subcommands:
  list              List all available behaviors
  info <name>       Show behavior details
  apply <name>      Apply a behavior to the daemon (not yet implemented)
  remove <name>     Remove a behavior from the daemon (not yet implemented)

Examples:
  aiwg behavior list
  aiwg behavior info security-sentinel
`);
}

async function applyBehavior(behaviorName) {
  if (!behaviorName) {
    console.error('Usage: aiwg behavior apply <name>');
    process.exit(1);
  }

  let client;
  try {
    client = await createClient(SOCKET_PATH);
    const result = await client.call('behaviors.apply', { name: behaviorName });
    console.log(`Behavior applied: ${result.name}`);
  } catch (err) {
    if (err.message && err.message.includes('not running')) {
      console.error('Daemon is not running. Start it with: aiwg daemon start');
    } else {
      console.error(`Failed to apply behavior '${behaviorName}': ${err.message}`);
    }
    process.exit(1);
  } finally {
    client?.disconnect();
  }
}

async function removeBehavior(behaviorName) {
  if (!behaviorName) {
    console.error('Usage: aiwg behavior remove <name>');
    process.exit(1);
  }

  let client;
  try {
    client = await createClient(SOCKET_PATH);
    const result = await client.call('behaviors.remove', { name: behaviorName });
    if (result.removed) {
      console.log(`Behavior removed: ${result.name}`);
    } else {
      console.log(`Behavior '${behaviorName}' was not active`);
    }
  } catch (err) {
    if (err.message && err.message.includes('not running')) {
      console.error('Daemon is not running. Start it with: aiwg daemon start');
    } else {
      console.error(`Failed to remove behavior '${behaviorName}': ${err.message}`);
    }
    process.exit(1);
  } finally {
    client?.disconnect();
  }
}

switch (subcommand) {
  case 'list':
    listBehaviors();
    break;
  case 'info':
    infoBehavior(name);
    break;
  case 'apply':
    applyBehavior(name);
    break;
  case 'remove':
    removeBehavior(name);
    break;
  case '--help':
  case '-h':
  case undefined:
    printHelp();
    break;
  default:
    console.error(`Unknown subcommand: ${subcommand}`);
    printHelp();
    process.exit(1);
}
