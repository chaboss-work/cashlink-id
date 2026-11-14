// "Sign in with CashLink": a demo of an independent app authenticating a user by challenge-response.
// It uses only the public verifier (relays + Fulcrum); no CashLink server exists.
import { binToHex } from "@bitauth/libauth";
import { AUTH_KIND, authScript, normalizeAddress, opReturnPushes, PREFIX_AUTH, randomBytes } from "../lib/cashlink.js";
import { fulcrum } from "../lib/fulcrum.js";
import { fetchProfile, verifyEvent, type Event, type NostrSigner } from "../lib/nostr.js";
import { buildTx } from "../lib/tx.js";
import { decodeTx, p2pkhUnlock, verifyPubkey, type Verification } from "../lib/verify.js";
import { wallet } from "../lib/wallet.js";
import { hash160 } from "@bitauth/libauth";
import { approveHint, walletPanel } from "./connect.js";
import { clear, h, shortAddr, spinner } from "./dom.js";
import { checksList, displayName, identityHeader } from "./identity.js";
import { getSigner, signerChooser } from "./signer.js";

const MAX_AGE = 600; // seconds

/** Server-side check an app would run on the signed challenge (shown in the page as code too). */
export function checkAuthEvent(ev: Event, challenge: string, appUrl: string): string | true {
  if (!verifyEvent(ev)) return "bad signature";
  if (ev.kind !== AUTH_KIND) return "wrong kind";
  if (!ev.tags.some((t) => t[0] === "challenge" && t[1] === challenge)) return "challenge does not match";
  if (!ev.tags.some((t) => t[0] === "relay" && t[1] === appUrl)) return "signed for a different app";
  if (Math.abs(Date.now() / 1000 - ev.created_at) > MAX_AGE) return "signature too old";
  return true;
}

