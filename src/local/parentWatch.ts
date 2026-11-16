// Exit with the parent. Electron's utilityProcess `parentPort` does not emit
// "close" when the main process dies, so the entry also polls the parent pid.

export interface WatchParentOptions {
  /** The parent pid remembered at start. */
  ppid: number;
  onGone: () => void;
  intervalMs?: number;
  /** Test seams. */
  currentPpid?: () => number;
  kill?: (pid: number, signal: 0) => unknown;
}

/** Polls until the parent is gone (pid reparented, or signal 0 → ESRCH), then calls onGone once. Returns a stop function. */
export function watchParent(options: WatchParentOptions): () => void {
  const { ppid, onGone, intervalMs = 2000, currentPpid = () => process.ppid, kill = process.kill.bind(process) } = options;
  let fired = false;
  const timer = setInterval(() => {
    let gone = currentPpid() !== ppid;
    if (!gone) {
      try {
        kill(ppid, 0);
      } catch (err) {
        // EPERM = alive but not ours to signal; only ESRCH means gone.
        gone = (err as NodeJS.ErrnoException).code === "ESRCH";
      }
    }
    if (gone && !fired) {
      fired = true;
      clearInterval(timer);
      onGone();
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
