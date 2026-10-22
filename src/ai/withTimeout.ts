// Bounds the memory-snapshot read on top of (not instead of) the pool's own
// connectionTimeoutMillis (src/tracing/traceStore.ts): that setting only
// covers acquiring a connection, but a connection that IS acquired can still
// hang mid-query if the network black-holes packets after the handshake
// (no RST, so the client never sees a rejected promise). Racing the read
// against a short local timer is what actually caps every request's worst
// case, since a hang here — not an exception — is exactly what a plain
// try/catch cannot degrade from.
export const MEMORY_SNAPSHOT_TIMEOUT_MS = 2_000;

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
