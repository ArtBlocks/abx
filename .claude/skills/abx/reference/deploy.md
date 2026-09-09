# Static projects and editions

Use this reference for `abx deploy`, `abx deploy-series`, their `--copies` editions, content
placement, identity, mint timing, and deploy confirmation.

## Contents

- [Choose the contract shape](#choose-the-contract-shape)
- [Choose custody and resolution](#choose-custody-and-resolution)
- [Understand on-chain reach](#understand-on-chain-reach)
- [Prepare identity and economics](#prepare-identity-and-economics)
- [Plan editions correctly](#plan-editions-correctly)
- [Plan, execute, and verify](#plan-execute-and-verify)

## Choose the contract shape

Start from the artifact and supply model, not from a preferred storage backend:

| Creator intent | Command | Contract family |
|---|---|---|
| One static work, one token | `abx deploy` | OneOfOneImage, ERC-721 |
| Folder of N distinct works | `abx deploy-series` | SeriesImage, ERC-721 |
| One work with multiple copies | `abx deploy --copies <n|open>` | OneOfOneEdition, ERC-1155 |
| N distinct works, copies of each | `abx deploy-series --copies <n|open>` | EditionImage, ERC-1155 |

If the work needs collector parameters, state-derived output, or configure/transfer/augment hooks,
use `deploy-code` even when the visible artifact looks static. Contract family is fixed at deploy;
static contracts cannot gain code extensions later.

Run `abx capabilities --json` and the chosen command's help before constructing the plan. The
capability contract, help, flag validation, and dry-run output are current product truth.

## Choose custody and resolution

Treat custody, resolution, and mutability as separate decisions.

### Bytes and metadata fully on-chain

Use `--onchain-image [--compress fastlz]` for static media bytes behind the on-chain metadata
renderer. It implies on-chain resolution and requires no host or storage provider. It works for 721
static projects and their editions in hot or wallet lanes. Cold `--unsigned` staging is refused.

Use `fastlz` for on-chain-readable compression. Gzip is an off-chain decode format and cannot be
substituted for an on-chain-rendered field. Bare `--onchain-uri` may inline very small SVG/text
content, but the reader/chunk path is normally more economical for real files; trust the dry-run's
measured plan rather than a memorized byte threshold.

### Media external, metadata JSON on-chain, no resolver

Use `--onchain-uri --backend arweave|ipfs|cloud`. The CLI uploads media, bakes its public locator into
on-chain JSON, and does not require an ABX resolver. This is often the simplest durable path for
static collections:

- Arweave provides pay-once permanent custody through the configured uploader, but needs the
  optional `@artblocks/abx-storage-arweave` package installed alongside the CLI first (see
  [hosting.md](hosting.md#arweave)) — it is not part of the default install.
- IPFS requires maintained pinning and a public gateway; a local kubo gateway is development-only.
- Cloud requires an authenticated upload endpoint and a distinct public read base/CDN URL.

For uniform-extension Series folders, the CLI can use a shared directory/template representation
rather than one collection field per item. Let the dry run report the chosen representation.

This path can still carry on-chain description, attributes, authorship, license, and other reserved
fields. “External image” does not mean “off-chain metadata.”

### Hosted resolver

Use `--public-base-url https://…` when metadata must remain operationally editable, when arbitrary
attached files need enumeration, when large on-chain reads need an HTTP front, or when a JavaScript
project needs hosted live/render surfaces. The URL must be public and stable; the CLI refuses
localhost for a real deploy.

A resolver may be managed by a configured remote provider or run by the creator. That choice does
not change the token contract. Read [hosting.md](hosting.md) before promising who operates the
service, how effects are rendered, or how migration works.

### Local filesystem

Use `fs` only for local preview and disposable testnet iteration. A token whose public metadata
depends on a laptop path is not launched. Move the bytes or run a public resolver before presenting
the collection as complete.

## Understand on-chain reach

There is no fixed supported byte ceiling for `--onchain-image`. Writes are chunked; cost grows with
the stored bytes. Resolution rebuilds the document in one `eth_call`; success depends on the read-gas
allowance of the endpoint making that call.

The CLI estimates write cost, estimates read cost, probes the active endpoint, and reports whether the
document fits that endpoint's measured allowance. Preserve these distinctions:

- A successful write proves storage, not universal display reach.
- A successful read through the creator's RPC says nothing certain about a marketplace's RPC.
- Compression can reduce write cost without reducing the gas needed to reconstruct uncompressed
  output.
- The limit is per token, not the aggregate size of the collection.
- If direct self-resolution has insufficient reach, the bytes remain on-chain; a resolver can read
  them through a capable endpoint and serve ordinary HTTP after `set-renderer --off`.

Never call a size impossible merely because it is expensive or endpoint-dependent. State the dry
run's cost and reach, offer external permanent custody or resolver-fronted access as alternatives,
and let the creator decide.

## Prepare identity and economics

Propose and confirm a real name and symbol. The CLI may infer placeholders for a dry run but refuses
to silently bake a generic identity on a real send unless the user explicitly accepts it. A folder
named `images` is not a collection title.

Confirm these fields as applicable:

- description and external URL;
- creator, display notes, creator links, and license;
- initial royalty and royalty receiver;
- royalty cap, which is a permanent ceiling that may only decrease;
- burnability, fixed at deploy;
- ERC-721C/ERC-1155C enrollment, fixed at deploy;
- owner/deployer and primary-sale payee;
- whether metadata fields begin on-chain or in the resolver projection.

The owner may change ordinary royalties within the cap. Lowering the cap is irreversible. Do not
equate declared royalties with enforced creator fees; transfer-validator enrollment is a separate
creator-token decision described in [creator-token.md](creator-token.md).

### Mint timing

Choose among minting during deployment, pre-warming with no mint, or preminting part of a Series.
Pre-warming is valuable when a resolver or render pipeline must be ready before marketplaces observe
the first token. For hosted paths, register/index and verify the predicted or deployed contract before
minting; then mint and refresh.

The shared fixed-price minter is normally configured after deployment: set price/allocation, set the
minter/payee, and unpause when ready. Deploy-time minter flags pre-authorize a known stack; they are not
a substitute for confirming the actual sale configuration.

## Plan editions correctly

`--copies` changes both the token standard and the ownership model.

- `deploy --copies 100` means one id with a cap of 100 copies.
- `deploy-series --copies 100` means every folder item is its own id with up to 100 copies.
- `open` means an uncapped edition at deployment; later cap operations only lower numeric caps.
- `--mint-amount` is copies per preminted id; `--mint-count`/`--mint-all` select which ids premint.
- Transfers require an amount and explicit source because an id can have many holders.

For any edition, say “N ids × M copies per id” and the maximum aggregate supply before spending.

Static edition custody is symmetric with the 721 lanes: on-chain bytes, on-chain JSON with external
media, inline SVG, and hosted resolution are available. `--onchain-image` uses hot or wallet signing,
not cold unsigned staging.

Do not import code-edition limits into static editions or vice versa. Use the capability output.

## Plan, execute, and verify

1. Run `abx doctor`, storage/remote checks needed by the selected path, and command help.
2. Run the exact command with `--dry-run --json` and a known `--for` address when needed.
3. Read back contract family, id/copy arithmetic, custody, resolution, public URLs, signer lane,
   initial mint, transaction count, cost/reach warnings, and irreversible options. The JSON payload's
   `plan` object (every `deploy`/`deploy-series`/`deploy-code` emit, including `--resume`) carries
   most of this pre-structured — `transactions`, `roles`, `royalty`, `custody`, `mint`, `estimate`,
   `warnings`, and (code lanes) `surfaces`/`dependencies` — versioned via `plan.schemaVersion`. Prefer
   it over parsing the human prose for anything it covers; a field it has no answer for is `null`, not
   absent.
4. Receive explicit confirmation.
5. Run the same normalized command without `--dry-run`; do not start another write using the EOA.
6. Capture the chain, contract address, deploy block, owner, storage locators, and resolver/remote.
7. Verify `state`, `contracturi`, `tokenuri`, public image retrieval, and byte integrity.
8. If pre-warmed, register/serve first, mint second, verify the token-specific surfaces, then refresh.
9. Apply locks only after production-path verification.

For Arweave or other eventually available storage, an accepted upload is not yet a retrievable asset.
Use `abx storage status <locator> --json` and wait for `ready`; do not upload again simply because a
gateway is still propagating.
