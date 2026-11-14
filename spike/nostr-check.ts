// Spike: read-only check of public Nostr relays with nostr-tools (no publishing).
import { SimplePool } from "nostr-tools/pool";
import { useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket from "ws";
useWebSocketImplementation(WebSocket as any);
const relays = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
const pool = new SimplePool();
const t0 = Date.now();
const events = await pool.querySync(relays, { kinds: [1], limit: 5 }, { maxWait: 8000 });
console.log(`kind-1 events received: ${events.length} in ${Date.now() - t0} ms`);
for (const r of relays) {
  try { const s = await pool.ensureRelay(r); console.log(r, "connected:", s.connected); } catch (e) { console.log(r, "error", String(e).slice(0, 100)); }
}
pool.close(relays);
process.exit(0);
