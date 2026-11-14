// Identity page: resolve → verify both proofs → show the badge → pay the linked address.
import { fulcrum } from "../lib/fulcrum.js";
import { checkNip05, fetchProfile, npubEncode, resolveIdentifier, shortNpub, type Profile } from "../lib/nostr.js";
import { identitiesForAddress, verifyPubkey, type Verification } from "../lib/verify.js";
import { normalizeAddress } from "../lib/cashlink.js";
import { buildTx, formatBch, parseBch } from "../lib/tx.js";
import { wallet } from "../lib/wallet.js";
import { bchUsd, usdText } from "../lib/price.js";
import { approveHint, walletPanel } from "./connect.js";
import { avatar, clear, copyButton, explorerAddress, explorerTx, h, link, qrCanvas, shortAddr, spinner, timeAgo, toast } from "./dom.js";

export const displayName = (p: Profile | null, pubkey: string) => p?.display_name?.trim() || p?.name?.trim() || shortNpub(pubkey);

const STATE_TEXT: Record<Verification["state"], [string, string]> = {
  verified: ["Verified CashLink ID", "Both keys signed the link and the commitment is in a block."],
  unconfirmed: ["Verified · waiting for a block", "Both signatures check out; the commitment transaction is in the mempool."],
  invalid: ["Link does not verify", "Do not send money to this address based on this link."],
  none: ["No CashLink ID", "This Nostr key has not linked a Bitcoin Cash wallet yet."],
  revoked: ["Link withdrawn", "The owner withdrew the Bitcoin Cash link."],
};

export function statusPill(v: Verification) {
  const cls = v.state === "verified" ? "ok" : v.state === "unconfirmed" ? "warn" : v.state === "none" ? "muted" : "bad";
  const icon = v.state === "verified" || v.state === "unconfirmed" ? "✓" : v.state === "none" ? "–" : "✕";
  return h("span", { class: `pill ${cls}` }, icon, " ", STATE_TEXT[v.state][0]);
}

export function checksList(v: Verification) {
  if (!v.checks.length) return h("p", { class: "muted small" }, v.reason ?? "");
  return h(
    "ul",
    { class: "checks" },
    v.checks.map((c) =>
      h(
        "li",
        { class: c.status },
        h("span", { class: "ci" }, c.status === "pass" ? "✓" : c.status === "fail" ? "✕" : c.status === "pending" ? "…" : "i"),
        h("div", {}, h("div", {}, c.label), c.detail ? h("div", { class: "muted small mono wrap" }, c.detail) : null),
      ),
    ),
  );
}

/** Profile header + status; used by the identity page, the badge, sign-in and the link wizard. */
export function identityHeader(pubkey: string, profile: Profile | null, v: Verification | null, nip05ok?: boolean | null) {
  const npub = npubEncode(pubkey);
  return h(
    "div",
    { class: "id-head" },
    avatar(profile?.picture, pubkey, 64),
    h(
      "div",
      { class: "grow min0" },
      h("div", { class: "id-name" }, displayName(profile, pubkey)),
      profile?.nip05 ? h("div", { class: `small ${nip05ok ? "ok-text" : "muted"}` }, profile.nip05, nip05ok ? " ✓" : nip05ok === false ? " (not confirmed by the domain)" : "") : null,
      h("div", { class: "muted small mono ellipsis" }, npub, " ", copyButton(npub, "Copy npub")),
    ),
    v ? statusPill(v) : spinner("verifying"),
  );
}

