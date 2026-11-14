import { initiateDappRelay, childIndexOfPathName } from "@wizardconnect/core";
import { DappConnectionManager } from "@wizardconnect/dapp";
import {
  hash160,
  encodeCashAddress,
  binToHex,
  hexToBin,
  utf8ToBin,
  cashAddressToLockingBytecode,
  encodeDataPush,
  flattenBinArray,
  encodeTransaction,
  decodeTransaction,
  hashTransaction,
} from "@bitauth/libauth";
import QRCode from "qrcode";

// Spike only (research before the 14.11 kick-off): connect, derive the address, sign one test commitment.
const EXPECTED = "bitcoincash:qrcjtu5lg8l3hgtflqjaap784eqntgdsrcup0jf9fz";
// The single UTXO on that address, read from Fulcrum on 2026-11-11 (unconfirmed funding tx).
const UTXO = { txid: "609a778f1acc6db907fcf657b1c5ea9a477060c7457506124cd8b70478c8f3ef", vout: 0, value: 8504943n };
const FEE = 300n;
const SESSION_KEY = "cashlink-spike-session";

const logEl = document.getElementById("log")!;
const log = (s: string, cls = "") => {
  const line = document.createElement("div");
  line.textContent = `${new Date().toISOString().slice(11, 19)}  ${s}`;
  if (cls) line.className = cls;
  logEl.appendChild(line);
  console.log(s);
};
const cashaddr = (pubkey: Uint8Array, tokens = false) => {
  const r = encodeCashAddress({ prefix: "bitcoincash", type: tokens ? "p2pkhWithTokens" : "p2pkh", payload: hash160(pubkey) });
  return typeof r === "string" ? r : r.address;
};

let manager: DappConnectionManager | null = null;
const signBtn = document.getElementById("sign") as HTMLButtonElement;
signBtn.disabled = true;

function onPaths() {
  if (!manager) return;
  const ci = childIndexOfPathName("receive");
  if (ci === undefined || !manager.hasPath(ci)) return; // the first walletready can arrive before the paths
  const a = cashaddr(manager.getPubkey(ci, 0n)!);
  log(`receive/0: ${a}${a === EXPECTED ? "  ← matches the Selene address" : "  (does not match!)"}`, a === EXPECTED ? "ok" : "bad");
  signBtn.disabled = a !== EXPECTED;
}

async function start(fresh: boolean) {
  manager = new DappConnectionManager("CashLink ID (spike)", undefined, { session: { key: SESSION_KEY } });
  const stored = fresh ? null : manager.loadStoredSession();
  if (fresh) manager.clearStoredSession();
  const relay = initiateDappRelay(
    (p) => {
      manager!.updateConnection(p.client, p.status);
      log(`relay: ${p.status.status}${p.status.error ? " " + p.status.error : ""}`);
    },
    stored?.walletPublicKey ? { existingCredentials: { privateKey: stored.privateKey, secret: stored.secret, walletPublicKey: stored.walletPublicKey } } : undefined,
  );
  manager.attachRelay(relay);
  manager.on("disconnect", (reason, msg) => {
    log(`disconnect: ${reason} ${msg ?? ""}`, "bad");
    signBtn.disabled = true;
  });
  manager.on("walletready", (msg) => {
    log(`wallet ready: ${msg.wallet_name}; paths: ${manager!.getSessionPaths().map((p) => p.name).join(", ") || "(none yet)"}`);
    onPaths();
  });
  if (stored?.walletPublicKey) {
    log("resuming the stored session — no QR needed");
    onPaths();
    return;
  }
  document.getElementById("qrbox")!.hidden = false;
  document.getElementById("uri")!.textContent = relay.uri;
  const canvas = document.createElement("canvas");
  await QRCode.toCanvas(canvas, relay.qrUri, { width: 280, margin: 1 });
  document.getElementById("qr")!.replaceChildren(canvas);
  log("QR ready — scan it in the wallet and approve the connection right away");
}

document.getElementById("connect")!.onclick = () => start(true);
if (localStorage.getItem(SESSION_KEY)) void start(false);

// relay-safe JSON, as in @wizardconnect/core hdwalletv1-serialize: bytes as hex, bigint as "<bigint: Xn>"
const relayBigint = (v: bigint) => `<bigint: ${v}n>`;

signBtn.onclick = async () => {
  if (!manager) return;
  const lock = cashAddressToLockingBytecode(EXPECTED);
  if (typeof lock === "string") throw new Error(lock);
  const opReturn = flattenBinArray([
    Uint8Array.of(0x6a),
    encodeDataPush(utf8ToBin("CLID")),
    encodeDataPush(utf8ToBin("spike test 2026-11-11, not an identity binding")),
  ]);
  const input = { outpointTransactionHash: hexToBin(UTXO.txid), outpointIndex: UTXO.vout, sequenceNumber: 0xffffffff, unlockingBytecode: Uint8Array.of() };
  const outputs = [
    { lockingBytecode: opReturn, valueSatoshis: 0n },
    { lockingBytecode: lock.bytecode, valueSatoshis: UTXO.value - FEE },
  ];
  const txHex = binToHex(encodeTransaction({ version: 2, locktime: 0, inputs: [input], outputs }));
  const sourceOutput = {
    outpointTransactionHash: UTXO.txid,
    outpointIndex: UTXO.vout,
    unlockingBytecode: "",
    sequenceNumber: 0xffffffff,
    valueSatoshis: relayBigint(UTXO.value),
    lockingBytecode: binToHex(lock.bytecode),
  };
  log(`asking the wallet to sign: 1 input (${UTXO.value} sat), OP_RETURN "CLID …", change ${UTXO.value - FEE} sat back to the same address, fee ${FEE} sat`);
  try {
    const res: any = await manager.signTransaction({
      transaction: {
        transaction: txHex,
        sourceOutputs: [sourceOutput] as any,
        broadcast: false,
        userPrompt: "CashLink spike: sign a test commitment (OP_RETURN). No payment to anyone; fee 300 sat.",
      },
      inputPaths: [[0, "receive", 0]],
    });
    if (res.error) {
      log(`wallet error: ${res.error}`, "bad");
      return;
    }
    const hex: string = res.signedTransaction;
    const decoded = decodeTransaction(hexToBin(hex));
    if (typeof decoded === "string") {
      log(`could not decode the signed tx: ${decoded}`, "bad");
      return;
    }
    const txid = hashTransaction(encodeTransaction(decoded));
    log(`signed: txid ${txid}, ${hex.length / 2} bytes, unlocking ${decoded.inputs[0].unlockingBytecode.length} bytes`, "ok");
    document.getElementById("signed")!.textContent = hex;
  } catch (e) {
    log(`sign failed: ${String(e)}`, "bad");
  }
};
