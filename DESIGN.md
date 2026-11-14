# BCH BLAZE 2026 — project design (prepared before the 14.11 kick-off)

Working name: **CashLink ID** — bind a Nostr identity to a Bitcoin Cash wallet, then pay anyone on Nostr in BCH by
their npub or NIP-05 name.

Targets: Mainnet track (main prize) + Paytaca bounty "Decentralized Identity" ($500 PUSD). One project, both.

## Rules that shape it (from the DoraHacks page and the pinned admin messages)
- Judges must be able to make a useful BCH **mainnet** transaction through the app, by clicking a link.
- WizardConnect (or XO) for the wallet connection. Live demo by link. Banner on the home page: Widget Factory
  presentation, repo link, CashTokens address for EMBER2026 (`bitcoincash:zrcjtu5lg8l3hgtflqjaap784eqntgdsrcmtuv8rk3`).
- Only work done **14–22.11** is judged. On 14.11: fork the repo and record a demo/code snapshot; the banner links
  to it. Work before 14.11 = research and spikes only.
- Judges give each project a couple of minutes: simple, fast, no rough edges.

## What WizardConnect gives a dapp (checked in @wizardconnect/dapp 0.2.2)
- `DappConnectionManager`: session via Nostr relay, wallet shares **xpubs per path** (receive, change, …),
  `signTransaction({ transaction, inputPaths })`.
- **No message signing.** So proof of control of a BCH key is a signed transaction.

## Identity binding (Paytaca bounty requirements → how)
1. **Creation:** user keeps both keys. Nostr key: NIP-07 extension (nos2x/Alby) or a key generated in the browser.
   BCH key: the user's wallet via WizardConnect. No custodian, no shared key.
2. **Binding proof, both directions:**
   - Nostr → BCH: a Nostr event (custom kind, NIP-78 style, `d`-tag `cashlink`) signed by the npub, containing the
     BCH address and the commitment txid.
   - BCH → Nostr: a mainnet **commitment transaction** from the wallet (WizardConnect signs it) with an OP_RETURN
     `CLID <nostr pubkey> <hash of the binding event content>`; its input signature proves control of the address.
3. **Discovery:** binding events live on public Nostr relays; anyone queries by npub (or NIP-05 → npub).
4. **Verification / authentication:** an independent verifier page (and a small JS library) fetches the event,
   checks the Nostr signature, fetches the tx from a public Fulcrum/Electrum server, checks that the OP_RETURN
   matches and that the tx input spends from the bound address. Challenge–response login: the verifier issues a
   nonce, the user signs it with the Nostr key (NIP-07), the verifier checks the npub has a valid binding.
5. **Demo + docs:** live page, source, architecture and verification spec.

Stretch goals we can reach:
- **Send BCH by identity** (the main-track "useful mainnet transaction"): type an npub or name@domain → resolve
  → verify the binding → build the payment → sign in Selene via WizardConnect → broadcast.
- Key rotation: a new binding event + new commitment tx; the latest valid pair wins, older ones show as superseded.
- Reusable library `cashlink-verify` (verification only, no keys).

## Business angle (judging criterion 4)
Nostr already has tipping ("zaps") over Lightning; CashLink gives Nostr users BCH tips and a verifiable
"this npub owns this BCH wallet" badge for marketplaces and merchants, with no account system.

## Tech
- Static site (GitHub Pages): TypeScript + Vite, `@wizardconnect/dapp` + `@wizardconnect/core`,
  `@bitauth/libauth` 3 for transactions, `nostr-tools` for events/relays/NIP-05, Electrum/Fulcrum websocket
  for UTXOs and broadcast.
- Fees: commitment tx ≈ 1 sat/byte → a few cents of BCH from the user's own wallet.

## Before 14.11 (spikes only, not the product)
- Connect Selene to a local test page via WizardConnect, read xpubs, derive the receive address.
- Build and sign a minimal OP_RETURN transaction through `signTransaction`; broadcast on **chipnet** if Selene
  supports it, otherwise prepare only.
- nostr-tools: publish and read back a test event on public relays.

## From the user
- Roll call on 14.11 14:00 UTC (wallet connect on bchblaze.cash/live).
- A few cents of BCH in Selene for the demo commitment transaction (the judges pay their own).
