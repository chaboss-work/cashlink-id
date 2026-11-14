// Tiny DOM helpers. All untrusted text (Nostr profiles, relay data) goes through textContent, never innerHTML.
import QRCode from "qrcode";

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | null | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: (Child | Child[])[]) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element, ...children: (Child | Child[])[]) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function qrCanvas(text: string, size = 240): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.className = "qr";
  void QRCode.toCanvas(canvas, text, { width: size, margin: 1, color: { dark: "#0b1712", light: "#ffffff" } });
  return canvas;
}

export function copyButton(text: string | (() => string), label = "Copy") {
  const b = h("button", { class: "btn ghost small", type: "button" }, label);
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
      b.textContent = "Copied";
      setTimeout(() => (b.textContent = label), 1400);
    } catch {
      b.textContent = "Copy failed";
    }
  });
  return b;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string, kind: "ok" | "bad" | "" = "") {
  let el = document.getElementById("toast");
  if (!el) {
    el = h("div", { id: "toast", role: "status" });
    document.body.append(el);
  }
  el.className = `show ${kind}`;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el!.className = ""), 4200);
}

export const spinner = (text = "") => h("span", { class: "spin-wrap" }, h("span", { class: "spinner", "aria-hidden": "true" }), text);

export const safeUrl = (u?: string) => (u && /^https:\/\//i.test(u) ? u : undefined);

export function avatar(picture: string | undefined, seed: string, size = 56) {
  const src = safeUrl(picture);
  const hue = parseInt(seed.slice(0, 6), 16) % 360;
  const fallback = h("div", { class: "avatar fallback", style: `width:${size}px;height:${size}px;background:hsl(${hue} 45% 32%)` }, seed.slice(0, 2).toUpperCase());
  if (!src) return fallback;
  const img = h("img", { class: "avatar", src, width: size, height: size, alt: "", referrerpolicy: "no-referrer", loading: "lazy" });
  img.addEventListener("error", () => img.replaceWith(fallback));
  return img;
}

export const explorerTx = (txid: string) => `https://blockchair.com/bitcoin-cash/transaction/${txid}`;
export const explorerAddress = (a: string) => `https://blockchair.com/bitcoin-cash/address/${a.replace(/^bitcoincash:/, "")}`;

export const shortAddr = (a: string) => {
  const s = a.replace(/^bitcoincash:/, "");
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
};

export function link(href: string, text: string, external = true) {
  return h("a", external ? { href, target: "_blank", rel: "noopener noreferrer" } : { href }, text);
}

export function timeAgo(unix: number) {
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return new Date(unix * 1000).toISOString().slice(0, 10);
}
