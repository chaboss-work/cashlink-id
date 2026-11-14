// Independent verifier for CashLink ID bindings: needs only public Nostr relays and any Fulcrum server.
import {
  binToHex,
  createVirtualMachineBCH,
  decodeAuthenticationInstructions,
  decodeTransaction,
  hash160,
  hashTransaction,
  hexToBin,
  type TransactionCommon,
  type Output,
} from "@bitauth/libauth";
import {
  BINDING_KIND,
  D_TAG,
  PREFIX,
  addressTag,
  eventAddressTag,
  eventTxid,
  normalizeAddress,
  opReturnPushes,
  parseCommitment,
  parseStatement,
  scriptHash,
  statementHash,
} from "./cashlink.js";
import type { Fulcrum } from "./fulcrum.js";
import { fetchBindingEvent, fetchBindingsForAddress, verifyEvent, type Event } from "./nostr.js";

export type CheckStatus = "pass" | "fail" | "pending" | "info";
export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

export interface Verification {
  state: "verified" | "unconfirmed" | "invalid" | "none" | "revoked";
  pubkey: string;
  address?: string;
  tokenAddress?: string;
  txid?: string;
  height?: number;
  confirmations?: number;
  linkedAt?: number;
  event?: Event;
  statement?: string;
  checks: Check[];
  reason?: string;
}

const vm = createVirtualMachineBCH(false);

export function decodeTx(hex: string): TransactionCommon {
  const tx = decodeTransaction(hexToBin(hex));
  if (typeof tx === "string") throw new Error(`cannot decode transaction: ${tx}`);
  return tx;
}

/** Source outputs of every input, fetched from Fulcrum. */
export async function sourceOutputsOf(tx: TransactionCommon, f: Fulcrum): Promise<Output[]> {
  return Promise.all(
    tx.inputs.map(async (i) => {
      const prev = decodeTx(await f.getTransaction(binToHex(i.outpointTransactionHash)));
      const o = prev.outputs[i.outpointIndex];
      if (!o) throw new Error("missing source output");
      return o;
    }),
  );
}

/** Evaluate one input with the BCH VM. */
export function inputValid(tx: TransactionCommon, sourceOutputs: Output[], inputIndex: number): true | string {
  const program = { inputIndex, sourceOutputs, transaction: tx } as any;
  const state = (vm as any).evaluate(program);
  return (vm as any).stateSuccess(state);
}

/** P2PKH unlocking bytecode → { sighash type, public key } or null. */
export function p2pkhUnlock(unlocking: Uint8Array): { sighash: number; pubkey: Uint8Array } | null {
  const ins = decodeAuthenticationInstructions(unlocking) as any[];
  if (ins.length !== 2 || !ins[0].data || !ins[1].data) return null;
  const sig: Uint8Array = ins[0].data;
  const pubkey: Uint8Array = ins[1].data;
  if (sig.length < 9 || (pubkey.length !== 33 && pubkey.length !== 65)) return null;
  return { sighash: sig[sig.length - 1], pubkey };
}

async function txHeight(f: Fulcrum, lockingBytecode: Uint8Array, txid: string): Promise<number | undefined> {
  const hist = await f.history(scriptHash(lockingBytecode));
  const h = hist.find((x) => x.tx_hash === txid);
  return h?.height;
}

