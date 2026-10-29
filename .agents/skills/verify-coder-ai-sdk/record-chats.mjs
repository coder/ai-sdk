// Preloaded into every example by verify.sh (NODE_OPTIONS=--import). It
// appends the id of each chat that the example creates to $VERIFY_CHAT_LOG,
// so the drive and cleanup know exactly which chats this run owns, even when
// the example dies before it prints an id. It only observes: the example gets
// the same response object, and the recorder reads a clone of it.
import { appendFileSync } from "node:fs";

const log = process.env.VERIFY_CHAT_LOG;
const realFetch = globalThis.fetch;

if (log && realFetch) {
  globalThis.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    try {
      const request = input instanceof Request ? input : undefined;
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
      const url = new URL(request?.url ?? String(input));
      if (
        method === "POST" &&
        /\/api\/(v2|experimental)\/chats\/?$/.test(url.pathname) &&
        response.ok
      ) {
        const chat = await response.clone().json();
        // Chat ids are UUIDs; anything else is not a created chat.
        const id = String(chat?.id ?? "");
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
          appendFileSync(log, `${id}\n`);
        }
      }
    } catch {
      // A recorder failure must not change the example's behavior.
    }
    return response;
  };
}
