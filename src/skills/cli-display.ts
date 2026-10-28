// Display skill discovery results and explain selected collision owners.
import type { SkillResult } from './types.js';

export function displaySkillCollisions(skill: SkillResult): void {
  for (const diagnostic of skill.diagnostics ?? []) {
    console.log(`  ${diagnostic.code}: ${diagnostic.message} (${diagnostic.file})`);
  }
}

/**
 * Format skill results as a table
 */
export function displaySkillsTable(skills: SkillResult[]): void {
  if (skills.length === 0) {
    console.log('  No skills found.');
    return;
  }

  // Group by source
  const bySource = new Map<string, SkillResult[]>();
  for (const skill of skills) {
    const list = bySource.get(skill.source) || [];
    list.push(skill);
    bySource.set(skill.source, list);
  }

  for (const [source, sourceSkills] of bySource) {
    console.log(`\n  ${source} (${sourceSkills.length} skills):`);
    console.log('  ' + '-'.repeat(70));

    for (const skill of sourceSkills) {
      const name = skill.name.padEnd(28);
      const pkg = (skill.package || '').padEnd(18);
      const desc = skill.description.slice(0, 40);
      console.log(`  ${name} ${pkg} ${desc}`);
      displaySkillCollisions(skill);
    }
  }
}

