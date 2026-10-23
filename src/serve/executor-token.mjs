import { createHash, timingSafeEqual } from 'node:crypto';

/** Compare bearer tokens using fixed-size digests, including unequal-length input. */
export function executorTokensEqual(expected, presented) {
  if (typeof expected !== 'string' || !expected || typeof presented !== 'string' || !presented) return false;
  const digest = value => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(expected), digest(presented));
}
