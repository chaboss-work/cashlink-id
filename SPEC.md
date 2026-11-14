# CashLink ID protocol, version 1

CashLink ID binds a **Nostr public key** to a **Bitcoin Cash address** with a proof from each key:

- **BCH → Nostr:** a mainnet transaction that spends a coin from the address and carries an `OP_RETURN`
  commitment to the Nostr key and to a statement.
- **Nostr → BCH:** a signed Nostr event that contains the same statement and points to that transaction.

A binding is valid only when both halves exist and agree. Anyone can verify it with public Nostr relays and any
Electrum Cash protocol server (Fulcrum). There is no CashLink server, registry or authority.

Status: experimental, built for BCH BLAZE 2026. The reference implementation is `app/src/lib/` in this repository
(`cashlink.ts`, `verify.ts`).

## 1. Statement

The statement is a JSON object serialised **canonically**: the keys in exactly this order, no whitespace, integers
in decimal, strings as produced by `JSON.stringify`.

```json
{"protocol":"cashlink-id","v":1,"nostr":"<64 lowercase hex>","bch":"bitcoincash:q…","created":1763130000}
```

| field      | meaning                                                                                 |
|------------|-----------------------------------------------------------------------------------------|
| `protocol` | the literal `cashlink-id`                                                               |
| `v`        | protocol version, `1`                                                                   |
| `nostr`    | the Nostr public key (x-only, 32 bytes) as lowercase hex                                |
| `bch`      | the linked address: mainnet CashAddress, P2PKH, with prefix, **non-token form** (`q…`)   |
| `created`  | Unix time (seconds) when the statement was made                                          |

A parser MUST re-serialise the parsed fields and reject the statement if the result differs byte for byte from the
input. This makes `sha256(statement)` unambiguous.

A **revocation statement** withdraws the binding:

```json
{"protocol":"cashlink-id","v":1,"nostr":"<hex>","revoked":true,"created":1763130000}
```

## 2. Commitment transaction (BCH → Nostr)

A standard BCH transaction that:

1. has at least one input that spends a P2PKH output locked to the `bch` address, unlocked with a signature whose
   sighash type has base type `SIGHASH_ALL` (with `SIGHASH_FORKID`; `SIGHASH_UTXOS` and `ANYONECANPAY` are allowed);
2. has one output with value 0 and this locking bytecode:

```
OP_RETURN <"CLID"> <0x01> <nostr pubkey, 32 bytes> <sha256(statement), 32 bytes>
```

All pushes are minimal (`0x01` is therefore encoded as `OP_1`). The script is 73 bytes. Change normally goes back to
the same address, so the only cost is the network fee (about 300 satoshis at 1 sat/byte).

Because the input signature covers every output, only the holder of the address key could have created a
transaction that both spends from the address and contains this commitment.

Why a transaction and not a signed message: WizardConnect (the wallet-connection protocol used by Selene, Paytaca
and Cashonize) offers transaction signing but no message signing. The on-chain commitment also gives a timestamp and
an order for rotations, and makes the BCH side discoverable from the address history alone.

## 3. Binding event (Nostr → BCH)

A Nostr event signed by the `nostr` key:

| field     | value                                                                                         |
|-----------|-----------------------------------------------------------------------------------------------|
| `kind`    | `30078` (NIP-78 application data; addressable, so the newest event replaces older ones)       |
| `content` | the statement, byte for byte                                                                   |
| tags      | `["d","cashlink-id"]`                                                                         |
|           | `["i","bitcoincash:address:<address without prefix>"]` (NIP-73 blockchain address id)         |
|           | `["i","bitcoincash:tx:<commitment txid>"]` (NIP-73 blockchain transaction id)                 |
|           | `["k","bitcoincash:address"]`                                                                 |
|           | `["alt","CashLink ID: …"]` (NIP-31 human-readable fallback)                                   |

Publish it to several public relays. Recommended: `wss://nos.lol`, `wss://relay.primal.net`,
`wss://relay.damus.io`, `wss://nostr.mom`.

A revocation is a binding event whose content is a revocation statement; it carries only the `d` and `alt` tags.

## 4. Verification

Given a Nostr public key `P` (from an npub, nprofile or a NIP-05 name):

