// Nostr side: relays, binding events, profiles, NIP-05 and signers.
import { SimplePool } from "nostr-tools/pool";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { queryProfile } from "nostr-tools/nip05";
import { binToHex as bytesToHex, hexToBin as hexToBytes } from "@bitauth/libauth";
import { BINDING_KIND, D_TAG, addressTag, type EventTemplate } from "./cashlink.js";

export const RELAYS = ["wss://relay.primal.net", "wss://nos.lol", "wss://relay.damus.io", "wss://offchain.pub", "wss://relay.snort.social", "wss://nostr.mom"];

let pool: SimplePool | null = null;
export function relayPool(): SimplePool {
  return (pool ??= new SimplePool());
}

export type { Event };

export interface Profile {
  name?: string;
  display_name?: string;
  picture?: string;
  about?: string;
  nip05?: string;
  website?: string;
}

export const npubEncode = (hex: string) => nip19.npubEncode(hex);
export const shortNpub = (hex: string) => {
  const n = nip19.npubEncode(hex);
  return `${n.slice(0, 12)}…${n.slice(-6)}`;
};

/** Newest event per author/kind/d among the ones whose signature verifies. */
function newest(events: Event[]): Event | null {
  return events.filter((e) => verifyEvent(e)).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))[0] ?? null;
}

export async function fetchBindingEvent(pubkey: string, relays = RELAYS): Promise<Event | null> {
  const events = await relayPool().querySync(relays, { kinds: [BINDING_KIND], authors: [pubkey], "#d": [D_TAG] }, { maxWait: 4000 });
  return newest(events);
}

/** Decentralised reverse lookup: binding events that name this address (each still has to pass verification). */
export async function fetchBindingsForAddress(address: string, relays = RELAYS): Promise<Event[]> {
  const events = await relayPool().querySync(relays, { kinds: [BINDING_KIND], "#i": [addressTag(address)] }, { maxWait: 4000 });
  const byAuthor = new Map<string, Event>();
  for (const e of events) {
    if (!verifyEvent(e)) continue;
    const prev = byAuthor.get(e.pubkey);
    if (!prev || e.created_at > prev.created_at) byAuthor.set(e.pubkey, e);
  }
  return [...byAuthor.values()];
}

/** Recently published bindings, for the public directory on the home page. */
export async function fetchRecentBindings(limit = 30, relays = RELAYS): Promise<Event[]> {
  const events = await relayPool().querySync(relays, { kinds: [BINDING_KIND], "#d": [D_TAG], limit }, { maxWait: 4000 });
  const byAuthor = new Map<string, Event>();
  for (const e of events) {
    if (!verifyEvent(e)) continue;
    const prev = byAuthor.get(e.pubkey);
    if (!prev || e.created_at > prev.created_at) byAuthor.set(e.pubkey, e);
  }
  return [...byAuthor.values()].sort((a, b) => b.created_at - a.created_at);
}

const profileCache = new Map<string, Promise<Profile | null>>();
export function fetchProfile(pubkey: string, relays = RELAYS): Promise<Profile | null> {
  let p = profileCache.get(pubkey);
  if (!p) {
    p = relayPool()
      .querySync(relays, { kinds: [0], authors: [pubkey] }, { maxWait: 3500 })
      .then((evs) => {
        const e = newest(evs);
        if (!e) return null;
        try {
          return JSON.parse(e.content) as Profile;
        } catch {
          return null;
        }
      });
    profileCache.set(pubkey, p);
  }
  return p;
}

export async function publish(event: Event, relays = RELAYS): Promise<{ ok: string[]; failed: string[] }> {
  const results = await Promise.allSettled(relayPool().publish(relays, event));
  const ok: string[] = [];
  const failed: string[] = [];
  results.forEach((r, i) => (r.status === "fulfilled" ? ok : failed).push(relays[i]));
  return { ok, failed };
}

export interface ResolvedId {
  pubkey: string;
  via: "npub" | "nprofile" | "hex" | "nip05";
  nip05?: string;
  relays?: string[];
}

/** npub…, nprofile…, nostr:npub…, 64-hex, or NIP-05 (name@domain / domain). Returns null for non-Nostr input. */
export async function resolveIdentifier(input: string): Promise<ResolvedId | null> {
  let s = input.trim();
  if (s.startsWith("nostr:")) s = s.slice(6);
  if (/^[0-9a-f]{64}$/i.test(s)) return { pubkey: s.toLowerCase(), via: "hex" };
  if (s.startsWith("npub1") || s.startsWith("nprofile1")) {
    try {
      const d = nip19.decode(s);
      if (d.type === "npub") return { pubkey: d.data, via: "npub" };
      if (d.type === "nprofile") return { pubkey: d.data.pubkey, via: "nprofile", relays: d.data.relays };
    } catch {
      return null;
    }
    return null;
  }
  if (/^([a-z0-9._-]+@)?[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)) {
    const p = await queryProfile(s.toLowerCase());
    if (p?.pubkey) return { pubkey: p.pubkey, via: "nip05", nip05: s.toLowerCase(), relays: p.relays };
    throw new Error(`NIP-05 name ${s} did not resolve`);
  }
  return null;
}

/** True if `nip05` currently resolves to `pubkey` (checked live against the domain). */
export async function checkNip05(nip05: string, pubkey: string): Promise<boolean> {
  try {
    const p = await queryProfile(nip05);
    return p?.pubkey === pubkey;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- signers

export interface NostrSigner {
  kind: "nip07" | "local";
  pubkey: string;
  sign(t: EventTemplate): Promise<Event>;
}

declare global {
  interface Window {
    nostr?: { getPublicKey(): Promise<string>; signEvent(e: EventTemplate): Promise<Event> };
  }
}

export const hasExtension = () => typeof window !== "undefined" && !!window.nostr;

export async function extensionSigner(): Promise<NostrSigner> {
  if (!window.nostr) throw new Error("No Nostr browser extension (NIP-07) found");
  const pubkey = await window.nostr.getPublicKey();
  return {
    kind: "nip07",
    pubkey,
    async sign(t) {
      const e = await window.nostr!.signEvent(t);
      if (!verifyEvent(e) || e.pubkey !== pubkey) throw new Error("The extension returned an invalid signature");
      return e;
    },
  };
}

const LOCAL_KEY = "cashlink-nostr-sk";

function signerFromSecret(sk: Uint8Array): NostrSigner {
  return { kind: "local", pubkey: getPublicKey(sk), sign: async (t) => finalizeEvent(t, sk) };
}

/** A key created in this browser earlier (localStorage), if any. */
export function storedLocalSigner(): NostrSigner | null {
  try {
    const hex = localStorage.getItem(LOCAL_KEY);
    if (hex && /^[0-9a-f]{64}$/.test(hex)) return signerFromSecret(hexToBytes(hex));
  } catch {
    /* storage unavailable */
  }
  return null;
}

export function createLocalSigner(): NostrSigner {
  const sk = generateSecretKey();
  try {
    localStorage.setItem(LOCAL_KEY, bytesToHex(sk));
  } catch {
    /* key lives only for this page view */
  }
  return signerFromSecret(sk);
}

/** nsec backup of the locally created key (shown only when the user asks for it). */
export function localNsec(): string | null {
  try {
    const hex = localStorage.getItem(LOCAL_KEY);
    return hex ? nip19.nsecEncode(hexToBytes(hex)) : null;
  } catch {
    return null;
  }
}

export function forgetLocalKey() {
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* ignore */
  }
}

export function profileTemplate(p: Profile): EventTemplate {
  return { kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(p) };
}

export { verifyEvent };