export async function renderIdentity(root: HTMLElement, input: string) {
  const id = decodeURIComponent(input);
  clear(root, h("section", { class: "card" }, spinner(`Looking up ${id}…`)));

  // A BCH address: reverse lookup (chain + relays).
  const addr = normalizeAddress(id);
  if (addr) return renderAddressLookup(root, addr.address);

  let pubkey: string;
  try {
    const r = await resolveIdentifier(id);
    if (!r) throw new Error("Enter an npub, a NIP-05 name (name@domain) or a bitcoincash: address");
    pubkey = r.pubkey;
  } catch (e) {
    clear(root, h("section", { class: "card" }, h("h2", {}, "Not found"), h("p", { class: "muted" }, (e as Error).message), h("a", { class: "btn ghost", href: "#/" }, "Back")));
    return;
  }

  const card = h("section", { class: "card id-card" });
  const body = h("div", {});
  clear(root, card);
  const [profile, v] = await Promise.all([
    fetchProfile(pubkey).catch(() => null),
    verifyPubkey(pubkey, fulcrum()).catch((e): Verification => ({ state: "invalid", pubkey, checks: [], reason: (e as Error).message })),
  ]);
  const nip05ok = profile?.nip05 ? await checkNip05(profile.nip05, pubkey) : null;
  clear(card, identityHeader(pubkey, profile, v, nip05ok), h("p", { class: "muted small state-note" }, STATE_TEXT[v.state][1], v.reason && v.state === "invalid" ? ` Reason: ${v.reason}` : ""), body);

  if ((v.state === "verified" || v.state === "unconfirmed") && v.address) {
    const uri = v.address;
    append(
      body,
      h(
        "div",
        { class: "addr-box" },
        h("div", { class: "qr-wrap small" }, qrCanvas(uri, 132)),
        h(
          "div",
          { class: "grow min0" },
          h("div", { class: "label" }, "Linked Bitcoin Cash address"),
          h("div", { class: "mono wrap" }, v.address),
          h("div", { class: "row gap" }, copyButton(v.address, "Copy address"), link(explorerAddress(v.address), "Explorer"), v.txid ? link(explorerTx(v.txid), "Commitment tx") : null),
          v.linkedAt ? h("div", { class: "muted small" }, `Linked ${timeAgo(v.linkedAt)}`, v.confirmations ? ` · ${v.confirmations} confirmations` : "") : null,
        ),
      ),
      payBox(pubkey, profile, v),
    );
  } else if (v.state === "none") {
    append(body, h("p", {}, "Is this you? ", h("a", { href: "#/link" }, "Link your Bitcoin Cash wallet"), " in about a minute."));
  }

  const npub = npubEncode(pubkey);
  const embed = `<iframe src="${location.origin}${location.pathname}#/badge/${npub}" width="380" height="96" style="border:0" title="CashLink ID"></iframe>`;
  root.append(
    h("section", { class: "card" }, h("h3", {}, "How this was verified"), h("p", { class: "muted small" }, "Checked in your browser right now, from public Nostr relays and a public Fulcrum server. No CashLink server is involved."), checksList(v)),
    h(
      "details",
      { class: "card dev" },
      h("summary", {}, "For developers: badge, DID document, raw proof"),
      h("div", { class: "label" }, "Embed the badge"),
      h("pre", { class: "code" }, embed),
      copyButton(embed, "Copy embed code"),
      h("div", { class: "label" }, "DID document (did:nostr, resolved client-side)"),
      h("pre", { class: "code" }, JSON.stringify(didDocument(pubkey, v), null, 2)),
      v.event ? h("div", { class: "label" }, "Binding event (Nostr kind 30078)") : null,
      v.event ? h("pre", { class: "code" }, JSON.stringify(v.event, null, 2)) : null,
    ),
  );
}

function append(el: HTMLElement, ...c: Node[]) {
  el.append(...c);
}

/** A DID-style view of the verified identity (did:nostr with the BCH address as an equivalent identifier). */
export function didDocument(pubkey: string, v: Verification) {
  const did = `did:nostr:${pubkey}`;
  const doc: Record<string, unknown> = {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
    id: did,
    verificationMethod: [{ id: `${did}#key1`, type: "SchnorrSecp256k1VerificationKey2019", controller: did, publicKeyHex: pubkey }],
    authentication: [`${did}#key1`],
  };
  if ((v.state === "verified" || v.state === "unconfirmed") && v.address) {
    doc.alsoKnownAs = [v.address];
    doc.service = [{ id: `${did}#cashlink`, type: "CashLinkBinding", serviceEndpoint: { address: v.address, commitmentTx: v.txid, bindingEvent: v.event?.id, state: v.state } }];
  }
  return doc;
}

