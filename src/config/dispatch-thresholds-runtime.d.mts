import type { DispatchHostThresholds } from './aiwg-config.js';

export const DEFAULT_DISPATCH_HOST_THRESHOLDS: Readonly<Required<Omit<DispatchHostThresholds, 'max_workers'>>>;
export function resolveDispatchHostThresholds(
  buildDispatch?: DispatchHostThresholds,
  admissionHostResources?: DispatchHostThresholds,
  overlay?: DispatchHostThresholds,
): Required<Omit<DispatchHostThresholds, 'max_workers'>> & Pick<DispatchHostThresholds, 'max_workers'>;
