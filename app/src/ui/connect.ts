// WizardConnect pairing panel: QR for phone wallets, wiz:// link for wallets on the same device.
import { wallet } from "../lib/wallet.js";
import { fulcrum } from "../lib/fulcrum.js";
import { formatBch } from "../lib/tx.js";
import { clear, copyButton, explorerTx, h, link, qrCanvas, shortAddr, spinner, toast } from "./dom.js";

/**
 * A self-updating wallet box. `onReady` runs once each time the wallet becomes ready
 * (after pairing, resume or a fresh wallet_ready).
 */
export function walletPanel(opts: { title?: string; hint?: string; onReady?: () => void } = {}): HTMLElement {
  const box = h("div", { class: "wallet-panel" });
  let wasReady = false;

  const render = () => {
    if (box.isConnected) box.dataset.mounted = "1";
    else if (box.dataset.mounted) {
      wallet.removeEventListener("change", render);
      return;
    }
    if (wallet.ready) {
      const scan = wallet.lastScan;
      clear(
        box,
        h(
          "div",
          { class: "wallet-row" },
          h("span", { class: wallet.live ? "dot ok" : "dot wait" }),
          h(
            "div",
            { class: "grow" },
            h("strong", {}, wallet.walletName),
            wallet.live ? " connected" : " paired",
            h("div", { class: "muted small mono" }, shortAddr(wallet.address("receive", 0))),
            wallet.live ? null : h("div", { class: "small warn-text" }, `Waiting for ${wallet.walletName} to answer: open the wallet app. Still silent after a minute? Disconnect and pair again.`),
          ),
          h("div", { class: "right" }, scan ? h("strong", {}, `${formatBch(scan.balance)} BCH`) : spinner("reading balance")),
          h("button", { class: "btn ghost small", onclick: () => wallet.stop(true) }, "Disconnect"),
        ),
      );
      if (!wasReady) {
        wasReady = true;
        wallet.ensureScan(fulcrum()).catch((e) => toast(`Could not read the wallet balance: ${e.message}`, "bad"));
        // After the current render: callers may create this panel before their onReady handler is defined.
        if (opts.onReady) queueMicrotask(opts.onReady);
      }
      return;
    }
    wasReady = false;
    if (wallet.manager) {
      const waiting = wallet.relayState === "connected" ? "Waiting for your wallet to approve…" : `Connecting to the WizardConnect relay (${wallet.relayState})…`;
      clear(
        box,
        h("div", { class: "pair" }, h("div", { class: "qr-wrap" }, qrCanvas(wallet.qrUri, 220)), h(
          "div",
          { class: "pair-help" },
          h("strong", {}, opts.title ?? "Scan with your BCH wallet"),
          h("ol", {}, h("li", {}, "Open Selene, Paytaca or Cashonize"), h("li", {}, "Tap Scan / WizardConnect and scan this code"), h("li", {}, "Approve the connection")),
          h("div", { class: "row gap" }, h("a", { class: "btn small", href: wallet.uri }, "Open wallet on this device"), copyButton(wallet.uri, "Copy link")),
          h("p", { class: "muted small" }, spinner(waiting)),
          h("button", { class: "btn ghost small", onclick: () => wallet.stop(true) }, "Cancel"),
        )),
      );
      return;
    }
    clear(
      box,
      h(
        "div",
        { class: "wallet-row" },
        h("span", { class: "dot" }),
        h("div", { class: "grow" }, h("strong", {}, "No wallet connected"), h("div", { class: "muted small" }, opts.hint ?? "Pair any WizardConnect wallet. Keys stay in your wallet; you approve every transaction there.")),
        wallet.hasStoredSession() ? h("button", { class: "btn ghost small", onclick: () => wallet.start(false) }, "Resume session") : null,
        h("button", { class: "btn", onclick: () => wallet.start(true) }, "Connect wallet"),
      ),
    );
  };

  wallet.addEventListener("change", render);
  render();
  return box;
}

/** Header chip: shows the wallet state everywhere. */
export function walletChip(): HTMLElement {
  const chip = h("button", { class: "chip", type: "button", title: "WizardConnect wallet" });
  const render = () => {
    if (wallet.ready) {
      const bal = wallet.lastScan ? ` · ${formatBch(wallet.lastScan.balance)} BCH` : "";
      clear(chip, h("span", { class: "dot ok" }), `${wallet.walletName}${bal}`);
    } else if (wallet.manager) clear(chip, h("span", { class: "dot wait" }), "Pairing…");
    else clear(chip, h("span", { class: "dot" }), "Wallet");
  };
  chip.addEventListener("click", () => {
    if (!wallet.ready && !wallet.manager) location.hash = "#/wallet";
  });
  wallet.addEventListener("change", render);
  render();
  return chip;
}

/** "Approve in <wallet>" status for a pending sign request; says what to do while the wallet is silent. */
export function approveHint(what: string): HTMLElement {
  const box = h("div", {});
  const render = () => {
    if (!box.isConnected && box.dataset.mounted) return wallet.removeEventListener("change", render);
    if (box.isConnected) box.dataset.mounted = "1";
    clear(
      box,
      spinner(`Approve in ${wallet.walletName}: ${what}`),
      wallet.live
        ? h("p", { class: "muted small" }, `The request is in ${wallet.walletName}. Open the app if it did not pop up.`)
        : h("p", { class: "small warn-text" }, `${wallet.walletName} is not answering yet. Open the wallet app: the request is sent again as soon as it reconnects.`),
    );
  };
  wallet.addEventListener("change", render);
  render();
  return box;
}

/** Page-wide notice for a sign request made before a reload (recovered, waiting or failed). */
export function recoveryNotice(): HTMLElement {
  const box = h("div", { class: "recovery" });
  const render = () => {
    const r = wallet.recovery;
    if (!r) return clear(box);
    const label = r.pending.label;
    if (r.state === "done")
      return clear(
        box,
        h(
          "div",
          { class: "success" },
          h("strong", {}, "Approved before the page reloaded, now sent: "),
          label,
          r.txid ? h("div", { class: "mono small wrap" }, link(explorerTx(r.txid), r.txid)) : null,
          r.pending.purpose === "commit" ? h("div", { class: "small" }, h("a", { href: "#/link" }, "Continue linking →")) : null,
          h("button", { class: "btn ghost small", type: "button", onclick: () => ((wallet.recovery = null), render()) }, "Dismiss"),
        ),
      );
    if (r.state === "failed")
      return clear(
        box,
        h("div", { class: "error" }, h("strong", {}, `Earlier request (${label}) was not sent: `), r.error, " ", h("button", { class: "btn ghost small", type: "button", onclick: () => ((wallet.recovery = null), render()) }, "Dismiss")),
      );
    clear(
      box,
      h(
        "div",
        { class: "notice" },
        h("strong", {}, `Waiting for ${wallet.walletName}: ${label}`),
        h("p", { class: "small" }, "You started this before the page reloaded. If you approve it in your wallet, it is checked and sent from here automatically."),
        r.state === "resending"
          ? spinner(`Sent to ${wallet.walletName} again, approve it there`)
          : h(
              "div",
              { class: "row gap" },
              h("button", { class: "btn small", type: "button", disabled: !wallet.ready, onclick: () => void wallet.resendRecovery() }, "Send to wallet again"),
              h("button", { class: "btn ghost small", type: "button", onclick: () => wallet.discardRecovery() }, "Discard"),
            ),
      ),
    );
  };
  wallet.addEventListener("change", render);
  render();
  return box;
}