export async function verifyBindingEvent(event: Event, f: Fulcrum): Promise<Verification> {
  const checks: Check[] = [];
  const v: Verification = { state: "invalid", pubkey: event.pubkey, event, checks, statement: event.content };
  const fail = (id: string, label: string, detail: string) => {
    checks.push({ id, label, status: "fail", detail });
    v.reason = detail;
    return v;
  };

  // 1. Nostr side: the event is signed by the Nostr key.
  const dOk = event.tags.some((t) => t[0] === "d" && t[1] === D_TAG);
  if (!verifyEvent(event) || event.kind !== BINDING_KIND || !dOk)
    return fail("nostr-sig", "Binding event is signed by the Nostr key", "invalid signature, kind or d tag");
  checks.push({ id: "nostr-sig", label: "Binding event is signed by the Nostr key", status: "pass", detail: `event ${event.id.slice(0, 16)}…, kind ${BINDING_KIND}` });

  // 2. Statement.
  const st = parseStatement(event.content);
  if (!st) return fail("statement", "Statement is canonical CashLink v1", "content is not a canonical CashLink v1 statement");
  if (st.nostr !== event.pubkey) return fail("statement", "Statement names this Nostr key", "statement names a different Nostr key");
  if (st.revoked) {
    checks.push({ id: "statement", label: "Statement", status: "info", detail: "the owner withdrew the link (revocation)" });
    v.state = "revoked";
    v.reason = "The owner of this Nostr key has withdrawn the Bitcoin Cash link.";
    return v;
  }
  const addr = normalizeAddress(st.bch)!;
  v.address = addr.address;
  v.tokenAddress = addr.tokenAddress;
  v.linkedAt = st.created;
  checks.push({ id: "statement", label: "Statement names this Nostr key and one BCH address", status: "pass", detail: addr.address });

  const tagAddr = eventAddressTag(event.tags);
  if (tagAddr !== addressTag(addr.address)) return fail("tags", "Discovery tag matches the statement", "address tag missing or different");
  const txid = eventTxid(event.tags);
  if (!txid) return fail("tags", "Event points to a commitment transaction", "no bitcoincash:tx tag");
  v.txid = txid;

  // 3. BCH side: the commitment transaction.
  let tx: TransactionCommon;
  try {
    const hex = await f.getTransaction(txid);
    if (hashTransaction(hexToBin(hex)) !== txid) return fail("tx", "Commitment transaction found on the BCH blockchain", "server returned a different transaction");
    tx = decodeTx(hex);
  } catch (e) {
    return fail("tx", "Commitment transaction found on the BCH blockchain", `transaction ${txid.slice(0, 12)}… not found (${(e as Error).message})`);
  }
  checks.push({ id: "tx", label: "Commitment transaction found on the BCH blockchain", status: "pass", detail: txid });

  const hash = binToHex(statementHash(event.content));
  const commitIdx = tx.outputs.findIndex((o) => {
    const c = parseCommitment(o.lockingBytecode);
    return c && c.version === 1 && c.nostr === event.pubkey && c.hash === hash;
  });
  if (commitIdx < 0) return fail("commit", "OP_RETURN commits to this Nostr key and statement", "no matching CLID output in the transaction");
  checks.push({ id: "commit", label: "OP_RETURN commits to this Nostr key and statement hash", status: "pass", detail: `output ${commitIdx}: CLID v1, sha256 ${hash.slice(0, 16)}…` });

  // 4. Proof of control of the BCH key: an input spends from the address with a valid SIGHASH_ALL signature.
  let sources: Output[];
  try {
    sources = await sourceOutputsOf(tx, f);
  } catch (e) {
    return fail("sig", "Signed by the key of the linked address", `cannot load source outputs (${(e as Error).message})`);
  }
  const lockHex = binToHex(addr.lockingBytecode);
  let proven = -1;
  let why = "no input spends from the linked address";
  for (let i = 0; i < tx.inputs.length; i++) {
    if (binToHex(sources[i].lockingBytecode) !== lockHex) continue;
    const u = p2pkhUnlock(tx.inputs[i].unlockingBytecode);
    if (!u) {
      why = "unexpected unlocking script";
      continue;
    }
    if ((u.sighash & 0x1f) !== 0x01 || !(u.sighash & 0x40)) {
      why = `signature type 0x${u.sighash.toString(16)} does not cover all outputs`;
      continue;
    }
    if (binToHex(hash160(u.pubkey)) !== lockHex.slice(6, 46)) continue;
    const ok = inputValid(tx, sources, i);
    if (ok !== true) {
      why = `signature check failed: ${ok}`;
      continue;
    }
    proven = i;
    break;
  }
  if (proven < 0) return fail("sig", "Signed by the key of the linked address", why);
  checks.push({ id: "sig", label: "Signed by the key of the linked address (covers the OP_RETURN)", status: "pass", detail: `input ${proven}, SIGHASH_ALL, verified with the BCH VM` });

  // 5. Confirmations.
  try {
    const [height, tip] = await Promise.all([txHeight(f, addr.lockingBytecode, txid), f.tipHeight()]);
    v.height = height;
    if (height && height > 0) {
      v.confirmations = tip - height + 1;
      checks.push({ id: "conf", label: "Mined in a block", status: "pass", detail: `block ${height}, ${v.confirmations} confirmation${v.confirmations === 1 ? "" : "s"}` });
      v.state = "verified";
    } else {
      v.confirmations = 0;
      checks.push({ id: "conf", label: "Mined in a block", status: "pending", detail: "in the mempool, waiting for the next block (~10 min)" });
      v.state = "unconfirmed";
    }
  } catch (e) {
    checks.push({ id: "conf", label: "Mined in a block", status: "pending", detail: `could not read height (${(e as Error).message})` });
    v.state = "unconfirmed";
  }
  return v;
}

