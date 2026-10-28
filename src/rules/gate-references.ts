/** Resolve rule coverage declarations through the existing composed gate registry. */
import type { GateRegistry } from '../gates/registry.js';

export function ruleGateReferenceErrors(references: string[], registry: Pick<GateRegistry, 'resolvePack'>): string[] {
  const errors: string[] = [];
  for (const reference of references) {
    const [packId, gateId] = reference.split('#');
    try {
      const pack = registry.resolvePack(packId).resolved;
      if (!pack.spec.gates.some(gate => gate.id === gateId)) throw new Error(`unknown gate '${gateId}' in ${packId}`);
    } catch (error) {
      errors.push(`enforcedBy '${reference}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}
