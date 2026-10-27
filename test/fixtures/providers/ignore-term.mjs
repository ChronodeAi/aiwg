// Signal readiness only after the synthetic child's TERM handler is installed.
export const TERM_READY = 'AIWG_FAKE_TERM_READY\n';

export function ignoreTermUntilKilled() {
  process.on('SIGTERM', () => {});
  process.stdout.write(TERM_READY);
  setInterval(() => {}, 1000);
}
