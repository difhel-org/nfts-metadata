# NFT metadata and Persik deployment

Public NFT assets live in `persik/`. `test/` is the separate legacy collection.
The Bun/TypeScript CLI deploys **Difhel’s Persik Lab** using the burn-enabled
[`difhel/acton-contracts/nft-v1.1`](https://github.com/difhel/acton-contracts/tree/d360e771c489899cdb007b4b2fcb92d993aa742d/nft-v1.1) contracts.

## Setup

Requires Bun 1.3.11 or newer. Run from this repository’s root:

```sh
bun install --frozen-lockfile
cp -n .env.example .env
```

Fill in `.env` locally:

```dotenv
SEED_PHRASE="your TON wallet mnemonic"
WALLET_VERSION=w5
TON_NETWORK=mainnet
TONCENTER_API_KEY=
```

- `SEED_PHRASE` and `WALLET_VERSION` are required. Supported versions: `v4r2`
  and `w5` (Wallet V5R1). Workchain 0, standard wallet IDs; W5 subwallet 0.
- `TON_NETWORK` is optional: `mainnet` by default, or `testnet`. W5 uses the
  corresponding network global ID (-239 / -3). The network is always displayed.
- `TONCENTER_API_KEY` is optional.
- `TONCENTER_RPS` sets the maximum request starts per second, shared by API v2,
  API v3, retries and submission. Default: **0.8** without an API key, **3** with
  a key. Accepts positive numbers up to 1000, including fractional rates.
  Set it to the rate allowed by your Toncenter plan, for example `TONCENTER_RPS=10`.
  This controls request rate, not simultaneous request count. A higher local
  limit does not increase the provider's quota; HTTP 429/503 reads use backoff.
- NFT checks run in parallel (up to 8 at a time) while respecting that shared
  rate. Results stay in index order. Twenty absent NFTs require about 40 reads:
  roughly 40 seconds at 1 req/s or 4 seconds at 10 req/s, plus network latency.
- In a terminal, progress updates a single line (`Fetching 7/20 NFTs …`) and
  clears it before the table, confirmation prompt or error. Redirected output
  contains final results without progress lines or terminal escape sequences.
- `.env` files are ignored by Git. The seed is used locally and never sent to APIs.

## Inspect

```sh
bun run info
```

Reads the collection name and NFT names/indices from `persik/collection.json`
and `persik/tokens/<index>.json`, derives their addresses, and prints:

```text
Name                   | Status           | Address
Genesis Persik #0      | ❌ non-existent  | EQ...
Persik the Scientist #1| ✅ deployed      | EQ...
Persik in Orbit #2     | 🔥 burned        | EQ...
```

These are illustrative rows, not the actual deployment state. Wallet addresses are
printed in non-bounceable form (`UQ...` on mainnet, `0Q...` on testnet).
Collection and NFT addresses use bounceable form (`EQ...` on mainnet, `kQ...`
on testnet). The network is also shown separately. These display flags do not
change the underlying account address or the outgoing message's bounce flag.

Status comes from account state and Toncenter transaction history, not metadata
or `nextItemIndex`. A burn requires a successful NFT transfer to the basechain
zero address that actually destroyed the account. Dust transfers after a burn
do not hide it. Missing history, stale index data, RPC errors, frozen accounts,
and active but uninitialized NFT contracts cause an error instead of a guessed
status. History scanning is bounded to 10,000 transactions per absent NFT.

## Mint / re-mint

```sh
bun run mint 0 0     # only NFT #0; also deploys the collection if needed
bun run mint 1 19    # indices 1 through 19, inclusive
bun run mint 0 19    # all; already-deployed NFTs are skipped
```

The collection admin, transaction sender, and owner of every newly minted NFT
are the wallet derived from `.env`. A burned NFT is re-minted at its original
address with its current repository metadata URL and this wallet as owner.

Before signing, the CLI shows the network, wallet, collection, exact NFT list,
actions, destination addresses, attached TON and balance, then asks **`Confirm? y/n`**.
Only `y` confirms. It rechecks the approved plan before submitting once. It then
waits for every NFT and verifies its code, owner and metadata suffix on-chain.

New indices must be consecutive, starting at the collection’s `nextItemIndex`.
For a new collection, mint #0 first or include it in the first range. Earlier
burned or failed-to-deploy indices can be retried. Up to 249 items per call.

Attached amounts are constants in `scripts/contracts.ts`: 0.08 TON per NFT,
0.02 TON per NFT for collection execution/forwarding, and 0.05 TON when first
deploying the collection. An additional 0.05 TON balance buffer covers wallet
fees. These are **attached values, not exact costs**; unspent funds remain in
contracts. For example, the first `mint 0 0` attaches 0.15 TON and requires at
least 0.20 TON in the wallet.

If submission times out, it may still execute for up to 180 seconds; inspect
`bun run info` and wallet transactions before retrying. An accepted wallet
message is not proof that all child deployments succeeded. After a partially
successful batch, repeat the range: live NFTs are skipped. Avoid concurrent mint
processes or other wallet transactions while confirming/submitting.

## Transfer an NFT

```sh
bun run send 0 <recipient-address>
bun run send <nft-address> <recipient-address>
```

An index selects the NFT from the Persik collection derived from your current
wallet configuration. An explicit NFT address can also select a standard TEP-62
NFT from another collection, provided the `.env` wallet owns it. This form works
when an NFT has been received by a wallet other than the collection admin.

The CLI checks `get_nft_data`, ownership and the collection's
`get_nft_address_by_index`, then displays the network, NFT, sender, recipient and
attached amount before **`Confirm? y/n`**. Ownership, metadata, contract code,
wallet balance, signature authentication and seqno are rechecked before signing.
After submission it waits for the on-chain owner to match the recipient.

Recipient must be a raw or friendly basechain address (DNS names are not resolved).
A testnet-only address is rejected on mainnet. The zero burn address is rejected
by `send`, because sending this collection's NFTs there destroys them.

Each transfer attaches **0.1 TON** to the NFT and forwards **1 nanoton** in the
ownership notification. Excess TON returns to the sender. A 0.05 TON wallet fee
buffer is also required; attached value is not an exact fee estimate.
The existing `.env` wallet/network/API settings and request rate apply.
Cancellation sends nothing. Submission is never automatically retried. If a
network error or timeout occurs after submission, inspect ownership and wallet
transactions before retrying. `info` shows deployment state, not ownership.

## Stable deployment identity

Collection StateInit contains the derived admin, index 0, pinned NFT code,
10% royalties (100/1000, royalty address = admin), and these raw URLs:

- Collection: `https://raw.githubusercontent.com/difhel-org/nfts-metadata/main/persik/collection.json`
- NFT prefix: `https://raw.githubusercontent.com/difhel-org/nfts-metadata/main/persik/tokens/`
- Individual NFT content: `<index>.json`

No deployment address needs to be copied into a config file. Changing the seed,
wallet version, contract code or initial configuration derives a **different
collection**. Keep these fixed after deployment. Editing JSON contents at the
same URLs does not change addresses. Commit/push any metadata changes before
minting so the raw URLs are publicly available.

Burn uses the standard TEP-62 transfer to
`0:0000000000000000000000000000000000000000000000000000000000000000`.
The CLI exposes `info`, `mint` and `send`; the owner can burn using a wallet
that supports that operation.

## Source and validation

Vendored Tolk sources are unchanged from commit
`d360e771c489899cdb007b4b2fcb92d993aa742d` of `difhel/acton-contracts`.
Their MIT license is in `contracts/nft-v1.1/LICENSE`. Committed artifacts were
built directly with pinned `@ton/tolk-js` 1.4.2 (optimization level 2); Acton is
not required to run the CLI. Compiler version, source revision and code hash
are recorded in each artifact. Dependencies are pinned in `bun.lock`.

```sh
bun run build:contracts
bun run typecheck
bun test
```

Tests execute the compiled contracts in the TON sandbox: raw metadata getters,
all 20 NFTs, owner-only burn/refund, same-address re-mint, unauthorized requests,
index ordering, V4R2/W5 signed deployment and transfers on both networks,
confirmation cancellation and history-based status classification. They use
synthetic test keys and do not submit transactions to a public network.
