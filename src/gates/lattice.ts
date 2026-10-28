// Shared severity ordering and never-upgrade validation for gate outcomes.
export type GateOutcome = 'PROMOTE' | 'HOLD' | 'ROLLBACK';

export const GATE_RANK: Readonly<Record<GateOutcome, number>> = Object.freeze({ PROMOTE: 0, HOLD: 1, ROLLBACK: 2 });

/** The strictest outcome wins; an empty set has no restriction. */
export function maxOutcome(...outcomes: readonly GateOutcome[]): GateOutcome {
  return outcomes.reduce((worst, outcome) => GATE_RANK[outcome] > GATE_RANK[worst] ? outcome : worst, 'PROMOTE');
}

/** Apply component ceilings without ever upgrading the proposed decision. */
export function ceilingDecision(decision: 'HOLD' | 'ROLLBACK', ...ceilings: readonly GateOutcome[]): 'HOLD' | 'ROLLBACK';
export function ceilingDecision(decision: GateOutcome, ...ceilings: readonly GateOutcome[]): GateOutcome;
export function ceilingDecision(decision: GateOutcome, ...ceilings: readonly GateOutcome[]): GateOutcome {
  return maxOutcome(decision, ...ceilings);
}

export class GateDecisionUpgradeError extends Error {
  readonly code = 'report-upgrades-component';
  readonly decision: GateOutcome;
  readonly component: GateOutcome;
  constructor(decision: GateOutcome, component: GateOutcome) {
    super(`Report decision differs from components: cannot upgrade ${component} to ${decision} (report-upgrades-component)`);
    this.name = 'GateDecisionUpgradeError';
    this.decision = decision;
    this.component = component;
  }
}

/** Validate a carried verdict independently of its digest or reproducibility checks. */
export function assertDecisionCeiling(decision: GateOutcome, ...components: readonly GateOutcome[]): void {
  const component = maxOutcome(...components);
  if (GATE_RANK[decision] < GATE_RANK[component]) throw new GateDecisionUpgradeError(decision, component);
}
