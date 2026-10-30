// Fake local deployer for addon provider-selection and install-state tests.
import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export async function main(args) {
  if (args.includes('--dry-run')) return 0;
  const value = flag => args[args.indexOf(flag) + 1];
  const source = value('--source');
  const target = value('--target');
  const provider = value('--provider');
  const skills = path.join(target, provider === 'claude' ? '.claude/skills' : '.agents/skills');
  mkdirSync(skills, { recursive: true });
  for (const name of readdirSync(path.join(source, 'skills'))) {
    const deployed = path.join(skills, name);
    cpSync(path.join(source, 'skills', name), deployed, { recursive: true });
    writeFileSync(path.join(deployed, '.aiwg-managed'), 'aiwg\n');
  }
  return 0;
}