1. Query relays for `{"kinds":[30078],"authors":[P],"#d":["cashlink-id"]}`. Discard events with an invalid
   signature. Take the one with the highest `created_at` (ties: lowest id).
2. Parse the content as a canonical statement. Require `nostr == P`. If it is a revocation, the result is
   **revoked**.
3. Require the `i` address tag to equal `bitcoincash:address:<statement.bch without prefix>`, and read the
   `bitcoincash:tx:` tag → `txid`.
4. Fetch the raw transaction `txid` from a Fulcrum server and check that its hash equals `txid`.
5. Require an output whose script parses as a CLID v1 commitment with pubkey `P` and hash `sha256(content)`.
6. Fetch the source outputs of all inputs. Require an input `i` such that the source output is the P2PKH locking
   script of `statement.bch`, its unlocking script is `<sig> <pubkey>` with `hash160(pubkey)` equal to the address
   hash, the sighash type is `SIGHASH_ALL`-based, and evaluating input `i` with the BCH VM succeeds.
7. Read the transaction height from the address history. Mined → **verified**; in the mempool →
   **unconfirmed** (both proofs valid, waiting for a block). Any failed check → **invalid**.

No CashLink endpoint is contacted. The reference verifier runs in the browser with `@bitauth/libauth` (VM),
`nostr-tools` (signatures, relays) and a WebSocket connection to Fulcrum.

## 5. Discovery

- **By identity:** npub / nprofile / NIP-05 → public key → step 1 above.
- **By address, on Nostr:** `{"kinds":[30078],"#i":["bitcoincash:address:<address>"]}`.
- **By address, on chain:** walk the address history (`blockchain.scripthash.get_history`), decode each
  transaction, keep CLID outputs in transactions with an input unlocked by the address key. Each one names a Nostr
  key, which must then pass the full verification and point back to this address.
- **Directory:** `{"kinds":[30078],"#d":["cashlink-id"]}` lists recent bindings on a relay.

## 6. Key rotation and recovery

- New wallet or new address: make a new statement and commitment, publish a new binding event. The newest event
  wins; older commitments remain on chain but are no longer referenced.
- Withdraw: publish a revocation statement.
- Lost Nostr key: the old binding cannot be updated. Create a new Nostr identity and link it; announce the change
  from the old key if it is still available.
- Lost wallet: link a new address with the same Nostr key.

## 7. Authentication (challenge–response)

An application that wants to log a user in:

1. creates a random 32-byte challenge `c`, valid once and for a short time;
2. asks the user to sign a Nostr event with kind `22242` (NIP-42 shape), tags `["challenge", c]` and
   `["relay", <app URL>]`;
3. checks the signature, the challenge, the app URL and the age (≤ 10 minutes);
4. verifies the CashLink binding of the signer (section 4). The user is now known by Nostr key and BCH address.

Optional step-up proof of the wallet key: the wallet signs (through WizardConnect) a transaction that spends a coin
from the linked address with outputs `OP_RETURN <"CLAU"> <c>` and the full input value back to the same address,
**with a zero fee**. The application evaluates the input with the BCH VM, checks that it is the linked key with
`SIGHASH_ALL` and that the OP_RETURN carries `c`, then discards it. A zero-fee transaction is below the relay fee
floor, and even if mined it would only move the coin back to its owner.

## 8. Security notes

- No private key ever leaves its wallet or signer. The app never sees seed phrases or nsec keys from wallets or
  extensions; keys created in the browser stay in that browser's storage until the user exports them.
- The two keys are independent (Schnorr Nostr key; BCH wallet key). Nothing is reused across chains.
- A binding needs both halves. An address owner cannot claim someone else's npub (no matching Nostr event), and a
  Nostr user cannot claim someone else's address (no matching transaction signed by the address key).
- The commitment hashes the full statement, including the timestamp, so a commitment cannot be reused for a
  different statement.
- Payers should re-verify right before paying; the reference app does this.
- Linking a static address reveals that address's history. Use a dedicated address for the identity.

## 9. DID view

A verified binding can be shown as a `did:nostr:<hex>` document with the BCH address in `alsoKnownAs` and a
`CashLinkBinding` service entry pointing to the commitment txid and the binding event id. The reference app renders
it under "For developers" on each identity page.
