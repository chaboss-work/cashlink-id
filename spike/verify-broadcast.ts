// Verify a signed transaction with the libauth BCH VM, check its outputs, and broadcast only with --broadcast.
import { ElectrumClient } from "@electrum-cash/network";
import { createVirtualMachineBCH, decodeTransaction, hexToBin, cashAddressToLockingBytecode, binToHex, hashTransaction, encodeTransaction, utf8ToBin } from "@bitauth/libauth";
const hex = process.argv[2];
const doBroadcast = process.argv.includes("--broadcast");
const ADDRESS = "bitcoincash:qrcjtu5lg8l3hgtflqjaap784eqntgdsrcup0jf9fz";
const UTXO_VALUE = 8504943n;
const tx = decodeTransaction(hexToBin(hex));
if (typeof tx === "string") throw new Error(tx);
const lock = cashAddressToLockingBytecode(ADDRESS);
if (typeof lock === "string") throw new Error(lock);
const sourceOutputs = [{ lockingBytecode: lock.bytecode, valueSatoshis: UTXO_VALUE }];
const vm = createVirtualMachineBCH();
const result = vm.verify({ transaction: tx, sourceOutputs });
console.log("VM verify:", result === true ? "VALID" : result);
console.log("txid:", hashTransaction(encodeTransaction(tx)));
console.log("inputs:", tx.inputs.map((i) => `${binToHex(i.outpointTransactionHash)}:${i.outpointIndex}`));
tx.outputs.forEach((o, n) => console.log(`output ${n}: ${o.valueSatoshis} sat, script ${binToHex(o.lockingBytecode).slice(0, 24)}… ${binToHex(o.lockingBytecode) === binToHex(lock.bytecode) ? "(= our address)" : ""}`));
const fee = UTXO_VALUE - tx.outputs.reduce((a, o) => a + o.valueSatoshis, 0n);
console.log("fee:", fee, "sat,", hexToBin(hex).length, "bytes");
const ok = result === true && tx.outputs.length === 2 && tx.outputs[0].valueSatoshis === 0n && tx.outputs[0].lockingBytecode[0] === 0x6a
  && binToHex(tx.outputs[1].lockingBytecode) === binToHex(lock.bytecode) && fee === 300n;
console.log("all checks:", ok ? "PASS" : "FAIL");
if (ok && doBroadcast) {
  const client = new ElectrumClient("cashlink-spike", "1.4.1", "bch.imaginary.cash");
  await client.connect();
  const r = await client.request("blockchain.transaction.broadcast", hex);
  console.log("broadcast result:", r);
  await client.disconnect();
}
process.exit(0);