export function renderLogin(root: HTMLElement) {
  const challenge = binToHex(randomBytes(32));
  const appUrl = `${location.origin}${location.pathname}#/login`;
  const stage = h("div", {});
  const walletStage = h("div", {});

  clear(
    root,
    h("div", { class: "page-head" }, h("h1", {}, "Sign in with CashLink"), h("p", { class: "muted" }, "A demo of how any app can log users in with their CashLink ID: a fresh challenge, a Nostr signature, and an independent check of the BCH link. No passwords, no accounts, no CashLink server.")),
    h(
      "section",
      { class: "card demo-app" },
      h("div", { class: "demo-bar" }, h("span", { class: "demo-logo" }, "◆"), h("strong", {}, "Corner Store"), h("span", { class: "muted small" }, "demo app")),
      h("div", { class: "label" }, "Challenge issued by the app (single use, expires in 10 minutes)"),
      h("pre", { class: "code" }, challenge),
      stage,
      walletStage,
    ),
  );

  const signIn = async (s: NostrSigner) => {
    clear(stage, spinner(s.kind === "nip07" ? "Approve the sign-in in your Nostr extension…" : "Signing the challenge…"));
    try {
      const ev = await s.sign({ kind: AUTH_KIND, created_at: Math.floor(Date.now() / 1000), tags: [["relay", appUrl], ["challenge", challenge]], content: "Sign in to Corner Store with CashLink ID" });
      const ok = checkAuthEvent(ev, challenge, appUrl);
      if (ok !== true) throw new Error(`Sign-in rejected: ${ok}`);
      clear(stage, spinner("Signature valid. Verifying the CashLink ID on Nostr relays and the BCH blockchain…"));
      const [v, p] = await Promise.all([verifyPubkey(ev.pubkey, fulcrum()), fetchProfile(ev.pubkey).catch(() => null)]);
      if (v.state !== "verified" && v.state !== "unconfirmed") {
        clear(stage, identityHeader(ev.pubkey, p, v), h("div", { class: "error" }, "Signature is valid, but this Nostr key has no verified CashLink ID. ", h("a", { href: "#/link" }, "Link a wallet first.")));
        return;
      }
      clear(
        stage,
        h("div", { class: "success" }, h("strong", {}, `Signed in as ${displayName(p, ev.pubkey)}`), h("div", { class: "small" }, `Pays and gets paid at ${shortAddr(v.address!)}`)),
        identityHeader(ev.pubkey, p, v),
        h("details", {}, h("summary", { class: "small" }, "What the app checked"), h("ul", { class: "checks" }, h("li", { class: "pass" }, h("span", { class: "ci" }, "✓"), h("div", {}, `Nostr signature over challenge (kind ${AUTH_KIND}, NIP-42 shape), fresh, for this app`))), checksList(v)),
      );
      renderWalletStepUp(v);
    } catch (e) {
      clear(stage, h("div", { class: "error" }, (e as Error).message), signerChooser(signIn));
    }
  };

  const renderWalletStepUp = (v: Verification) => {
    const out = h("div", {});
    const btn = h("button", { class: "btn", type: "button" }, "Prove wallet control");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        clear(out, spinner("Finding the linked address in your wallet…"));
        const scan = await wallet.ensureScan(fulcrum(), true);
        const a = scan.addresses.find((x) => x.address === v.address);
        if (!a) throw new Error(`This wallet does not hold the linked address ${shortAddr(v.address!)}`);
        if (!a.utxos.length) throw new Error("The linked address has no coins to sign with");
        const lock = normalizeAddress(a.address)!.lockingBytecode;
        const smallest = [...a.utxos].sort((x, y) => (x.value < y.value ? -1 : 1))[0];
        const plan = buildTx([], [{ lockingBytecode: authScript(Uint8Array.from(challenge.match(/../g)!.map((x) => parseInt(x, 16)))), valueSatoshis: 0n }], lock, 0n, [smallest]);
        clear(out, approveHint("a zero-fee proof that cannot be broadcast"));
        const signed = await wallet.sign(fulcrum(), plan, "Corner Store sign-in proof (CashLink ID). Zero fee: this transaction can't be broadcast and moves nothing.", {
          purpose: "auth",
          label: "sign-in proof",
          minFeeRate: 0n,
        });
        // App-side check: the signature is valid (checked in wallet.sign with the BCH VM), it is the linked key, and it covers the challenge.
        const tx = decodeTx(signed.hex);
        const u = p2pkhUnlock(tx.inputs[0].unlockingBytecode);
        const pushes = opReturnPushes(tx.outputs[0].lockingBytecode);
        const keyOk = u && binToHex(hash160(u.pubkey)) === binToHex(lock).slice(6, 46) && (u.sighash & 0x1f) === 1;
        const chOk = pushes && binToHex(pushes[0]) === binToHex(PREFIX_AUTH) && binToHex(pushes[1]) === challenge;
        if (!keyOk || !chOk || signed.fee !== 0n) throw new Error("Wallet proof did not match the challenge");
        clear(
          out,
          h("div", { class: "success" }, h("strong", {}, "Two-factor sign-in complete"), h("div", { class: "small" }, "Nostr key ✓ and BCH key ✓ both signed this session's challenge. The wallet proof was checked and thrown away; with zero fee it cannot be relayed.")),
        );
      } catch (e) {
        clear(out, h("div", { class: "error" }, (e as Error).message));
        btn.disabled = false;
      }
    });
    clear(
      walletStage,
      h("hr", {}),
      h("h3", {}, "Optional: prove you also hold the wallet"),
      h("p", { class: "muted small" }, "WizardConnect has no message signing, so the wallet signs a zero-fee transaction from the linked address whose OP_RETURN carries the challenge. The app verifies it and discards it."),
      walletPanel({ hint: "Connect the wallet that holds the linked address." }),
      btn,
      out,
    );
  };

  const s = getSigner();
  if (s) {
    clear(stage, h("p", {}, "Signing in with your current Nostr key."), h("button", { class: "btn big", type: "button", onclick: () => void signIn(s) }, "Sign in with CashLink"));
  } else {
    clear(stage, h("p", { class: "small" }, "Choose your Nostr key to answer the challenge:"), signerChooser(signIn));
  }
}
