# @artblocks/abx-sdk

The neutral, low-level TypeScript library for the ABX protocol — deploy, reconstruct from chain,
resolve a token, verify content. It picks no provider, no UX, and (beyond a default chain target)
no chain. Every ABX surface is built on this: the [`abx` CLI](https://docs.abx.io/docs/using-abx/installation)
is a shell over it, the reference resolver reads through it, and a competing provider can import
this same public library. If you're scripting one-off operations, the CLI is usually faster to
reach for — install with `abx skill install` and let an agent drive it. Reach for the SDK when you're
building something programmatic: a server, a mint endpoint, a scheduled job.

ESM-only, built on [viem](https://viem.sh), requires Node 22.13+. The package's main entry is
**browser-safe** — bundled and tested under `platform: 'browser'` on every change.

## Install

```bash
npm install @artblocks/abx-sdk viem
```

```ts
import { makePublicClient, ensureFactory, deployOneOfOne } from '@artblocks/abx-sdk';
import { oneOfOneImageAbi } from '@artblocks/abx-sdk/abi';
```

## The send-injection model

Every write returns a `PreparedTx` — unsigned, with a human-readable `summary`/`fields` for a sign
page. The SDK never signs or broadcasts; it takes one function you provide:

```ts
type SendTx = (tx: PreparedTx) => Promise<TransactionReceipt>;
```

Every `deploy*`/`ensure*`/`prepare*`-and-execute function takes a `SendTx` as an argument, so how a
transaction gets signed is entirely your call:

- **`makeHotSender({ wallet, account, publicClient, onEvent? })`** — for an env/hot key. Pins the
  nonce once (a distributed RPC can briefly serve a stale count right after a send, so it tracks the
  nonce locally rather than re-reading it), detects an `eth_estimateGas` that came back impossibly
  low (a sign the node hasn't seen a just-deployed target's code yet) and retries rather than sending
  an under-funded transaction, and throws a typed `TxRevertedError` — never reports a burned,
  reverted transaction as "confirmed."
- **Bring your own** — a browser wallet, a Safe/multisig flow, a queue you drain later. Anything
  that signs a `PreparedTx.data` and returns a `TransactionReceipt` works.

Sequences: `runPrepared(txs, send)` sends a list in order. `batchOps(ops)` collapses same-target
runs into one `Multicallable.multicall` transaction — several owner edits become one signature,
all-or-nothing.

## Worked example: deploy → upload → mint → read

```ts
import {
  makePublicClient, makeWalletClient, makeHotSender,
  ensureFactory, deployOneOfOne, saltFor, predictClone,
  prepareMint, runPrepared, listTokens, reconstructProject, readSaleConfig,
  encodeTag, type OneOfOneInitParams,
} from '@artblocks/abx-sdk';
import { resolveBackend, uploadAndLocate } from '@artblocks/abx-storage';
import { zeroAddress, toHex } from 'viem';

const publicClient = makePublicClient({ chainKey: 'base-sepolia' });
const { wallet, account } = makeWalletClient({ chainKey: 'base-sepolia' }); // reads ABX_DEPLOYER_PK
const send = makeHotSender({ wallet, account, publicClient });

// 1. Deploy — resolve (or bootstrap) the chain's trust anchor, then deploy a clone.
const factory = await ensureFactory(publicClient, send, { chainId: 84532 });
const salt = saltFor(account.address); // front-run-proof: reserves the address to this signer
const clone = await predictClone(publicClient, { factory, salt });

// 2. Upload — put the image somewhere fetchable before baking its URL on-chain.
const backend = resolveBackend({ backend: 'ipfs' }); // or 'cloud' / 'arweave' / 'fs'
const bytes = new Uint8Array(/* … read your file … */);
const { locator } = await uploadAndLocate(backend, 'art.png', { bytes, contentType: 'image/png' });

const params: OneOfOneInitParams = {
  owner: account.address,
  mintTo: zeroAddress, // defer minting to step 3
  name: 'My Piece', symbol: 'MYPC',
  tokenURIBase: '', tokenURIRenderer: zeroAddress,
  contractURIBase: '', contractURIRenderer: zeroAddress,
  royaltyReceiver: account.address, royaltyBps: 500,
  transferValidator: zeroAddress, // plain ERC-721; see ERC-721C in the site docs to opt in
  tokenFields: [
    // Bake the uploaded locator on-chain as the `image` field (an ipfs:// URI here; `arweave`/
    // `url`/`keccak256` are the other off-chain representations — see the site docs for the choice,
    // and `stageFieldContent` to put the bytes fully on-chain instead).
    { field: encodeTag('image'), representation: encodeTag('ipfs'), value: toHex(locator) },
  ],
  contractFields: [],
};
const { txHash } = await deployOneOfOne(send, publicClient, { factory, params, salt });

// 3. Mint — deploy deferred it (mintTo was the zero address), so mint explicitly.
await runPrepared([prepareMint({ contract: clone, to: account.address, chainId: 84532 })], send);

// 4. Read — straight from chain, no indexer required.
const listing = await listTokens(publicClient, clone);              // owners, seeds, params
const state = await reconstructProject(publicClient, {              // full protocol state
  address: clone, fromBlock: (await publicClient.getBlockNumber()) - 100n,
});
```

`encodeTag`/`decodeTag` (from the same package) turn a field name like `"image"` into the
`bytes32` tag the contract expects — spelled out above only so the snippet is self-contained.
Selling through the shared fixed-price minter is `prepareConfigureSale` + `preparePurchase` +
`readSaleConfig(publicClient, minter, clone)` — see the [SDK reference](https://docs.abx.io/docs/reference/sdk)
for the full surface (Series, code/generative projects, on-chain content staging, ERC-721C, and more).

## Browser use

The package's main entry (`.`) has **no Node-only imports** — it's bundled under
`platform: 'browser'` and asserted clean of `node:*` resolution on every change. In a browser:

- Pass `rpcUrls: [...]` explicitly to `makePublicClient`/`makeWalletClient` — there's no `process.env`
  to fall back to, and the SDK never assumes one.
- Sign with a connected wallet (build the `SendTx` yourself around it) rather than `makeHotSender`,
  which expects a local `WalletClient` backed by a key.
- **Never** import `@artblocks/abx-sdk/node` — that subpath is the *only* place `.env` loading lives
  (`loadDotEnv`, needs `node:fs`/`node:path`) and it will break a browser bundle. A host (a CLI, a
  server) calls `loadDotEnv()` once at startup; the SDK core just reads whatever's already in
  `process.env` via a tiny `readEnv` that's a no-op outside Node.

The only signing-key env var the SDK ever reads is `ABX_DEPLOYER_PK` (via `makeWalletClient`/
`envSigningKey`) — and only as a *fallback* when you don't pass `privateKey`/`rpcUrls` explicitly.

## More

Full API documentation by task (deploy, sell, operate, read, embed in a browser, talk to a resolver)
is in the [SDK reference](https://docs.abx.io/docs/reference/sdk).
