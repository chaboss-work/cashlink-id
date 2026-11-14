// Link wizard: Nostr key → wallet → on-chain commitment (wallet signs) → binding event (Nostr key signs).
import { bindingEventTemplate, commitmentScript, makeStatement, normalizeAddress, revocationEventTemplate, statementHash } from "../lib/cashlink.js";
import { fulcrum } from "../lib/fulcrum.js";
import { fetchProfile, npubEncode, publish, RELAYS, type NostrSigner } from "../lib/nostr.js";
import { buildTx, formatBch } from "../lib/tx.js";
import { verifyBindingEvent, verifyPubkey } from "../lib/verify.js";
import { BINDING_PENDING_KEY, wallet, type AddressInfo } from "../lib/wallet.js";
import { approveHint, walletPanel } from "./connect.js";
import { clear, explorerTx, h, link, shortAddr, spinner, toast } from "./dom.js";
import { checksList, identityHeader } from "./identity.js";
import { backupBox, getSigner, setSigner, signerChooser } from "./signer.js";

const PENDING_KEY = BINDING_PENDING_KEY;
interface Pending {
  pubkey: string;
  statement: string;
  txid: string;
}
const loadPending = (pubkey: string): Pending | null => {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null");
    return p?.pubkey === pubkey ? p : null;
  } catch {
    return null;
  }
};
const savePending = (p: Pending | null) => {
  try {
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
};

export function renderLink(root: HTMLElement) {
  const step1 = h("section", { class: "card step" });
  const step2 = h("section", { class: "card step" });
  const step3 = h("section", { class: "card step" });
  const step4 = h("section", { class: "card step" });
  clear(
    root,
    h("div", { class: "page-head" }, h("h1", {}, "Link your Nostr identity to your BCH wallet"), h("p", { class: "muted" }, "Two signatures, one from each key, make a link anyone can check. It costs one tiny transaction fee (about 300 satoshis).")),
    step1,
    step2,
    step3,
    step4,
  );

  let signer: NostrSigner | null = getSigner();
  let chosen: AddressInfo | null = null;
  let busy = false;
  let committed: Pending | null = null;

  const head = (n: number, title: string, done: boolean) => h("div", { class: "step-head" }, h("span", { class: `num ${done ? "done" : ""}` }, done ? "✓" : String(n)), h("h2", {}, title));

  // ---------- step 1: Nostr key
  const renderStep1 = async () => {
    if (!signer) {
      clear(step1, head(1, "Your Nostr identity", false), signerChooser((s) => ((signer = s), void renderStep1())));
      renderStep2();
      return;
    }
    const s = signer;
    clear(step1, head(1, "Your Nostr identity", true), spinner("Loading profile and any existing link…"));
    const [p, v] = await Promise.all([fetchProfile(s.pubkey).catch(() => null), verifyPubkey(s.pubkey, fulcrum()).catch(() => null)]);
    const pend = loadPending(s.pubkey);
    clear(
      step1,
      head(1, "Your Nostr identity", true),
      identityHeader(s.pubkey, p, v),
      v && (v.state === "verified" || v.state === "unconfirmed")
        ? h(
            "p",
            { class: "muted small" },
            `Already linked to ${shortAddr(v.address!)}. Linking again replaces it (key rotation): the newest link wins. `,
            h("a", { href: `#/id/${npubEncode(s.pubkey)}` }, "View"),
            " · ",
            withdrawButton(s),
          )
        : null,
      h("div", { class: "row gap" }, h("button", { class: "btn ghost small", type: "button", onclick: () => ((signer = null), setSigner(null), void renderStep1()) }, "Use a different key")),
      s.kind === "local" ? backupBox() : null,
    );
    committed = pend;
    if (pend) {
      toast("Found a commitment transaction that was not published to Nostr yet; continuing at step 4", "");
      renderStep4(s, pend);
    }
    renderStep2();
  };

  const withdrawButton = (s: NostrSigner) => {
    let armed = false;
    const b = h("button", { class: "linkish", type: "button" }, "Withdraw the link");
    b.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        b.textContent = "Click again to withdraw (verifiers stop showing your address)";
        setTimeout(() => ((armed = false), (b.textContent = "Withdraw the link")), 5000);
        return;
      }
      void revoke(s);
    });
    return b;
  };

  const revoke = async (s: NostrSigner) => {
    try {
      const ev = await s.sign(revocationEventTemplate(s.pubkey));
      const r = await publish(ev);
      toast(r.ok.length ? `Link withdrawn on ${r.ok.length} relays` : "No relay accepted the event", r.ok.length ? "ok" : "bad");
      void renderStep1();
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };

  // ---------- step 2: wallet + address
  const addrList = h("div", {});
  const panel = walletPanel({ hint: "Connect the wallet whose address you want to link.", onReady: () => void loadAddresses() });
  const loadAddresses = async () => {
    clear(addrList, spinner("Reading your wallet addresses…"));
    try {
      const scan = await wallet.ensureScan(fulcrum(), true);
      const funded = scan.addresses.filter((a) => a.balance > 1000n);
      const r0 = scan.addresses.find((a) => a.path === "receive" && a.index === 0)!;
      if (!funded.length) {
        chosen = null;
        clear(
          addrList,
          h("div", { class: "notice" }, h("strong", {}, "Your wallet needs a few cents of BCH first."), h("p", { class: "small" }, "The link is proven by a transaction from the linked address, so it must hold at least 0.00001 BCH. Send a little to:"), h("p", { class: "mono wrap" }, r0.address), h("button", { class: "btn ghost small", type: "button", onclick: () => void loadAddresses() }, "Check again")),
        );
        renderStep3();
        return;
      }
      if (!chosen || !funded.some((a) => a.address === chosen!.address)) chosen = funded.find((a) => a === r0) ?? funded.sort((a, b) => (b.balance > a.balance ? 1 : -1))[0];
      clear(
        addrList,
        h("div", { class: "label" }, "Address to link (payments to your CashLink ID go here)"),
        h(
          "div",
          { class: "addr-options" },
          funded.map((a) =>
            h(
              "label",
              { class: `addr-opt ${a === chosen ? "sel" : ""}` },
              h("input", { type: "radio", name: "addr", checked: a === chosen, onchange: () => ((chosen = a), void loadAddresses()) }),
              h("span", { class: "mono" }, shortAddr(a.address)),
              h("span", { class: "muted small" }, `${a.path}/${a.index}`),
              h("span", { class: "right" }, `${formatBch(a.balance)} BCH`),
            ),
          ),
        ),
        scan.tokenUtxos ? h("p", { class: "muted small" }, `${scan.tokenUtxos} CashToken UTXO(s) found; CashLink never spends them.`) : null,
      );
    } catch (e) {
      clear(addrList, h("div", { class: "error" }, (e as Error).message));
    }
    renderStep3();
  };
  const renderStep2 = () => {
    clear(step2, head(2, "Your Bitcoin Cash wallet", !!chosen && wallet.ready), panel, wallet.ready ? addrList : null);
    renderStep3();
  };
  const onWallet = () => {
    if (!step2.isConnected) return wallet.removeEventListener("change", onWallet);
    if (!wallet.ready) chosen = null;
    if (!busy) renderStep2();
  };
  wallet.addEventListener("change", onWallet);

  // ---------- step 3: commitment transaction
  const renderStep3 = () => {
    if (busy) return;
    const s = signer;
    if (s && committed && committed.pubkey === s.pubkey) {
      clear(step3, head(3, "Sign the link in your wallet", true), h("div", { class: "success" }, "Commitment broadcast: ", link(explorerTx(committed.txid), `${committed.txid.slice(0, 16)}…`)));
      return;
    }
    if (!s || !chosen || !wallet.ready) {
      clear(step3, head(3, "Sign the link in your wallet", false), h("p", { class: "muted small" }, "Choose a Nostr key and connect a wallet first."));
      return;
    }
    const a = chosen;
    const statement = makeStatement(s.pubkey, a.address);
    const hash = statementHash(statement);
    const script = commitmentScript(s.pubkey, hash);
    let plan;
    try {
      plan = buildTx(a.utxos, [{ lockingBytecode: script, valueSatoshis: 0n }], normalizeAddress(a.address)!.lockingBytecode);
    } catch (e) {
      clear(step3, head(3, "Sign the link in your wallet", false), h("div", { class: "error" }, (e as Error).message));
      return;
    }
    const out = h("div", {});
    const btn = h("button", { class: "btn big", type: "button" }, `Sign in ${wallet.walletName}`);
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      busy = true;
      try {
        clear(out, approveHint(`a ${plan!.fee}-satoshi fee, your BCH stays at ${shortAddr(a.address)}`));
        const signed = await wallet.sign(fulcrum(), plan!, `CashLink ID: link Nostr ${npubEncode(s.pubkey).slice(0, 16)}… to ${shortAddr(a.address)}. Fee ${plan!.fee} sat; all other BCH returns to the same address.`, {
          purpose: "commit",
          label: `link commitment for ${shortAddr(a.address)} (fee ${plan!.fee} sat)`,
          binding: { pubkey: s.pubkey, statement },
        });
        clear(out, spinner("Broadcasting the commitment…"));
        const txid = await fulcrum().broadcast(signed.hex);
        if (txid !== signed.txid) throw new Error(`unexpected txid from server: ${txid}`);
        wallet.noteBroadcast(signed.hex);
        const pend = { pubkey: s.pubkey, statement, txid };
        savePending(pend);
        committed = pend;
        busy = false;
        renderStep3();
        renderStep4(s, pend);
      } catch (e) {
        clear(out, h("div", { class: "error" }, (e as Error).message));
        btn.disabled = false;
      } finally {
        busy = false;
      }
    });
    clear(
      step3,
      head(3, "Sign the link in your wallet", false),
      h("p", { class: "muted small" }, "Your wallet signs a transaction from the linked address. Its OP_RETURN output carries your Nostr key and the hash of the statement below, so only the owner of this address could have made it."),
      h("div", { class: "label" }, "Statement"),
      h("pre", { class: "code" }, statement),
      h(
        "div",
        { class: "kv small" },
        h("span", {}, "OP_RETURN"),
        h("span", { class: "mono wrap" }, `"CLID" 01 ${s.pubkey.slice(0, 12)}… ${Array.from(hash.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("")}…`),
        h("span", {}, "Fee"),
        h("span", {}, `${plan.fee} satoshis (${plan.inputs.length} input${plan.inputs.length > 1 ? "s" : ""}, change back to the same address)`),
      ),
      btn,
      out,
    );
  };

  // ---------- step 4: Nostr binding event
  const renderStep4 = (s: NostrSigner, pend: Pending) => {
    const out = h("div", {});
    const btn = h("button", { class: "btn big", type: "button" }, s.kind === "nip07" ? "Sign with your Nostr extension and publish" : "Sign and publish to Nostr");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        clear(out, spinner("Signing the binding event…"));
        const ev = await s.sign(bindingEventTemplate(pend.statement, pend.txid));
        clear(out, spinner(`Publishing to ${RELAYS.length} relays…`));
        const r = await publish(ev);
        if (!r.ok.length) throw new Error("No relay accepted the event; try again");
        savePending(null);
        committed = null;
        const v = await verifyBindingEvent(ev, fulcrum());
        const p = await fetchProfile(s.pubkey).catch(() => null);
        const npub = npubEncode(s.pubkey);
        clear(
          out,
          h("div", { class: "success" }, h("strong", {}, `Published on ${r.ok.length}/${RELAYS.length} relays`), r.failed.length ? h("div", { class: "muted small" }, `Not accepted by: ${r.failed.join(", ")}`) : null),
          identityHeader(s.pubkey, p, v),
          checksList(v),
          h("div", { class: "row gap" }, h("a", { class: "btn", href: `#/id/${npub}` }, "Open my CashLink ID"), h("a", { class: "btn ghost", href: "#/login" }, "Try signing in with it")),
        );
        toast("Your CashLink ID is live", "ok");
      } catch (e) {
        clear(out, h("div", { class: "error" }, (e as Error).message));
        btn.disabled = false;
      }
    });
    clear(
      step4,
      head(4, "Publish the link on Nostr", false),
      h("p", { class: "muted small" }, "Your Nostr key signs an event (kind 30078) with the same statement and the commitment txid. Relays make it discoverable; anyone can verify both signatures."),
      h("div", { class: "kv small" }, h("span", {}, "Commitment"), h("span", { class: "mono" }, link(explorerTx(pend.txid), `${pend.txid.slice(0, 24)}…`))),
      btn,
      out,
    );
  };

  clear(step4, head(4, "Publish the link on Nostr", false), h("p", { class: "muted small" }, "After the wallet signs, your Nostr key signs the matching event."));
  void renderStep1();
  if (wallet.hasStoredSession() && !wallet.manager) wallet.start(false);
}
