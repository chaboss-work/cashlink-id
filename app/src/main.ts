import "./style.css";
import { EMBER_ADDRESS, REPO_URL, SLIDES_URL, SNAPSHOT_URL } from "./config.js";
import { wallet } from "./lib/wallet.js";
import { fulcrum } from "./lib/fulcrum.js";
import { fetchProfile, npubEncode, resolveIdentifier } from "./lib/nostr.js";
import { verifyPubkey } from "./lib/verify.js";
import { formatBch } from "./lib/tx.js";
import { recoveryNotice, walletChip, walletPanel } from "./ui/connect.js";
import { clear, copyButton, h, link, shortAddr, spinner } from "./ui/dom.js";
import { renderHome } from "./ui/home.js";
import { displayName, renderIdentity, statusPill } from "./ui/identity.js";
import { renderLink } from "./ui/link.js";
import { renderLogin } from "./ui/login.js";
import { renderHow } from "./ui/how.js";
import { avatar } from "./ui/dom.js";

const app = document.getElementById("app")!;

function shell() {
  const nav = h(
    "nav",
    { class: "nav" },
    h("a", { href: "#/", "data-r": "" }, "Pay"),
    h("a", { href: "#/link", "data-r": "link" }, "Link identity"),
    h("a", { href: "#/login", "data-r": "login" }, "Sign-in demo"),
    h("a", { href: "#/how", "data-r": "how" }, "How it works"),
  );
  const header = h("header", { class: "top" }, h("a", { class: "brand", href: "#/" }, h("img", { src: "./icon.png", alt: "", width: 28, height: 28 }), h("span", {}, "CashLink", h("b", {}, " ID"))), nav, walletChip());
  const banner = h(
    "div",
    { class: "blaze-banner", role: "note" },
    h("span", { class: "blaze-tag" }, "🔥 BCH BLAZE 2026"),
    link(SLIDES_URL, "Presentation", false),
    link(REPO_URL, "Source code (GitHub)"),
    h("span", {}, "Pre-hackathon state: ", link(SNAPSHOT_URL, "14.11 snapshot"), " (design notes + test page only)"),
    h("span", { class: "ember" }, "EMBER2026 votes: ", h("span", { class: "mono" }, shortAddr(EMBER_ADDRESS)), " ", copyButton(EMBER_ADDRESS, "Copy address")),
  );
  const main = h("main", { id: "view" });
  const footer = h(
    "footer",
    { class: "foot" },
    h("span", {}, "Open source. Runs entirely in your browser: Nostr relays + Fulcrum, no CashLink server. "),
    link(REPO_URL, "GitHub"),
    h("span", {}, " · Built for BCH BLAZE 2026"),
  );
  clear(app, banner, header, h("div", { class: "page-notices" }, recoveryNotice()), main, footer);
  return { main, nav };
}

async function renderBadge(root: HTMLElement, id: string) {
  document.body.classList.add("embed");
  clear(root, spinner());
  const r = await resolveIdentifier(decodeURIComponent(id)).catch(() => null);
  if (!r) return clear(root, h("div", { class: "badge" }, "Unknown identity"));
  const [p, v] = await Promise.all([fetchProfile(r.pubkey).catch(() => null), verifyPubkey(r.pubkey, fulcrum())]);
  const ok = v.state === "verified" || v.state === "unconfirmed";
  clear(
    root,
    h(
      "a",
      { class: "badge", href: `${location.pathname}#/id/${npubEncode(r.pubkey)}`, target: "_blank", rel: "noopener" },
      avatar(p?.picture, r.pubkey, 48),
      h("div", { class: "grow min0" }, h("div", { class: "id-name ellipsis" }, displayName(p, r.pubkey)), h("div", { class: "muted small mono" }, ok ? shortAddr(v.address!) : "no BCH link")),
      statusPill(v),
    ),
  );
}

function renderWallet(root: HTMLElement) {
  const list = h("div", {});
  const show = () => {
    const s = wallet.lastScan;
    if (!wallet.ready || !s) return clear(list);
    clear(
      list,
      h("div", { class: "label" }, "Addresses with history"),
      h(
        "div",
        { class: "addr-options" },
        s.addresses.filter((a) => a.used).map((a) => h("div", { class: "addr-opt" }, h("span", { class: "mono" }, shortAddr(a.address)), h("span", { class: "muted small" }, `${a.path}/${a.index}`), h("span", { class: "right" }, `${formatBch(a.balance)} BCH`))),
      ),
    );
  };
  wallet.addEventListener("change", show);
  clear(root, h("div", { class: "page-head" }, h("h1", {}, "Wallet")), h("section", { class: "card" }, walletPanel(), list));
  show();
}

const { main, nav } = shell();

function route() {
  const hash = location.hash.replace(/^#\/?/, "");
  const [r, ...rest] = hash.split("/");
  const arg = rest.join("/");
  nav.querySelectorAll("a").forEach((a) => a.classList.toggle("active", a.getAttribute("data-r") === (r === "id" ? "" : r)));
  document.body.classList.remove("embed");
  window.scrollTo(0, 0);
  switch (r) {
    case "id":
      return void renderIdentity(main, arg);
    case "badge":
      return void renderBadge(main, arg);
    case "link":
      return renderLink(main);
    case "login":
      return renderLogin(main);
    case "how":
      return renderHow(main);
    case "wallet":
      return renderWallet(main);
    default:
      return renderHome(main);
  }
}

window.addEventListener("hashchange", route);
// Resume a paired wallet after a reload (no new QR needed).
if (wallet.hasStoredSession()) wallet.start(false);
route();
