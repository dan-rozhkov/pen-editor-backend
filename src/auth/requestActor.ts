// Who is making the request that is currently inside Better Auth. Two
// organization hooks (remove-member, update-member-role) are handed only the
// AFFECTED account, so the audit row cannot name the actor from hook data.
// The /api/auth/* route wraps its handler call in runWithAuthRequest; the hook
// then reads the actor's session from that request. Session cookies only: the
// organization endpoints are session endpoints.
import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyRequest } from "fastify";
import { toWebHeaders } from "./webBridge.js";

const current = new AsyncLocalStorage<FastifyRequest>();

export function runWithAuthRequest<T>(request: FastifyRequest, fn: () => T): T {
  return current.run(request, fn);
}

/** The signed-in account behind the request being served, or null (no request, no session). */
export async function currentActorUserId(): Promise<string | null> {
  const request = current.getStore();
  const auth = request?.server.auth;
  if (!request || !auth || !request.headers.cookie) return null;
  try {
    const session = await auth.api.getSession({ headers: toWebHeaders(request.headers) });
    return session?.user.id ?? null;
  } catch {
    return null;
  }
}
