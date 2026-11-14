// Transaction building and checking (libauth). The wallet signs; this module never sees private keys.
import { binToHex, createVirtualMachineBCH, decodeTransaction, encodeTransaction, hashTransaction, hexToBin, type Output } from "@bitauth/libauth";

export const DUST = 546n;
export const FEE_RATE = 1n; // satoshis per byte (BCH network minimum)

export interface Utxo {
  txid: string;
  vout: number;
  value: bigint;
  height: number;
  path: "receive" | "change";
  index: number;
  address: string;
  lockingBytecode: Uint8Array;
}

export interface PlannedOutput {
  lockingBytecode: Uint8Array;
  valueSatoshis: bigint;
}

export interface UnsignedTx {
  hex: string;
  inputs: Utxo[];
  outputs: PlannedOutput[];
  fee: bigint;
  size: number;
  changeIndex: number; // -1 if no change output
}

const P2PKH_INPUT_MAX = 148; // 32+4+1+(1+72+1+33)+4, ECDSA worst case; Schnorr is 141
export const outputSize = (lock: Uint8Array) => 8 + 1 + lock.length;
export const estimateSize = (nInputs: number, locks: Uint8Array[]) => 10 + nInputs * P2PKH_INPUT_MAX + locks.reduce((a, l) => a + outputSize(l), 0);

function encode(inputs: Utxo[], outputs: PlannedOutput[]): string {
  return binToHex(
    encodeTransaction({
      version: 2,
      locktime: 0,
      inputs: inputs.map((u) => ({ outpointTransactionHash: hexToBin(u.txid), outpointIndex: u.vout, sequenceNumber: 0xffffffff, unlockingBytecode: Uint8Array.of() })),
      outputs,
    }),
  );
}

/**
 * Pick inputs (largest first) for `outputs`, add change to `changeLock` if it is above dust.
 * `feeRate` 0 builds a zero-fee transaction (used for the sign-in proof that must never be relayed).
 */
export function buildTx(utxos: Utxo[], outputs: PlannedOutput[], changeLock: Uint8Array, feeRate = FEE_RATE, preselected: Utxo[] = []): UnsignedTx {
  const target = outputs.reduce((a, o) => a + o.valueSatoshis, 0n);
  const pool = utxos.filter((u) => !preselected.some((p) => p.txid === u.txid && p.vout === u.vout)).sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const chosen = [...preselected];
  const locks = outputs.map((o) => o.lockingBytecode);
  const sum = () => chosen.reduce((a, u) => a + u.value, 0n);
  const feeWithChange = () => BigInt(estimateSize(chosen.length, [...locks, changeLock])) * feeRate;
  while (chosen.length === 0 || sum() < target + feeWithChange()) {
    const next = pool.shift();
    if (!next) {
      const feeNoChange = BigInt(estimateSize(chosen.length, locks)) * feeRate;
      if (chosen.length && sum() >= target + feeNoChange) break;
      const need = target + feeWithChange() - sum();
      throw new Error(`Not enough BCH in the wallet: ${need > 0n ? need : 1n} more satoshis needed`);
    }
    chosen.push(next);
  }
  const fee = feeWithChange();
  const change = sum() - target - fee;
  let finalOutputs = outputs;
  let changeIndex = -1;
  if (change >= DUST) {
    finalOutputs = [...outputs, { lockingBytecode: changeLock, valueSatoshis: change }];
    changeIndex = finalOutputs.length - 1;
  }
  const hex = encode(chosen, finalOutputs);
  const totalOut = finalOutputs.reduce((a, o) => a + o.valueSatoshis, 0n);
  return { hex, inputs: chosen, outputs: finalOutputs, fee: sum() - totalOut, size: hex.length / 2, changeIndex };
}

/** Source outputs in WizardConnect relay JSON (bytes as hex, bigint as "<bigint: Xn>"). */
export function relaySourceOutputs(inputs: Utxo[]) {
  return inputs.map((u) => ({
    outpointTransactionHash: u.txid,
    outpointIndex: u.vout,
    unlockingBytecode: "",
    sequenceNumber: 0xffffffff,
    valueSatoshis: `<bigint: ${u.value}n>`,
    lockingBytecode: binToHex(u.lockingBytecode),
  }));
}

export interface CheckedTx {
  txid: string;
  hex: string;
  size: number;
  fee: bigint;
}

/**
 * Check what the wallet returned: same inputs and outputs as planned, every signature valid (BCH VM),
 * and the fee is what we expect. Throws with a readable reason otherwise.
 */
export function checkSigned(signedHex: string, plan: UnsignedTx, minFeeRate = FEE_RATE): CheckedTx {
  const tx = decodeTransaction(hexToBin(signedHex));
  if (typeof tx === "string") throw new Error(`wallet returned an undecodable transaction: ${tx}`);
  if (tx.inputs.length !== plan.inputs.length || tx.outputs.length !== plan.outputs.length) throw new Error("wallet changed the transaction shape");
  tx.inputs.forEach((i, n) => {
    if (binToHex(i.outpointTransactionHash) !== plan.inputs[n].txid || i.outpointIndex !== plan.inputs[n].vout) throw new Error("wallet changed an input");
  });
  tx.outputs.forEach((o, n) => {
    const p = plan.outputs[n];
    if (o.valueSatoshis !== p.valueSatoshis || binToHex(o.lockingBytecode) !== binToHex(p.lockingBytecode) || o.token) throw new Error("wallet changed an output");
  });
  const sourceOutputs: Output[] = plan.inputs.map((u) => ({ lockingBytecode: u.lockingBytecode, valueSatoshis: u.value }));
  const vm = createVirtualMachineBCH(true);
  const ok = vm.verify({ transaction: tx, sourceOutputs } as any);
  if (ok !== true) throw new Error(`signature check failed: ${ok}`);
  const bin = hexToBin(signedHex);
  const fee = plan.inputs.reduce((a, u) => a + u.value, 0n) - tx.outputs.reduce((a, o) => a + o.valueSatoshis, 0n);
  if (fee < BigInt(bin.length) * minFeeRate) throw new Error(`fee ${fee} sat is below ${minFeeRate} sat/byte for ${bin.length} bytes`);
  return { txid: hashTransaction(bin), hex: signedHex, size: bin.length, fee };
}

/** Exact decimal BCH string → satoshis (no floating point). */
export function parseBch(input: string): bigint | null {
  const s = input.trim().replace(",", ".");
  const m = /^(\d*)(?:\.(\d{0,8}))?$/.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  return BigInt(m[1] || "0") * 100000000n + BigInt((m[2] ?? "").padEnd(8, "0") || "0");
}
export const formatBch = (s: bigint | number) => {
  const v = typeof s === "bigint" ? s : BigInt(s);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 100000000n;
  const frac = (a % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
};
