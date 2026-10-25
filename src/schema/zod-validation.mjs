import { z } from 'zod';

/** Preserve integer validation without narrowing existing inputs to safe integers. */
export function integer() {
  return z.number().check(context => {
    if (!Number.isInteger(context.value)) {
      context.issues.push({ code: 'invalid_type', expected: 'int', input: context.value, continue: true });
    }
  }).meta({ type: 'integer' });
}

// Calendar validation includes leap years. Existing timestamps also permit minute
// precision and numeric offsets without a colon.
const calendar = String.raw`((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))`;
const time = String.raw`([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?`;

/**
 * Keep the timestamp grammar accepted by existing persisted AIWG documents.
 * @param {{ offset?: boolean, error?: string }} [options]
 */
export function dateTime({ offset = false, error } = {}) {
  const zone = offset ? String.raw`(Z|[+-]\d{2}:?\d{2})` : 'Z';
  const pattern = new RegExp(`^${calendar}T${time}${zone}$`);
  return z.string().check(context => {
    if (!pattern.test(context.value)) {
      context.issues.push({ code: 'invalid_format', format: 'datetime', input: context.value, continue: true,
        ...(error === undefined ? {} : { message: error }) });
    }
  }).meta({ format: 'date-time' });
}

/** Validate URLs without rewriting their stored spelling or whitespace. */
export function url() {
  return z.string().check(context => {
    try {
      new URL(context.value);
    } catch {
      context.issues.push({ code: 'invalid_format', format: 'url', input: context.value, continue: true });
    }
  }).meta({ format: 'uri' });
}

/** Preserve numeric documents that may carry infinite measurements. */
export function number() {
  return z.unknown().check(context => {
    if (typeof context.value !== 'number' || Number.isNaN(context.value)) {
      context.issues.push({ code: 'invalid_type', expected: 'number', input: context.value, continue: false });
    }
  }).meta({ type: 'number' });
}
