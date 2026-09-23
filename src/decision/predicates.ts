import type { DecisionPredicate, DecisionResult } from './types.js';
import { resolveJsonPointer } from './validate.js';

export type TruthValue = true | false | 'unknown';

export function evaluatePredicate(
  predicate: DecisionPredicate,
  input: unknown,
  decisions: Record<string, DecisionResult>,
): TruthValue {
  if ('all' in predicate) {
    const values = predicate.all.map(item => evaluatePredicate(item, input, decisions));
    if (values.includes(false)) return false;
    return values.includes('unknown') ? 'unknown' : true;
  }
  if ('any' in predicate) {
    const values = predicate.any.map(item => evaluatePredicate(item, input, decisions));
    if (values.includes(true)) return true;
    return values.includes('unknown') ? 'unknown' : false;
  }
  if ('not' in predicate) {
    const value = evaluatePredicate(predicate.not, input, decisions);
    return value === 'unknown' ? value : !value;
  }

  const source = predicate.left.source === 'input'
    ? input
    : predicate.left.alias
      ? decisions[predicate.left.alias]?.spec
      : undefined;
  const resolved = resolveJsonPointer(source, predicate.left.pointer);
  if (predicate.op === 'exists') return resolved.found;
  if (!resolved.found) return 'unknown';
  const left = resolved.value;
  const right = predicate.right;

  if (predicate.op === 'eq' || predicate.op === 'ne') {
    const equal = structurallyEqual(left, right);
    return predicate.op === 'eq' ? equal : !equal;
  }
  if ((typeof left !== 'number' && typeof left !== 'string') || typeof left !== typeof right) return 'unknown';
  if (typeof left === 'number' && (!Number.isFinite(left) || !Number.isFinite(right as number))) return 'unknown';
  if (typeof left === 'number' && typeof right === 'number') {
    switch (predicate.op) {
      case 'lt': return left < right;
      case 'lte': return left <= right;
      case 'gt': return left > right;
      case 'gte': return left >= right;
    }
  }
  if (typeof left === 'string' && typeof right === 'string') {
    switch (predicate.op) {
      case 'lt': return left < right;
      case 'lte': return left <= right;
      case 'gt': return left > right;
      case 'gte': return left >= right;
    }
  }
  return 'unknown';
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => structurallyEqual(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && structurallyEqual(left[key], right[key]));
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
