// WizardConnect wallet session (Selene, Paytaca, Cashonize…): xpubs, address scan, transaction signing.
import { childIndexOfPathName, initiateDappRelay, RelayMsgAction, type DappRelayResult } from "@wizardconnect/core";
import { DappConnectionManager } from "@wizardconnect/dapp";
import { binToHex, encodeCashAddress, hash160, hexToBin } from "@bitauth/libauth";
import { normalizeAddress, scriptHash } from "./cashlink.js";
import { fulcrum as sharedFulcrum, type Fulcrum } from "./fulcrum.js";
import { checkSigned, relaySourceOutputs, type CheckedTx, type UnsignedTx, type Utxo } from "./tx.js";
import { decodeTx } from "./verify.js";

// WizardConnect's relay client disconnects while the tab is hidden and, on return, drops every wallet message
// sent in the meantime (including the pairing reply). People approve on their phone while the browser sits behind
// other windows, so keep the relay session alive: the page reports itself as always visible.
if (typeof document !== "undefined") {
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  } catch {
    /* non-configurable in this browser: fall back to the library default */
  }
}

const SESSION_KEY = "cashlink-wizardconnect";
const PENDING_SIGN_KEY = "cashlink-pending-sign";
/** Link wizard state after the commitment is broadcast (read by the link page). */
export const BINDING_PENDING_KEY = "cashlink-pending-binding";
const DAPP_NAME = "CashLink ID";
const DAPP_ICON = typeof location !== "undefined" ? new URL("./icon.png", location.href).href : undefined;

/** The wallet counts as reachable while it answered within this window (the library pings every 10 s). */
const LIVE_WINDOW_MS = 35_000;
/** While the wallet is silent, announce the dapp again this often, so a wallet that comes back answers. */
const REANNOUNCE_MS = 15_000;
/** A sign request kept across reloads is dropped after this long. */
const PENDING_MAX_AGE_S = 60 * 60;

export type PathName = "receive" | "change";

export interface AddressInfo {
  path: PathName;
  index: number;
  address: string;
  tokenAddress: string;
  used: boolean;
  balance: bigint;
  utxos: Utxo[];
}

export interface WalletScan {
  addresses: AddressInfo[];
  utxos: Utxo[];
  balance: bigint;
  tokenUtxos: number;
  /** First change address with no history (for change outputs). */
  changeAddress: AddressInfo;
}

export type SignPurpose = "pay" | "commit" | "auth";

export interface SignOptions {
  purpose: SignPurpose;
  /** Short human description, shown if the request has to be recovered after a reload. */
  label: string;
  minFeeRate?: bigint;
  signal?: AbortSignal;
  /** For "commit": the link wizard state to restore once the recovered commitment is broadcast. */
  binding?: { pubkey: string; statement: string };
}

/**
 * A sign request that survives a page reload. The wallet may answer after the page that asked is gone
 * (reload, mobile browser killed while the wallet app was open); the answer is then picked up, checked
 * and broadcast by the next page load instead of being lost.
 */
export interface PendingSign {
  /** Dapp relay key the request was sent with; only that session can receive the answer. */
  session: string;
  sequence: number;
  time: number;
  purpose: SignPurpose;
  label: string;
  userPrompt: string;
  minFeeRate: string;
  plan: string;
  binding?: { pubkey: string; statement: string };
}

export type Recovery =
  | { state: "waiting"; pending: PendingSign }
  | { state: "resending"; pending: PendingSign }
  | { state: "done"; pending: PendingSign; txid: string | null }
  | { state: "failed"; pending: PendingSign; error: string };

// UnsignedTx ↔ JSON (bigint and bytes tagged).
const encodePlan = (plan: UnsignedTx) =>
  JSON.stringify(plan, (_k, v) => (typeof v === "bigint" ? { $n: v.toString() } : v instanceof Uint8Array ? { $b: binToHex(v) } : v));
const decodePlan = (s: string): UnsignedTx =>
  JSON.parse(s, (_k, v) => (v && typeof v === "object" && "$n" in v ? BigInt(v.$n) : v && typeof v === "object" && "$b" in v ? hexToBin(v.$b) : v));

