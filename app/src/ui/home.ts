// Home: search, demo identity, and the public directory of recent links (read from Nostr relays).
import { DEMO_NPUB } from "../config.js";
import { fulcrum } from "../lib/fulcrum.js";
import { fetchProfile, fetchRecentBindings, npubEncode, resolveIdentifier } from "../lib/nostr.js";
import { verifyBindingEvent, verifyPubkey } from "../lib/verify.js";
import { clear, h, spinner, timeAgo } from "./dom.js";
import { identityHeader } from "./identity.js";

export function searchBox(autofocus = false) {
  const input = h("input", { type: "text", class: "search", placeholder: "npub…, name@domain.com or bitcoincash:…", "aria-label": "Nostr identity or BCH address", autofocus, spellcheck: "false", autocomplete: "off" });
  const form = h("form", { class: "search-form" }, input, h("button", { class: "btn", type: "submit" }, "Look up"));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (v) location.hash = `#/id/${encodeURIComponent(v)}`;
  });
  return form;
}

export function renderHome(root: HTMLElement) {
  const directory = h("div", { class: "list" }, spinner("Reading recent links from Nostr relays…"));
  const demo = DEMO_NPUB
    ? h("a", { class: "card demo-card", href: `#/id/${DEMO_NPUB}` }, h("div", { class: "label" }, "Try it: tip the CashLink demo identity"), h("div", { class: "demo-slot" }, spinner()))
    : null;

  clear(
    root,
    h(
      "section",
      { class: "hero" },
      h("h1", {}, "Pay anyone on Nostr in ", h("span", { class: "accent" }, "Bitcoin Cash")),
      h("p", { class: "lead" }, "CashLink ID links a Nostr identity to a BCH wallet with a proof signed by both keys. Look anyone up by npub or NIP-05, verify the link yourself, and pay them from your wallet. No accounts, no servers, no custody."),
      searchBox(true),
    ),
    demo,
    h(
      "section",
      { class: "grid3" },
      h("a", { class: "card tile", href: "#/link" }, h("div", { class: "tile-icon" }, "⛓"), h("h3", {}, "Link your identity"), h("p", { class: "muted small" }, "Your wallet signs an on-chain commitment, your Nostr key signs the matching event. One minute, ~300 sat.")),
      h("a", { class: "card tile", href: DEMO_NPUB ? `#/id/${DEMO_NPUB}` : "#/link" }, h("div", { class: "tile-icon" }, "⚡"), h("h3", {}, "Pay by identity"), h("p", { class: "muted small" }, "Type an npub or name@domain. The app verifies the link, then your wallet pays the verified address.")),
      h("a", { class: "card tile", href: "#/login" }, h("div", { class: "tile-icon" }, "🔑"), h("h3", {}, "Sign in with CashLink"), h("p", { class: "muted small" }, "Challenge–response login for any app: Nostr signature plus an optional wallet proof.")),
    ),
    h("section", { class: "card" }, h("h2", {}, "Recently linked"), h("p", { class: "muted small" }, "Straight from public Nostr relays (kind 30078, d=cashlink-id); each one verified in your browser."), directory),
  );

  if (demo && DEMO_NPUB) {
    void (async () => {
      const r = await resolveIdentifier(DEMO_NPUB);
      if (!r) return;
      const [p, v] = await Promise.all([fetchProfile(r.pubkey).catch(() => null), verifyPubkey(r.pubkey, fulcrum()).catch(() => null)]);
      demo.querySelector(".demo-slot")?.replaceWith(identityHeader(r.pubkey, p, v));
    })();
  }

  void (async () => {
    try {
      const events = await fetchRecentBindings(40);
      if (!events.length) {
        clear(directory, h("p", { class: "muted" }, "No links yet. ", h("a", { href: "#/link" }, "Be the first.")));
        return;
      }
      clear(directory);
      for (const ev of events.slice(0, 12)) {
        const row = h("a", { class: "list-item", href: `#/id/${npubEncode(ev.pubkey)}` }, spinner());
        directory.append(row);
        void Promise.all([fetchProfile(ev.pubkey).catch(() => null), verifyBindingEvent(ev, fulcrum()).catch(() => null)]).then(([p, v]) => {
          clear(row, identityHeader(ev.pubkey, p, v), h("span", { class: "muted small when" }, timeAgo(ev.created_at)));
          if (v && v.state !== "verified" && v.state !== "unconfirmed") row.classList.add("dim");
        });
      }
    } catch (e) {
      clear(directory, h("p", { class: "error" }, `Relays unavailable: ${(e as Error).message}`));
    }
  })();
}
