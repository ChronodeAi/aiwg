export interface SkillReceipt {
  skillSource?: string;
  managed?: Record<string, { hash: string; frameworkSlug?: string; source?: string; version?: string }>;
}
export interface SkillRemovalPlanEntry {
  path: string;
  action: 'remove' | 'preserve';
  reason: string;
}
export interface SkillRemovalOptions {
  dryRun?: boolean;
  plan?: SkillRemovalPlanEntry[];
}
export function extractFrameworkSlug(source: string): string | null;
export function sameSkillOwner(receipt: SkillReceipt | null, skillSource: string, frameworkSlug?: string | null): boolean;
export function canDeploySkill(receipt: SkillReceipt | null, skillSource: string, opts?: { force?: boolean }): boolean;
export function pruneRecordedSkillFiles(skillDir: string, managed: SkillReceipt['managed'], desired: Set<string>, opts?: SkillRemovalOptions): void;
export function releaseSkillOwnership(skillDir: string, owner: { frameworkSlug?: string; skillSource?: string; sourceRoot?: string }, opts?: SkillRemovalOptions): boolean | null;
