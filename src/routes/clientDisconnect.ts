import type { FastifyReply } from "fastify";

/**
 * An AbortController that fires when the client goes away mid-request.
 *
 * Every route that calls a paid, slow external provider needs this, and each
 * one used to inline it — which is how the same eight lines ended up in three
 * files and tripped the duplication gate.
 *
 * The subtlety worth keeping in one place: this watches the **response**, not
 * the request. `IncomingMessage` emits "close" as soon as an ordinary request
 * body finishes arriving, so watching `request.raw` would abort the work
 * immediately, every time. A close on the response before `writableEnded`
 * means the client actually disconnected while waiting for the result.
 */
export function abortOnClientDisconnect(reply: FastifyReply): AbortController {
  const controller = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableEnded) {
      controller.abort();
    }
  });
  return controller;
}