export async function verifyPubkey(pubkey: string, f: Fulcrum, relays?: string[]): Promise<Verification> {
  const ev = await fetchBindingEvent(pubkey, relays);
  if (!ev) return { state: "none", pubkey, checks: [], reason: "No CashLink binding published by this Nostr key." };
  return verifyBindingEvent(ev, f);
}

export interface ChainCommitment {
  txid: string;
  height: number;
  nostr: string;
  hash: string;
}

/**
 * BCH → Nostr discovery straight from the blockchain: CLID commitments in the address history whose
 * input is unlocked by the address key. Each one names a Nostr key; the Nostr side still has to confirm.
 */
export async function chainCommitments(address: string, f: Fulcrum, maxTx = 60): Promise<ChainCommitment[]> {
  const addr = normalizeAddress(address);
  if (!addr) throw new Error("invalid address");
  const pkh = binToHex(addr.lockingBytecode).slice(6, 46);
  const hist = (await f.history(scriptHash(addr.lockingBytecode))).slice(-maxTx);
  const out: ChainCommitment[] = [];
  await Promise.all(
    hist.map(async (h) => {
      const tx = decodeTx(await f.getTransaction(h.tx_hash));
      const signedByAddress = tx.inputs.some((i) => {
        const u = p2pkhUnlock(i.unlockingBytecode);
        return u && binToHex(hash160(u.pubkey)) === pkh;
      });
      if (!signedByAddress) return;
      for (const o of tx.outputs) {
        const p = opReturnPushes(o.lockingBytecode);
        if (!p || !p.length || binToHex(p[0]) !== binToHex(PREFIX)) continue;
        const c = parseCommitment(o.lockingBytecode);
        if (c) out.push({ txid: h.tx_hash, height: h.height, nostr: c.nostr, hash: c.hash });
      }
    }),
  );
  return out.sort((a, b) => (b.height <= 0 ? 1e12 : b.height) - (a.height <= 0 ? 1e12 : a.height));
}

/** Address → verified Nostr identities, from both the chain and the relays. */
export async function identitiesForAddress(address: string, f: Fulcrum): Promise<Verification[]> {
  const addr = normalizeAddress(address);
  if (!addr) throw new Error("invalid address");
  const [chain, events] = await Promise.all([chainCommitments(addr.address, f).catch(() => []), fetchBindingsForAddress(addr.address).catch(() => [])]);
  const keys = new Set<string>([...chain.map((c) => c.nostr), ...events.map((e) => e.pubkey)]);
  const results = await Promise.all([...keys].map((k) => verifyPubkey(k, f).catch(() => null)));
  return results.filter((r): r is Verification => !!r && (r.state === "verified" || r.state === "unconfirmed") && r.address === addr.address);
}
