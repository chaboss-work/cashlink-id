// Node tests: protocol encoding round-trips, negative cases, and live reads from Fulcrum + Nostr relays.
// Run: npm test   (Node >= 22 for the global WebSocket)
import { binToHex, hexToBin } from "@bitauth/libauth";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import * as C from "../src/lib/cashlink.js";
import { Fulcrum } from "../src/lib/fulcrum.js";
import { buildTx, formatBch, type Utxo } from "../src/lib/tx.js";
import { chainCommitments, decodeTx, verifyBindingEvent, verifyPubkey } from "../src/lib/verify.js";
import { fetchRecentBindings, relayPool, RELAYS } from "../src/lib/nostr.js";

let failed = 0;
const ok = (cond: unknown, name: string, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failed++;
};

const ADDR = "bitcoincash:qrcjtu5lg8l3hgtflqjaap784eqntgdsrcup0jf9fz";
const ZADDR = "bitcoincash:zrcjtu5lg8l3hgtflqjaap784eqntgdsrcmtuv8rk3";
const SPIKE_TX = "1c4178d7aa3e7114d8bb5b02fbc4d632318c1f4c5fdfa22e8bfe0d709467e024";

// ---- pure
const n = C.normalizeAddress(ZADDR.replace("bitcoincash:", ""));
ok(n?.address === ADDR && n?.tokenAddress === ZADDR, "normalizeAddress: z-address → q-address");
ok(C.normalizeAddress("bchtest:qq04n9zyt4h0qahaxp5wa7k6uyzpl5yqsvk3yk3gy") === null, "normalizeAddress rejects testnet");
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const st = C.makeStatement(pk, ZADDR, 1763100000);
ok(st === `{"protocol":"cashlink-id","v":1,"nostr":"${pk}","bch":"${ADDR}","created":1763100000}`, "statement is canonical and uses the q-address");
ok(C.parseStatement(st)?.bch === ADDR, "parseStatement round-trip");
ok(C.parseStatement(st.replace('"v":1,', '"v":1, ')) === null, "parseStatement rejects non-canonical whitespace");
const h = C.statementHash(st);
const script = C.commitmentScript(pk, h);
const c = C.parseCommitment(script);
ok(c?.nostr === pk && c?.hash === binToHex(h) && c?.version === 1 && script.length === 73, "commitment script round-trip (73 bytes)");
ok(C.parseCommitment(C.authScript(new Uint8Array(32))) === null, "auth script is not a commitment");
const tmpl = C.bindingEventTemplate(st, SPIKE_TX);
ok(C.eventTxid(tmpl.tags) === SPIKE_TX && C.eventAddressTag(tmpl.tags) === `bitcoincash:address:${ADDR.slice(12)}`, "binding event tags (NIP-73 i tags)");
const rev = C.makeRevocation(pk, 1763100001);
ok(C.parseStatement(rev)?.revoked === true, "revocation statement parses");

// tx builder
const lock = n!.lockingBytecode;
const u = (v: bigint, i: number): Utxo => ({ txid: "11".repeat(32), vout: i, value: v, height: 1, path: "receive", index: 0, address: ADDR, lockingBytecode: lock });
const plan = buildTx([u(100000n, 0), u(5000n, 1)], [{ lockingBytecode: script, valueSatoshis: 0n }], lock);
ok(plan.inputs.length === 1 && plan.fee > 200n && plan.fee < 400n && plan.changeIndex === 1, "commitment plan: 1 input, ~1 sat/B fee, change", `fee ${plan.fee}, size ${plan.size}+sigs`);
const pay = buildTx([u(3000n, 0), u(2000n, 1)], [{ lockingBytecode: lock, valueSatoshis: 4300n }], lock);
ok(pay.inputs.length === 2 && pay.changeIndex === -1, "payment plan: 2 inputs, sub-dust change dropped", `fee ${pay.fee}`);
let threw = false;
try {
  buildTx([u(1000n, 0)], [{ lockingBytecode: lock, valueSatoshis: 5000n }], lock);
} catch {
  threw = true;
}
ok(threw, "insufficient funds throws");
const zero = buildTx([u(5000n, 0)], [{ lockingBytecode: C.authScript(new Uint8Array(32)), valueSatoshis: 0n }], lock, 0n);
ok(zero.fee === 0n && zero.outputs[1].valueSatoshis === 5000n, "zero-fee auth plan returns the full value");
ok(formatBch(8504643n) === "0.08504643" && formatBch(100000000n) === "1", "formatBch");

// ---- live
const f = new Fulcrum();
try {
  const tip = await f.tipHeight();
  ok(tip > 976000, "Fulcrum tip", `${tip} via ${f.server}`);
  const tx = decodeTx(await f.getTransaction(SPIKE_TX));
  const pushes = C.opReturnPushes(tx.outputs[0].lockingBytecode);
  ok(pushes && new TextDecoder().decode(pushes[0]) === "CLID" && C.parseCommitment(tx.outputs[0].lockingBytecode) === null, "spike tx: CLID test note is not a valid commitment");
  const chain = await chainCommitments(ADDR, f);
  console.log(`      on-chain commitments for ${ADDR.slice(12, 22)}…: ${chain.length}`, chain.map((x) => `${x.txid.slice(0, 10)}→${x.nostr.slice(0, 10)}`).join(" "));
  // A forged binding: valid Nostr signature, but the tx does not commit to it.
  const forged = finalizeEvent(C.bindingEventTemplate(st, SPIKE_TX), sk);
  const v = await verifyBindingEvent(forged as any, f);
  ok(v.state === "invalid" && v.checks.find((x) => x.id === "commit")?.status === "fail", "forged event pointing at someone else's tx is rejected", v.reason);
} catch (e) {
  ok(false, "Fulcrum live checks", String(e));
}
try {
  const none = await verifyPubkey(pk, f);
  ok(none.state === "none", "random key has no binding");
  const recent = await fetchRecentBindings(10);
  console.log(`      recent CashLink bindings on ${RELAYS.length} relays: ${recent.length}`);
  for (const e of recent.slice(0, 3)) {
    const r = await verifyBindingEvent(e, f);
    console.log(`      ${e.pubkey.slice(0, 12)}… → ${r.state} ${r.address ?? ""} ${r.reason ?? ""}`);
  }
} catch (e) {
  ok(false, "Nostr live checks", String(e));
}
f.close();
relayPool().close(RELAYS);
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
