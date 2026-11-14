# CashLink ID

**Pay anyone on Nostr in Bitcoin Cash.** CashLink ID links a Nostr identity to a BCH wallet with a proof signed by
both keys. Anyone can look a person up by npub or NIP-05 name, verify the link in the browser, and pay the verified
address from their own wallet. No accounts, no servers, no custody.

- **Live demo:** https://chaboss-work.github.io/cashlink-id/
- **Presentation:** https://chaboss-work.github.io/cashlink-id/slides.html
- **Protocol specification:** [SPEC.md](SPEC.md)
- **Pre-hackathon state (14.11.2026):** branch [`snapshot-2026-11-14`](https://github.com/chaboss-work/cashlink-id/tree/snapshot-2026-11-14):
  design notes and a WizardConnect test page only. Everything else was built 14–22 November 2026.
- **EMBER2026 votes (CashTokens):** `bitcoincash:zrcjtu5lg8l3hgtflqjaap784eqntgdsrcmtuv8rk3`

Built for **BCH BLAZE 2026** (mainnet track) and the Paytaca **Decentralized Identity** bounty.

## What you can do

| | |
|---|---|
| **Pay by identity** | Type an npub, nprofile or `name@domain`. The app finds the binding, verifies both proofs, shows the badge and lets you send BCH from any WizardConnect wallet (Selene, Paytaca, Cashonize). |
| **Link your identity** | Use a Nostr extension (NIP-07) or create a key in the browser, connect your wallet, approve one ~300-satoshi commitment transaction, publish the binding event. About a minute. |
| **Reverse lookup** | Paste a `bitcoincash:` address to find the Nostr identities linked to it, from the chain and from relays. |
| **Sign in with CashLink** | A demo app logs you in with a Nostr signature over a fresh challenge, then (optionally) a zero-fee wallet proof from the linked address. |
| **Badge and DID** | Embed a live, self-verifying badge with an `<iframe>`; see the identity as a `did:nostr` document. |

## How it works

```
 BCH wallet key ──signs──▶ commitment tx:  OP_RETURN "CLID" 01 <nostr pubkey> <sha256(statement)>
                                  ▲ txid
 Nostr key ───────signs──▶ kind 30078 event: content = statement, i-tags = address + txid
                                  │
 any verifier ◀── public Nostr relays + any Fulcrum server (no CashLink server)
```

1. **Statement** — canonical JSON `{"protocol":"cashlink-id","v":1,"nostr":…,"bch":…,"created":…}`.
2. **BCH → Nostr** — the wallet signs (through WizardConnect) a transaction that spends from the linked address and
   commits to the Nostr key and the statement hash. The `SIGHASH_ALL` signature covers the commitment, so only the
   address owner could make it. Change returns to the same address.
3. **Nostr → BCH** — the Nostr key signs a NIP-78 addressable event (`d=cashlink-id`) whose content is the statement,
   with NIP-73 `i` tags for the address and the commitment txid. Newest event wins (rotation); a revocation
   statement withdraws the link.
4. **Verification** — check the event signature, parse the canonical statement, fetch the transaction from Fulcrum,
   match the CLID output, evaluate the address input with the BCH VM (libauth), read confirmations.

Full details, discovery queries, rotation and the authentication flow: [SPEC.md](SPEC.md).

### Paytaca bounty checklist

| Requirement | CashLink ID |
|---|---|
| Identity creation & management, user-held keys | Nostr key in a NIP-07 extension or created in the browser; BCH key stays in the wallet (WizardConnect). No provider, no custody. |
| Cryptographic binding, both directions, no key reuse | On-chain commitment signed by the address key + Nostr event signed by the Nostr key, over the same statement hash. |
| Decentralised discovery | Relays (`#d`, `#i` filters) and the BCH address history; no database. |
| Verification & authentication | Independent verifier (browser library, public infrastructure); challenge–response sign-in with an optional wallet step-up. |
| Demo & documentation | Live app, this README, [SPEC.md](SPEC.md), tests. |
| Stretch goals | Identity-based BCH payments; key rotation and revocation; reusable library + spec; BCH transactions as identity commitments; DID view. |

## Run locally

Requires Node.js 22+.

```bash
cd app
npm install
npm run dev        # http://127.0.0.1:5180
npm test           # protocol tests + live checks against Fulcrum and Nostr relays
npm run build      # static site into ../docs (served by GitHub Pages)
```

## Code map

| Path | What |
|---|---|
| `app/src/lib/cashlink.ts` | Protocol: statement, commitment script, event template, address handling |
| `app/src/lib/verify.ts` | Independent verifier and BCH→Nostr discovery from the chain |
| `app/src/lib/wallet.ts` | WizardConnect session, address scan (gap limit), signing with checks |
| `app/src/lib/tx.ts` | Transaction building, fee, signed-transaction checks with the BCH VM |
| `app/src/lib/fulcrum.ts` | Minimal Electrum Cash protocol client with server failover |
| `app/src/lib/nostr.ts` | Relays, binding events, profiles, NIP-05, NIP-07 and local signers |
| `app/src/ui/` | Pages: pay/lookup, link wizard, sign-in demo, how it works, badge |
| `app/test/run.ts` | Tests |
| `spike/` | Pre-hackathon WizardConnect test page (11.11.2026) |

## Safety

- The app never asks for a seed phrase or a wallet key. Every transaction is approved in your wallet, and the app
  checks what the wallet returns (same inputs and outputs, valid signatures, expected fee) before broadcasting.
- Coins holding CashTokens are never spent.
- Payments are re-verified right before signing.
- Linking an address makes it public. Use a dedicated address if you want to keep your other coins private.

## License

MIT, see [LICENSE](LICENSE).
