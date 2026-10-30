import type { ZodNumber, ZodString, ZodType } from 'zod';

export function integer(): ZodNumber;
export function dateTime(options?: { offset?: boolean; error?: string }): ZodString;
export function url(): ZodString;
export function number(): ZodType<number>;