function loadPendingSign(): PendingSign | null {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_SIGN_KEY) ?? "null") as PendingSign | null;
    if (!p || typeof p.sequence !== "number" || Date.now() / 1000 - p.time > PENDING_MAX_AGE_S) return null;
    return p;
  } catch {
    return null;
  }
}
function savePendingSign(p: PendingSign | null) {
  try {
    if (p) localStorage.setItem(PENDING_SIGN_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_SIGN_KEY);
  } catch {
    /* storage unavailable: the request lives only in this page */
  }
}

const relayRequest = (plan: UnsignedTx, userPrompt: string) => ({
  transaction: { transaction: plan.hex, sourceOutputs: relaySourceOutputs(plan.inputs) as any, broadcast: false, userPrompt },
  inputPaths: plan.inputs.map((u, i) => [i, u.path, u.index] as [number, string, number]),
});

export class Wallet extends EventTarget {
  manager: DappConnectionManager | null = null;
  relay: DappRelayResult | null = null;
  relayState = "idle";
  uri = "";
  qrUri = "";
  lastScan: WalletScan | null = null;
  /** Last time (ms) the wallet sent anything in this page session. */
  lastHeard = 0;
  /** A request from an earlier page load that the wallet has not answered yet, or the result of recovering one. */
  recovery: Recovery | null = null;
  private started = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAnnounce = 0;
  private wasLive = false;
  /** Sequences of sign requests made by this page (answered through the library's own promise). */
  private own = new Set<number>();
  /** Outpoints spent by transactions broadcast from this page; servers may still list them right after. */
  private spent = new Set<string>();

  private emit() {
    this.dispatchEvent(new Event("change"));
  }

