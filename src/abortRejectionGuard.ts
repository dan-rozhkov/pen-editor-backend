// A cancelled request must never take the server down. Libraries on the
// abort path sometimes drop a promise that then rejects with AbortError —
// @openrouter/ai-sdk-provider@3.1.0 did (see patches/), and Node's default
// unhandled-rejection mode killed the whole process on every client
// disconnect that hit it. Only AbortError is absorbed: any other unhandled
// rejection is rethrown and still crashes, exactly as without this guard.

export function isAbortRejection(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { name?: unknown }).name === "AbortError"
  );
}

export function handleUnhandledRejection(
  reason: unknown,
  warn: (message: string) => void = console.warn,
): void {
  if (!isAbortRejection(reason)) throw reason;
  warn(`[process] Ignored unhandled AbortError rejection: ${(reason as Error).message}`);
}

export function installAbortRejectionGuard(): void {
  process.on("unhandledRejection", (reason) => handleUnhandledRejection(reason));
}
