// Keep the watchdog alive after a transient cleanup failure. finish() returns
// true only when it is safe to exit; a throw keeps the interval armed for retry.
export function startWatchdogLoop(pollMs: number, finish: () => boolean, exit: () => void): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    try {
      if (!finish()) return;
      clearInterval(timer);
      exit();
    } catch {
      // Lock timeout or transient I/O error: retry on the next tick.
    }
  }, pollMs);
  return timer;
}