  hasStoredSession(): boolean {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null");
      return !!s?.walletPublicKey;
    } catch {
      return false;
    }
  }

  get ready(): boolean {
    const ci = childIndexOfPathName("receive");
    return !!this.manager && ci !== undefined && this.manager.hasPath(ci);
  }

  /** True while the wallet is answering (wallet_ready / pong / response recently). */
  get live(): boolean {
    return this.lastHeard > 0 && Date.now() - this.lastHeard < LIVE_WINDOW_MS;
  }

  /** Seconds since this page session started waiting for the wallet. */
  get silentFor(): number {
    return Math.floor((Date.now() - Math.max(this.lastHeard, this.started)) / 1000);
  }

  get walletName(): string {
    return this.manager?.walletName ?? "wallet";
  }

  /** Start a new pairing (fresh=true, shows a QR) or resume the stored one. */
  start(fresh: boolean) {
    this.stop(false);
    const manager = new DappConnectionManager(DAPP_NAME, DAPP_ICON, { session: { key: SESSION_KEY } });
    const stored = fresh ? null : manager.loadStoredSession();
    if (fresh) manager.clearStoredSession();
    let connectedAt = 0;
    const relay = initiateDappRelay(
      (p) => {
        if (p.status.status === "connected") connectedAt = Date.now();
        manager.updateConnection(p.client, p.status);
        this.relayState = String(p.status.status);
        this.emit();
      },
      stored?.walletPublicKey ? { existingCredentials: { privateKey: stored.privateKey, secret: stored.secret, walletPublicKey: stored.walletPublicKey } } : undefined,
    );
    manager.attachRelay(relay);
    this.started = Date.now();
    this.lastHeard = 0;
    this.wasLive = false;

    // A request from before a reload can only be answered on the same relay key.
    const pending = loadPendingSign();
    if (pending && pending.session === relay.credentials.publicKey) {
      this.recovery = { state: "waiting", pending };
      // The relay client drops anything older than the moment it connected; rewind the cutoff so an answer the
      // wallet sent while this page was gone is still accepted (it is authenticated and checked like any other).
      relay.client.setLastProcessedTimestamp(Math.max(1, pending.time - 5));
    } else if (pending) {
      savePendingSign(null);
      this.recovery = null;
    }
    // Our own listener sees every authenticated wallet message, including ones replayed by the relay before the
    // library's manager is attached.
    relay.client.on("message", (msg: any) => {
      if (this.manager !== manager) return;
      if (typeof msg?.time === "number" && msg.time * 1000 >= this.started - 5_000) this.lastHeard = Date.now();
      if (msg?.action === RelayMsgAction.SignTransactionResponse && !this.own.has(msg.sequence)) void this.recover(msg);
      this.tick();
    });

    // The dapp manager only waits 30 s after the relay connects for the wallet's key exchange, then gives up
    // without sending dapp_ready. A QR scanned later would hang, so re-announce once the exchange completes.
    relay.events.on("keyexchangecomplete", () => {
      if (Date.now() - connectedAt > 29_000 && this.manager === manager && !this.ready) manager.updateConnection(relay.client, { status: "connected" } as any);
    });
    manager.on("walletready", () => {
      // The wallet may have new coins: rescan, keeping the old numbers on screen until the new scan lands.
      this.emit();
      void this.ensureScan(sharedFulcrum(), true).catch(() => {});
    });
    manager.on("disconnect", () => {
      this.stop(true);
    });
    manager.on("reconnecting", () => this.emit());
    this.manager = manager;
    this.relay = relay;
    this.uri = relay.uri;
    this.qrUri = relay.qrUri;
    this.timer = setInterval(() => this.tick(), 5_000);
    this.emit();
  }

  /**
   * Liveness: a wallet app that was closed or in the background misses (and later ignores) messages sent while
   * it was away, and does not always announce itself on return. While it is silent, announce the dapp again;
   * the wallet answers with wallet_ready and the library then re-sends any unanswered sign request.
   */
  private tick() {
    const m = this.manager;
    if (!m || !this.relay) return;
    const live = this.live;
    if (live !== this.wasLive) {
      this.wasLive = live;
      this.emit();
    }
    if (live || !this.hasPaired() || this.relayState !== "connected") return;
    if (Date.now() - this.lastAnnounce < REANNOUNCE_MS || Date.now() - this.started < 10_000) return;
    this.lastAnnounce = Date.now();
    m.updateConnection(this.relay.client, { status: "connected" } as any);
  }

  private hasPaired(): boolean {
    return this.relay?.client.isKeyExchangeComplete() ?? false;
  }

  /** Stop the session; forget=true also removes it from storage (wallet must be paired again). */
  stop(forget: boolean) {
    const m = this.manager;
    const r = this.relay;
    this.manager = null;
    this.relay = null;
    this.lastScan = null;
    this.lastHeard = 0;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (m) {
      if (forget) {
        void m.sendDisconnect("CashLink ID disconnected").catch(() => {});
        m.clearStoredSession();
      }
      m.destroy();
    }
    r?.cleanup();
    if (forget) {
      try {
        localStorage.removeItem(SESSION_KEY);
      } catch {
        /* ignore */
      }
      // The answer to an older request can no longer arrive.
      if (this.recovery?.state === "waiting") this.discardRecovery();
    }
    this.relayState = "idle";
    this.emit();
  }

  pubkey(path: PathName, index: number): Uint8Array {
    const ci = childIndexOfPathName(path);
    const pk = ci === undefined ? undefined : this.manager?.getPubkey(ci, BigInt(index));
    if (!pk) throw new Error(`wallet did not share the ${path} path`);
    return pk;
  }

  address(path: PathName, index: number): string {
    const r = encodeCashAddress({ prefix: "bitcoincash", type: "p2pkh", payload: hash160(this.pubkey(path, index)) });
    return typeof r === "string" ? r : r.address;
  }

  private scanning: Promise<WalletScan> | null = null;

  /** Latest scan, or a new one; concurrent callers share the same request. */
  ensureScan(f: Fulcrum, force = false): Promise<WalletScan> {
    if (this.lastScan && !force) return Promise.resolve(this.lastScan);
    if (!this.scanning) this.scanning = this.scan(f).finally(() => (this.scanning = null));
    return this.scanning;
  }

  /** Scan receive/change addresses (gap limit) for history and plain-BCH UTXOs; token UTXOs are never touched. */
  async scan(f: Fulcrum, gap = 5, max = 40): Promise<WalletScan> {
    const addresses: AddressInfo[] = [];
    let tokenUtxos = 0;
    for (const path of ["receive", "change"] as PathName[]) {
      let unusedRun = 0;
      for (let start = 0; start < max && unusedRun < gap; start += gap) {
        const batch = await Promise.all(
          Array.from({ length: gap }, (_, k) => start + k).map(async (index) => {
            const address = this.address(path, index);
            const n = normalizeAddress(address)!;
            const sh = scriptHash(n.lockingBytecode);
            const hist = await f.history(sh);
            const info: AddressInfo = { path, index, address, tokenAddress: n.tokenAddress, used: hist.length > 0, balance: 0n, utxos: [] };
            if (hist.length) {
              for (const u of await f.listUnspent(sh)) {
                if (u.token_data) {
                  tokenUtxos++;
                  continue;
                }
                if (this.spent.has(`${u.tx_hash}:${u.tx_pos}`)) continue;
                info.utxos.push({ txid: u.tx_hash, vout: u.tx_pos, value: BigInt(u.value), height: u.height, path, index, address, lockingBytecode: n.lockingBytecode });
              }
              info.balance = info.utxos.reduce((a, x) => a + x.value, 0n);
            }
            return info;
          }),
        );
        for (const a of batch) {
          addresses.push(a);
          unusedRun = a.used ? 0 : unusedRun + 1;
        }
      }
    }
    const utxos = addresses.flatMap((a) => a.utxos);
    const changeAddress = addresses.find((a) => a.path === "change" && !a.used) ?? addresses.find((a) => a.path === "receive" && a.index === 0)!;
    this.lastScan = { addresses, utxos, balance: utxos.reduce((a, u) => a + u.value, 0n), tokenUtxos, changeAddress };
    this.emit();
    return this.lastScan;
  }

  /**
   * Ask the wallet to sign `plan`, then check the result (same inputs/outputs, VM-valid signatures, fee)
   * and that no input carries CashTokens. Broadcasting is left to the caller.
   * Payments and commitments are also kept in storage until answered, so a reload cannot lose an approval.
   */
  async sign(f: Fulcrum, plan: UnsignedTx, userPrompt: string, opts: SignOptions): Promise<CheckedTx> {
    const m = this.manager;
    if (!m || !this.ready || !this.relay) throw new Error("Connect a wallet first");
    if (this.recovery?.state === "waiting" || this.recovery?.state === "resending")
      throw new Error("An earlier transaction is still waiting for your wallet (see the notice at the top). Discard it or send it again first.");
    // Never spend token UTXOs as plain BCH: re-read each source output from the chain.
    for (const u of plan.inputs) {
      const prev = decodeTx(await f.getTransaction(u.txid)).outputs[u.vout];
      if (!prev || prev.token || prev.valueSatoshis !== u.value || binToHex(prev.lockingBytecode) !== binToHex(u.lockingBytecode))
        throw new Error("An input changed or carries CashTokens; refresh the wallet and try again");
    }
    const minFeeRate = opts.minFeeRate;
    const sequence = m.nextSequence();
    const time = Math.floor(Date.now() / 1000);
    this.own.add(sequence);
    if (opts.purpose !== "auth")
      savePendingSign({
        session: this.relay.credentials.publicKey,
        sequence,
        time,
        purpose: opts.purpose,
        label: opts.label,
        userPrompt,
        minFeeRate: String(minFeeRate ?? 1n),
        plan: encodePlan(plan),
        binding: opts.binding,
      });
    const request: any = { action: RelayMsgAction.SignTransactionRequest, time, sequence, ...relayRequest(plan, userPrompt) };
    try {
      const res: any = await this.withAbort(m, m.sendSignRequest(request), sequence, opts.signal);
      this.lastHeard = Date.now();
      if (res?.error) throw new Error(`Wallet: ${res.error}`);
      if (!res?.signedTransaction) throw new Error("The wallet returned no transaction");
      return checkSigned(res.signedTransaction, plan, minFeeRate);
    } finally {
      this.own.delete(sequence);
      if (loadPendingSign()?.sequence === sequence) savePendingSign(null);
    }
  }

  /**
   * Call after broadcasting a signed transaction: its inputs stop counting as coins at once (a server can
   * list them as unspent for a moment), and the wallet is scanned again once the servers have indexed it.
   */
  noteBroadcast(signedHex: string, f: Fulcrum = sharedFulcrum()) {
    for (const i of decodeTx(signedHex).inputs) this.spent.add(`${binToHex(i.outpointTransactionHash)}:${i.outpointIndex}`);
    if (this.lastScan) {
      const utxos = this.lastScan.utxos.filter((u) => !this.spent.has(`${u.txid}:${u.vout}`));
      this.lastScan = { ...this.lastScan, utxos, balance: utxos.reduce((a, u) => a + u.value, 0n) };
      this.emit();
    }
    setTimeout(() => {
      if (this.manager) void this.ensureScan(f, true).catch(() => {});
    }, 3_000);
  }

  private withAbort<T>(m: DappConnectionManager, p: Promise<T>, sequence: number, signal?: AbortSignal): Promise<T> {
    if (!signal) return p;
    p.catch(() => {});
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        void m.sendSignCancel(sequence, "Cancelled in CashLink ID").catch(() => {});
        reject(new DOMException("Cancelled", "AbortError"));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  // ------------------------------------------------------------ recovery after a reload

  /** The wallet answered a request made before this page loaded: check it, broadcast it, report. */
  private async recover(msg: any) {
    const pending = this.recovery?.state === "waiting" || this.recovery?.state === "resending" ? this.recovery.pending : null;
    if (!pending || msg.sequence !== pending.sequence) return;
    savePendingSign(null);
    this.recovery = { state: "resending", pending };
    this.emit();
    try {
      if (msg.error) throw new Error(`the wallet declined it (${msg.error})`);
      if (!msg.signedTransaction) throw new Error("the wallet returned no transaction");
      const signed = checkSigned(msg.signedTransaction, decodePlan(pending.plan), BigInt(pending.minFeeRate));
      const f = sharedFulcrum();
      let txid: string | null = null;
      if (pending.purpose !== "auth") {
        try {
          txid = await f.broadcast(signed.hex);
        } catch (e) {
          // Already broadcast (e.g. by another tab): fine if the network knows the transaction.
          await f.getTransaction(signed.txid).catch(() => {
            throw e;
          });
          txid = signed.txid;
        }
        if (txid !== signed.txid) throw new Error(`server returned an unexpected txid ${txid}`);
        this.noteBroadcast(signed.hex, f);
      }
      if (pending.purpose === "commit" && pending.binding && txid) {
        try {
          localStorage.setItem(BINDING_PENDING_KEY, JSON.stringify({ ...pending.binding, txid }));
        } catch {
          /* ignore */
        }
      }
      this.recovery = { state: "done", pending, txid };
    } catch (e) {
      this.recovery = { state: "failed", pending, error: (e as Error).message };
    }
    this.emit();
  }

  /** Send the request from before the reload to the wallet again (same sequence, fresh time). */
  async resendRecovery() {
    const m = this.manager;
    const r = this.recovery;
    if (!m || !r || r.state !== "waiting") return;
    const p = r.pending;
    this.recovery = { state: "resending", pending: p };
    this.emit();
    const time = Math.floor(Date.now() / 1000);
    savePendingSign({ ...p, time });
    const request: any = { action: RelayMsgAction.SignTransactionRequest, time, sequence: p.sequence, ...relayRequest(decodePlan(p.plan), p.userPrompt) };
    try {
      // The answer is handled by recover() through our relay listener; the library promise just tracks it.
      await m.sendSignRequest(request);
    } catch (e) {
      if (this.recovery?.state === "resending") {
        this.recovery = { state: "failed", pending: p, error: (e as Error).message };
        savePendingSign(null);
        this.emit();
      }
    }
  }

  discardRecovery() {
    const r = this.recovery;
    if (r && (r.state === "waiting" || r.state === "resending") && this.manager) void this.manager.sendSignCancel(r.pending.sequence, "Discarded in CashLink ID").catch(() => {});
    savePendingSign(null);
    this.recovery = null;
    this.emit();
  }
}

export const wallet = new Wallet();
export { hexToBin };
