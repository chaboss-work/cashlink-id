// CashLink ID protocol v1: pure functions, no network.
// Spec: ../../SPEC.md
import {
  binToHex,
  cashAddressToLockingBytecode,
  decodeAuthenticationInstructions,
  decodeCashAddress,
  encodeCashAddress,
  encodeDataPush,
  flattenBinArray,
  hexToBin,
  lockingBytecodeToCashAddress,
  sha256,
  utf8ToBin,
} from "@bitauth/libauth";

export const PROTOCOL = "cashlink-id";
export const VERSION = 1;
/** Nostr kind for the binding event: NIP-78 application-specific data (addressable, latest wins). */
export const BINDING_KIND = 30078;
/** `d` tag of the binding event; one binding per Nostr key. */
export const D_TAG = "cashlink-id";
/** Nostr kind used for challenge-response sign-in (NIP-42 auth event shape). */
export const AUTH_KIND = 22242;
/** 4-byte protocol prefix pushed first in the OP_RETURN output. */
export const PREFIX = utf8ToBin("CLID");
export const PREFIX_AUTH = utf8ToBin("CLAU");

const HEX64 = /^[0-9a-f]{64}$/;

export interface Statement {
  protocol: typeof PROTOCOL;
  v: number;
  nostr: string;
  bch: string;
  created: number;
  revoked?: true;
}

/** Canonical statement text. Fixed key order, no whitespace: this exact string is hashed and committed on-chain. */
export function makeStatement(nostrHex: string, bchAddress: string, created = Math.floor(Date.now() / 1000)): string {
  if (!HEX64.test(nostrHex)) throw new Error("Nostr public key must be 64 hex characters");
  const addr = normalizeAddress(bchAddress);
  if (!addr || addr.type !== "p2pkh") throw new Error("The linked address must be a P2PKH Bitcoin Cash address");
  return JSON.stringify({ protocol: PROTOCOL, v: VERSION, nostr: nostrHex, bch: addr.address, created });
}

/** A revocation statement: the Nostr key withdraws its binding. Published as the new (latest) binding event. */
export function makeRevocation(nostrHex: string, created = Math.floor(Date.now() / 1000)): string {
  return JSON.stringify({ protocol: PROTOCOL, v: VERSION, nostr: nostrHex, revoked: true, created });
}

export function parseStatement(content: string): Statement | null {
  let o: any;
  try {
    o = JSON.parse(content);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || o.protocol !== PROTOCOL || o.v !== VERSION) return null;
  if (typeof o.nostr !== "string" || !HEX64.test(o.nostr)) return null;
  if (typeof o.created !== "number" || !Number.isInteger(o.created)) return null;
  if (o.revoked === true) {
    if (content !== makeRevocation(o.nostr, o.created)) return null;
    return { protocol: PROTOCOL, v: VERSION, nostr: o.nostr, bch: "", created: o.created, revoked: true };
  }
  if (typeof o.bch !== "string") return null;
  // Only the canonical serialisation is accepted, so the hash is unambiguous.
  try {
    if (content !== makeStatement(o.nostr, o.bch, o.created)) return null;
  } catch {
    return null;
  }
  return { protocol: PROTOCOL, v: VERSION, nostr: o.nostr, bch: o.bch, created: o.created };
}

export function statementHash(content: string): Uint8Array {
  return sha256.hash(utf8ToBin(content));
}

/** OP_RETURN <"CLID"> <version> <nostr x-only pubkey, 32 bytes> <sha256(statement), 32 bytes> */
export function commitmentScript(nostrHex: string, hash: Uint8Array): Uint8Array {
  if (!HEX64.test(nostrHex) || hash.length !== 32) throw new Error("bad commitment fields");
  return flattenBinArray([
    Uint8Array.of(0x6a),
    encodeDataPush(PREFIX),
    encodeDataPush(Uint8Array.of(VERSION)),
    encodeDataPush(hexToBin(nostrHex)),
    encodeDataPush(hash),
  ]);
}

/** OP_RETURN <"CLAU"> <challenge, 32 bytes>: wallet side of the sign-in challenge (signed, never broadcast). */
export function authScript(challenge: Uint8Array): Uint8Array {
  if (challenge.length !== 32) throw new Error("challenge must be 32 bytes");
  return flattenBinArray([Uint8Array.of(0x6a), encodeDataPush(PREFIX_AUTH), encodeDataPush(challenge)]);
}

