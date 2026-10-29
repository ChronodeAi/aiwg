import type { DispatchHostThresholds } from './aiwg-config.js';

export const DEFAULT_DISPATCH_HOST_THRESHOLDS: Readonly<Required<DispatchHostThresholds>>;
export function resolveDispatchHostThresholds(
  buildDispatch?: DispatchHostThresholds,
  admissionHostResources?: DispatchHostThresholds,
  overlay?: DispatchHostThresholds,
  origins?: Record<string, string[]>,
): Required<DispatchHostThresholds>;
