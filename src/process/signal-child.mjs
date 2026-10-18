/** Signal only a child that acquired a real PID. Failed spawns can retain a
 * native handle with PID zero until their asynchronous error event arrives.
 * Keep native return/throw behavior so callers retain their stop semantics. */
export function signalChild(child, signal) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return false;
  return !!child.kill(signal);
}