/** Push data of an OP_RETURN output, or null. OP_1..OP_16 are returned as one-byte values. */
export function opReturnPushes(lockingBytecode: Uint8Array): Uint8Array[] | null {
  if (lockingBytecode[0] !== 0x6a) return null;
  const ins = decodeAuthenticationInstructions(lockingBytecode.slice(1));
  const out: Uint8Array[] = [];
  for (const i of ins as any[]) {
    if (i.malformed) return null;
    if (i.opcode >= 0x51 && i.opcode <= 0x60) out.push(Uint8Array.of(i.opcode - 0x50));
    else if (i.data !== undefined) out.push(i.data);
    else if (i.opcode === 0x00) out.push(Uint8Array.of());
    else return null;
  }
  return out;
}

export interface Commitment {
  version: number;
  nostr: string;
  hash: string;
}

export function parseCommitment(lockingBytecode: Uint8Array): Commitment | null {
  const p = opReturnPushes(lockingBytecode);
  if (!p || p.length !== 4) return null;
  if (binToHex(p[0]) !== binToHex(PREFIX) || p[1].length !== 1 || p[2].length !== 32 || p[3].length !== 32) return null;
  return { version: p[1][0], nostr: binToHex(p[2]), hash: binToHex(p[3]) };
}

export interface NormalizedAddress {
  /** Canonical P2PKH/P2SH cashaddr with the `bitcoincash:` prefix and without token support. */
  address: string;
  /** Token-aware form (z… / r…) of the same locking bytecode. */
  tokenAddress: string;
  type: "p2pkh" | "p2sh";
  lockingBytecode: Uint8Array;
}

/** Accepts q…/p…/z…/r… addresses with or without prefix; mainnet only. */
export function normalizeAddress(input: string): NormalizedAddress | null {
  let s = input.trim();
  if (!s) return null;
  if (!s.includes(":")) s = `bitcoincash:${s}`;
  s = s.toLowerCase();
  const d = decodeCashAddress(s);
  if (typeof d === "string" || d.prefix !== "bitcoincash") return null;
  const base = d.type.replace("WithTokens", "") as string;
  if (base !== "p2pkh" && base !== "p2sh") return null;
  if (base === "p2sh" && d.payload.length !== 20 && d.payload.length !== 32) return null;
  const enc = (type: string) => {
    const r = encodeCashAddress({ prefix: "bitcoincash", type: type as any, payload: d.payload, throwErrors: false });
    return typeof r === "string" ? r : r.address;
  };
  const address = enc(base);
  const lock = cashAddressToLockingBytecode(address);
  if (typeof lock === "string") return null;
  return { address, tokenAddress: enc(`${base}WithTokens`), type: base, lockingBytecode: lock.bytecode };
}

export function lockingBytecodeToAddress(bytecode: Uint8Array): string | null {
  const r = lockingBytecodeToCashAddress({ bytecode, prefix: "bitcoincash" });
  return typeof r === "string" ? null : r.address;
}

/** NIP-73 external content id for a blockchain address: `bitcoincash:address:<cashaddr without prefix>`. */
export function addressTag(address: string): string {
  return `bitcoincash:address:${address.replace(/^bitcoincash:/, "")}`;
}
export function txTag(txid: string): string {
  return `bitcoincash:tx:${txid}`;
}

export interface EventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** Nostr binding event (unsigned). The statement text is the content; the commitment txid travels in tags. */
export function bindingEventTemplate(statement: string, txid: string): EventTemplate {
  const st = parseStatement(statement);
  if (!st || st.revoked) throw new Error("invalid statement");
  if (!HEX64.test(txid)) throw new Error("invalid txid");
  return {
    kind: BINDING_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: statement,
    tags: [
      ["d", D_TAG],
      ["i", addressTag(st.bch)],
      ["i", txTag(txid)],
      ["k", "bitcoincash:address"],
      ["alt", `CashLink ID: this Nostr key is linked to the Bitcoin Cash address ${st.bch}, proven by transaction ${txid}`],
    ],
  };
}

export function revocationEventTemplate(nostrHex: string): EventTemplate {
  return {
    kind: BINDING_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: makeRevocation(nostrHex),
    tags: [
      ["d", D_TAG],
      ["alt", "CashLink ID: this Nostr key has withdrawn its Bitcoin Cash link"],
    ],
  };
}

export function eventTxid(tags: string[][]): string | null {
  for (const t of tags) {
    if (t[0] === "i" && typeof t[1] === "string" && t[1].startsWith("bitcoincash:tx:")) {
      const id = t[1].slice("bitcoincash:tx:".length);
      if (HEX64.test(id)) return id;
    }
  }
  return null;
}

export function eventAddressTag(tags: string[][]): string | null {
  for (const t of tags) if (t[0] === "i" && typeof t[1] === "string" && t[1].startsWith("bitcoincash:address:")) return t[1];
  return null;
}

/** Electrum/Fulcrum script hash of a locking bytecode. */
export function scriptHash(lockingBytecode: Uint8Array): string {
  return binToHex(sha256.hash(lockingBytecode).reverse());
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
