// Re-publish the newest CashLink binding (and kind 0 profile) of a pubkey to all relays, printing each relay's answer.
import { SimplePool } from "nostr-tools/pool";
import * as nip19 from "nostr-tools/nip19";
const RELAYS = ["wss://nos.lol", "wss://relay.primal.net", "wss://relay.damus.io", "wss://nostr.mom", "wss://relay.nostr.band", "wss://offchain.pub", "wss://relay.snort.social"];
const arg = process.argv[2];
const pubkey = arg.startsWith("npub") ? (nip19.decode(arg).data as string) : arg;
const pool = new SimplePool();
const evs = await pool.querySync(RELAYS, { authors: [pubkey], kinds: [0, 30078] }, { maxWait: 5000 });
const byKind = new Map<number, any>();
for (const e of evs) if (!byKind.has(e.kind) || byKind.get(e.kind).created_at < e.created_at) byKind.set(e.kind, e);
for (const [kind, e] of byKind) {
  console.log(`kind ${kind} event ${e.id.slice(0, 12)}…`);
  const res = await Promise.allSettled(pool.publish(RELAYS, e));
  res.forEach((r, i) => console.log(`  ${RELAYS[i]}: ${r.status === "fulfilled" ? "ok " + (r.value ?? "") : "REJECTED " + String(r.reason)}`));
}
pool.close(RELAYS);
process.exit(0);
