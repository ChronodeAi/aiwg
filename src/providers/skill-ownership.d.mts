export interface SkillReceipt {
  skillSource?: string;
  managed?: Record<string, { hash: string; frameworkSlug?: string; source?: string; version?: string }>;
}
export function extractFrameworkSlug(source: string): string | null;
export function sameSkillOwner(receipt: SkillReceipt | null, skillSource: string, frameworkSlug?: string | null): boolean;
export function canDeploySkill(receipt: SkillReceipt | null, skillSource: string, opts?: { force?: boolean }): boolean;
export function pruneRecordedSkillFiles(skillDir: string, managed: SkillReceipt['managed'], desired: Set<string>, opts?: { dryRun?: boolean }): void;
export function releaseSkillOwnership(skillDir: string, owner: { frameworkSlug?: string; skillSource?: string; sourceRoot?: string }, opts?: { dryRun?: boolean }): boolean | null;
