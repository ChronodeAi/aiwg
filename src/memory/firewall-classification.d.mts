export interface ContextMemoryMetadata { digest?: string; hash?: string; trust?: string }
export function classifyContextMemory(input: {
  digest: string; managed: boolean;
  manifest?: ContextMemoryMetadata | null;
  baselineEntry?: ContextMemoryMetadata | null;
  threat?: { poisoning: boolean; signals: string[] };
}): { trust: string; reviewStatus: string; findings: string[]; manifestDrift: boolean };
