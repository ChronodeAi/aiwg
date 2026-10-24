export function checkForUpdates(): Promise<void>;
export function forceUpdateCheck(): Promise<void>;
export function checkUpdateStatus(options?: { channel?: string }): Promise<{
  status: string; channel: string; checkOnly: boolean; reason?: string;
  current?: string; latest?: string; available?: boolean;
}>;