function payBox(pubkey: string, profile: Profile | null, v: Verification) {
  const name = displayName(profile, pubkey);
  const box = h("div", { class: "pay" });
  const amount = h("input", { class: "amount", type: "text", inputmode: "decimal", value: "0.0001", "aria-label": "Amount in BCH" });
  const usdLine = h("span", { class: "muted small" });
  const presets = h("div", { class: "row gap wrap-row" });
  const result = h("div", {});
  const sendBtn = h("button", { class: "btn big", type: "button" }, "Send");
  let usd: number | null = null;

  const parsed = () => parseBch(amount.value);
  const refresh = () => {
    const s = parsed();
    usdLine.textContent = s ? usdText(s, usd) : "Enter an amount in BCH";
    sendBtn.textContent = s ? `Send ${formatBch(s)} BCH to ${name}` : "Send";
    sendBtn.disabled = !s || s < 546n || !wallet.ready;
  };
  amount.addEventListener("input", refresh);
  wallet.addEventListener("change", refresh);
  void bchUsd().then((p) => {
    usd = p;
    clear(
      presets,
      (p ? [0.25, 1, 5].map((d) => ({ label: `$${d}`, sats: BigInt(Math.max(546, Math.round((d / p) * 1e8))) })) : [10000n, 100000n, 1000000n].map((s) => ({ label: `${formatBch(s)} BCH`, sats: s }))).map((x) =>
        h("button", { class: "btn ghost small", type: "button", onclick: () => ((amount.value = formatBch(x.sats)), refresh()) }, x.label),
      ),
    );
    refresh();
  });

  sendBtn.addEventListener("click", async () => {
    const s = parsed();
    if (!s) return;
    sendBtn.disabled = true;
    clear(result, spinner("Re-checking the link and preparing the transaction…"));
    try {
      const f = fulcrum();
      const again = await verifyPubkey(pubkey, f);
      if (again.address !== v.address || (again.state !== "verified" && again.state !== "unconfirmed")) throw new Error("The link changed since this page loaded; reload the page");
      const dest = normalizeAddress(v.address!)!;
      const scan = await wallet.ensureScan(f, true);
      if (scan.addresses.some((a) => a.address === dest.address)) toast("Note: this address belongs to your connected wallet, so the payment comes back to you", "");
      const plan = buildTx(scan.utxos, [{ lockingBytecode: dest.lockingBytecode, valueSatoshis: s }], normalizeAddress(scan.changeAddress.address)!.lockingBytecode);
      clear(result, approveHint(`${formatBch(s)} BCH to ${shortAddr(dest.address)}, fee ${plan.fee} sat`));
      const signed = await wallet.sign(f, plan, `CashLink ID: send ${formatBch(s)} BCH to ${name} (${shortNpub(pubkey)}), address ${shortAddr(dest.address)}`, {
        purpose: "pay",
        label: `${formatBch(s)} BCH to ${name}`,
      });
      clear(result, spinner("Broadcasting…"));
      const txid = await f.broadcast(signed.hex);
      if (txid !== signed.txid) throw new Error(`server returned an unexpected txid ${txid}`);
      wallet.noteBroadcast(signed.hex, f);
      clear(
        result,
        h(
          "div",
          { class: "success" },
          h("strong", {}, `Sent ${formatBch(s)} BCH to ${name}`),
          h("div", { class: "muted small" }, `Fee ${signed.fee} sat (${signed.size} bytes). Confirmed in the next block; usable immediately.`),
          h("div", { class: "mono small wrap" }, link(explorerTx(txid), txid)),
        ),
      );
      toast("Payment sent", "ok");
    } catch (e) {
      clear(result, h("div", { class: "error" }, (e as Error).message));
    } finally {
      refresh();
    }
  });

  box.append(
    h("h3", {}, `Pay ${name}`),
    h("p", { class: "muted small" }, "Sent straight from your wallet to the verified address. No custody, no account."),
    h("div", { class: "row gap wrap-row" }, amount, h("span", { class: "unit" }, "BCH"), usdLine),
    presets,
    walletPanel({ hint: "Connect the wallet you want to pay from.", onReady: refresh }),
    sendBtn,
    result,
  );
  refresh();
  return box;
}

async function renderAddressLookup(root: HTMLElement, address: string) {
  clear(root, h("section", { class: "card" }, spinner(`Searching the blockchain and Nostr relays for identities linked to ${shortAddr(address)}…`)));
  let found: Verification[] = [];
  try {
    found = await identitiesForAddress(address, fulcrum());
  } catch (e) {
    toast((e as Error).message, "bad");
  }
  const list = h("div", { class: "list" });
  clear(
    root,
    h(
      "section",
      { class: "card" },
      h("h2", {}, "Who owns this address?"),
      h("p", { class: "mono wrap small" }, address),
      h("p", { class: "muted small" }, "Reverse lookup from both sides: CLID commitments in the address history (signed by the address key) and binding events on Nostr that name it. Only identities verified both ways are listed."),
      found.length ? list : h("p", {}, "No verified CashLink ID uses this address."),
    ),
  );
  for (const v of found) {
    const p = await fetchProfile(v.pubkey).catch(() => null);
    list.append(h("a", { class: "list-item", href: `#/id/${npubEncode(v.pubkey)}` }, identityHeader(v.pubkey, p, v)));
  }
}
