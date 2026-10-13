// Fixture child process for bounded-child-process tests (#3062): traps and
// ignores SIGTERM so the test can prove a bounded call still returns within
// its bound (via SIGKILL, which cannot be ignored) rather than hanging.
process.on('SIGTERM', () => {
  // Deliberately do nothing — the whole point is to outlive SIGTERM.
});
setInterval(() => {}, 1000);
