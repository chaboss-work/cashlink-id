// Choosing the Nostr key: NIP-07 browser extension, or a key created in this browser.
import { createLocalSigner, extensionSigner, fetchProfile, hasExtension, localNsec, profileTemplate, publish, storedLocalSigner, type NostrSigner } from "../lib/nostr.js";
import { clear, copyButton, h, spinner, toast } from "./dom.js";

let current: NostrSigner | null = null;
const listeners = new Set<() => void>();

export const getSigner = () => current;
export function setSigner(s: NostrSigner | null) {
  current = s;
  listeners.forEach((l) => l());
}
export function onSignerChange(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Panel with the three ways to get a Nostr key. Calls `done` once a signer is chosen. */
export function signerChooser(done: (s: NostrSigner) => void): HTMLElement {
  const box = h("div", { class: "chooser" });
  const status = h("div", {});
  const ext = hasExtension();
  const stored = storedLocalSigner();

  const useExt = async () => {
    clear(status, spinner("Asking your Nostr extension…"));
    try {
      const s = await extensionSigner();
      setSigner(s);
      done(s);
    } catch (e) {
      clear(status, h("div", { class: "error" }, (e as Error).message));
    }
  };

  const nameInput = h("input", { type: "text", placeholder: "Display name (optional)", maxlength: 40, "aria-label": "Display name" });
  const createNew = async () => {
    const s = createLocalSigner();
    const name = nameInput.value.trim();
    if (name) {
      clear(status, spinner("Publishing your profile name to Nostr…"));
      try {
        const ev = await s.sign(profileTemplate({ name, about: "CashLink ID user: pay me in Bitcoin Cash." }));
        await publish(ev);
      } catch {
        toast("Profile name not published; you can set it later in any Nostr app", "bad");
      }
    }
    setSigner(s);
    done(s);
  };

  box.append(
    h(
      "div",
      { class: "options" },
      h(
        "div",
        { class: "option" },
        h("strong", {}, "Nostr browser extension"),
        h("p", { class: "muted small" }, "nos2x, Alby, Keys.band… Your key never leaves the extension (NIP-07)."),
        h("button", { class: "btn", type: "button", disabled: !ext, onclick: useExt }, ext ? "Use my extension" : "No extension found"),
      ),
      stored
        ? h(
            "div",
            { class: "option" },
            h("strong", {}, "Key created on this device"),
            h("p", { class: "muted small mono ellipsis" }, stored.pubkey.slice(0, 20), "…"),
            h("button", { class: "btn", type: "button", onclick: () => (setSigner(stored), done(stored)) }, "Use this key"),
          )
        : null,
      h(
        "div",
        { class: "option" },
        h("strong", {}, "New Nostr identity"),
        h("p", { class: "muted small" }, "Created and kept in this browser. Back it up afterwards to use it in any Nostr app."),
        nameInput,
        h("button", { class: "btn ghost", type: "button", onclick: createNew }, "Create a new key"),
      ),
    ),
    status,
  );
  return box;
}

/** Backup box for keys created in the browser. */
export function backupBox(): HTMLElement | null {
  const nsec = localNsec();
  if (!nsec) return null;
  const reveal = h("button", { class: "btn ghost small", type: "button" }, "Show secret key (nsec)");
  const out = h("div", {});
  reveal.addEventListener("click", () => {
    clear(out, h("p", { class: "warn-text small" }, "Anyone with this key controls your Nostr identity. Store it offline; never paste it into websites you do not trust."), h("pre", { class: "code" }, nsec), copyButton(nsec, "Copy nsec"));
    reveal.remove();
  });
  return h("div", { class: "backup" }, h("strong", {}, "Back up your new Nostr key"), h("p", { class: "muted small" }, "It is stored only in this browser. Import it into a Nostr app (Primal, Damus, Amethyst) to post with the same identity."), reveal, out);
}

export async function signerProfileName(s: NostrSigner) {
  const p = await fetchProfile(s.pubkey).catch(() => null);
  return p;
}
