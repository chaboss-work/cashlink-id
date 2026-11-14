// Spike: read balance and UTXOs of an address from public Fulcrum servers (read-only).
import { ElectrumClient } from "@electrum-cash/network";
import { cashAddressToLockingBytecode, sha256, binToHex } from "@bitauth/libauth";

const address = process.argv[2] ?? "bitcoincash:qrcjtu5lg8l3hgtflqjaap784eqntgdsrcup0jf9fz";
const lock = cashAddressToLockingBytecode(address);
if (typeof lock === "string") throw new Error(lock);
const scripthash = binToHex(sha256.hash(lock.bytecode).reverse());

for (const host of ["bch.imaginary.cash", "electroncash.de", "bch.loping.net"]) {
  try {
    const client = new ElectrumClient("cashlink-spike", "1.4.1", host);
    await client.connect();
    const tip: any = await client.request("blockchain.headers.get_tip");
    const bal: any = await client.request("blockchain.scripthash.get_balance", scripthash);
    const utxos: any = await client.request("blockchain.scripthash.listunspent", scripthash);
    console.log(host, "tip", tip?.height, "balance", JSON.stringify(bal), "utxos", Array.isArray(utxos) ? utxos.length : utxos);
    await client.disconnect();
  } catch (e) {
    console.log(host, "error", String(e).slice(0, 160));
  }
}
process.exit(0);
