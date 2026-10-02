export type MuseNativeInspection = {
  cli: string;
  hooks: 'absent' | 'managed' | 'operator-only';
  mcp: 'absent' | 'configured' | 'unreadable';
};

export function inspectMuseNative(options?: {
  projectDir?: string;
  env?: Record<string, string | undefined>;
  userHome?: string;
}): Promise<MuseNativeInspection>;

export function isMuseDeployedProject(projectDir?: string): Promise<boolean>;
