// How it works: the protocol in one page.
import { REPO_URL, SPEC_URL } from "../config.js";
import { clear, h, link } from "./dom.js";

const diagram = `
<svg viewBox="0 0 720 300" role="img" aria-label="CashLink binding: wallet signs an OP_RETURN commitment, Nostr key signs a kind 30078 event; a verifier checks both" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>
  <g font-family="inherit" font-size="13" fill="currentColor">
    <rect x="10" y="20" width="200" height="84" rx="12" class="d-box"/>
    <text x="110" y="50" text-anchor="middle" font-weight="700">BCH wallet key</text>
    <text x="110" y="72" text-anchor="middle" class="d-muted">Selene / Paytaca / Cashonize</text>
    <text x="110" y="90" text-anchor="middle" class="d-muted">via WizardConnect</text>
    <rect x="10" y="190" width="200" height="84" rx="12" class="d-box"/>
    <text x="110" y="222" text-anchor="middle" font-weight="700">Nostr key</text>
    <text x="110" y="244" text-anchor="middle" class="d-muted">NIP-07 extension</text>
    <text x="110" y="262" text-anchor="middle" class="d-muted">or browser key</text>
    <rect x="260" y="20" width="220" height="84" rx="12" class="d-accent"/>
    <text x="370" y="46" text-anchor="middle" font-weight="700">Commitment tx (mainnet)</text>
    <text x="370" y="68" text-anchor="middle" class="d-mono">OP_RETURN "CLID" 01</text>
    <text x="370" y="86" text-anchor="middle" class="d-mono">&lt;npub&gt; &lt;sha256(statement)&gt;</text>
    <rect x="260" y="190" width="220" height="84" rx="12" class="d-accent"/>
    <text x="370" y="216" text-anchor="middle" font-weight="700">Binding event (kind 30078)</text>
    <text x="370" y="238" text-anchor="middle" class="d-mono">content = statement</text>
    <text x="370" y="256" text-anchor="middle" class="d-mono">i: bitcoincash:tx:&lt;txid&gt;</text>
    <rect x="530" y="105" width="180" height="90" rx="12" class="d-box"/>
    <text x="620" y="135" text-anchor="middle" font-weight="700">Any verifier</text>
    <text x="620" y="157" text-anchor="middle" class="d-muted">Nostr relays + Fulcrum</text>
    <text x="620" y="175" text-anchor="middle" class="d-muted">no CashLink server</text>
    <line x1="210" y1="62" x2="256" y2="62" stroke="currentColor" marker-end="url(#ar)"/>
    <text x="233" y="54" text-anchor="middle" font-size="11" class="d-muted">signs</text>
    <line x1="210" y1="232" x2="256" y2="232" stroke="currentColor" marker-end="url(#ar)"/>
    <text x="233" y="224" text-anchor="middle" font-size="11" class="d-muted">signs</text>
    <line x1="370" y1="190" x2="370" y2="108" stroke="currentColor" stroke-dasharray="4 4" marker-end="url(#ar)"/>
    <text x="378" y="152" font-size="11" class="d-muted">txid</text>
    <line x1="480" y1="62" x2="560" y2="105" stroke="currentColor" marker-end="url(#ar)"/>
    <line x1="480" y1="232" x2="560" y2="195" stroke="currentColor" marker-end="url(#ar)"/>
  </g>
</svg>`;

export function renderHow(root: HTMLElement) {
  const fig = h("figure", { class: "diagram" });
  fig.innerHTML = diagram; // static markup defined above, no user data
  clear(
    root,
    h("div", { class: "page-head" }, h("h1", {}, "How CashLink ID works"), h("p", { class: "muted" }, "Two keys you already own sign the same statement. Anyone can check both signatures with public infrastructure.")),
    h("section", { class: "card" }, fig),
    h(
      "section",
      { class: "card prose" },
      h("h2", {}, "1. The statement"),
      h("pre", { class: "code" }, '{"protocol":"cashlink-id","v":1,"nostr":"<hex pubkey>","bch":"bitcoincash:q…","created":<unix>}'),
      h("p", {}, "Canonical JSON: fixed key order, no spaces, so its SHA-256 is unambiguous."),
      h("h2", {}, "2. BCH → Nostr: the commitment transaction"),
      h("p", {}, "Your wallet (via WizardConnect) signs a transaction that spends a coin from the linked address and adds an OP_RETURN output: ", h("code", {}, '"CLID" 0x01 <32-byte Nostr key> <sha256(statement)>'), ". The SIGHASH_ALL signature covers that output, so only the address owner could have produced it. Change returns to the same address; the cost is the network fee (~300 sat)."),
      h("h2", {}, "3. Nostr → BCH: the binding event"),
      h("p", {}, "Your Nostr key signs a kind 30078 event (NIP-78, addressable, ", h("code", {}, "d=cashlink-id"), ") whose content is the statement, with NIP-73 tags ", h("code", {}, "i=bitcoincash:address:…"), " and ", h("code", {}, "i=bitcoincash:tx:<txid>"), ". It is published to public relays. The newest event wins, which gives key rotation; a revocation statement withdraws the link."),
      h("h2", {}, "4. Verification (anyone, anywhere)"),
      h(
        "ol",
        {},
        h("li", {}, "Fetch the newest binding event of the npub from relays; check its Schnorr signature."),
        h("li", {}, "Parse the statement; it must be canonical and name the same Nostr key."),
        h("li", {}, "Fetch the commitment transaction from any Fulcrum/Electrum server; the txid must match."),
        h("li", {}, "Find the CLID output; it must carry the same Nostr key and sha256(statement)."),
        h("li", {}, "Find an input that spends from the linked address; evaluate it with the BCH VM (libauth) and require SIGHASH_ALL."),
        h("li", {}, "Read confirmations. Valid + mined = Verified."),
      ),
      h("h2", {}, "Discovery"),
      h("p", {}, "By identity: npub, nprofile or NIP-05 → relays. By address: the address history on-chain lists CLID commitments signed by the address key, and relays answer ", h("code", {}, "#i=bitcoincash:address:…"), " queries. Both are decentralised."),
      h("h2", {}, "Authentication"),
      h("p", {}, "An app issues a random challenge; the user signs it with the Nostr key (kind 22242, NIP-42 shape) and the app verifies the CashLink ID. Optional step-up: the wallet signs a zero-fee transaction from the linked address whose OP_RETURN carries the challenge (", h("code", {}, '"CLAU" <challenge>'), "); it is verified and discarded, and cannot be relayed."),
      h("h2", {}, "Why an on-chain commitment"),
      h(
        "ul",
        {},
        h("li", {}, "Works with any WizardConnect wallet today: the protocol has transaction signing but no message signing."),
        h("li", {}, "Timestamped and ordered by the blockchain, so rotations have a clear order and the BCH side is discoverable from the address alone."),
        h("li", {}, "The proof cannot be censored or lost with a relay: it lives in the UTXO chain."),
      ),
      h("p", {}, link(SPEC_URL, "Full specification (SPEC.md)"), " · ", link(REPO_URL, "Source code")),
    ),
  );
}
