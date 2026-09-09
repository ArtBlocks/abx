# ABX Solidity extension workspace

A ready-to-build Foundry project for ABX's actual Solidity extension surfaces. Each role remains a
separate deployable contract: image/traits rendering, configure-time validation, transfer lifecycle,
and read-time augmentation. Use only the roles your project needs. There is intentionally no
"minter hook": minting is an external-minter capability, while the three PostParam hooks are
configure, transfer and augment.

`abx` does **not** compile or deploy Solidity for you; you build, test, and deploy this project with
Foundry, then hand the deployed address(es) to `abx deploy-code`, which verifies they have code.

## What's here

- `src/MyRenderer.sol` — the **image** renderer: seed → geometry, a `palette` HexColor PostParam →
  tint. **Fork the geometry/palette math for your own work.**
- `src/MyTraits.sol` — the **attributes** renderer: reads the *same* seed math so traits agree with
  the image by construction.
- `src/MyHooks.sol` — small wrappers around one reference implementation for each PostParam hook
  role. Fork a role independently; do not merge their authority just because they share a workspace.
- `abx-contracts~2.0.0` — the exact-pinned canonical interfaces, 721/1155 fixed-price minters,
  reference hooks, token implementations and real-clone test harness. The scaffold carries no
  hand-copied ABX interface.
- `test/MyRenderer.t.sol` — proves `render()` never reverts (incl. no-seed, no-palette, the
  collection surface, and a fuzz over every seed/tokenId) and that image ↔ traits stay coherent.
- `script/Deploy.s.sol` deploys renderers; `script/DeployHooks.s.sol` deploys the three hook examples
  after a token address exists.
- `script/Preview.s.sol` — a **local preview**, not a test: runs `render()` with representative
  inputs and writes the actual output to `preview-out/` so you can look at it (open the `.svg` in a
  browser). `forge test` proves render() behaves; this script is the only way to see what it drew.

## Build, test, deploy

```bash
forge soldeer install          # fetch solady + forge-std (pinned in foundry.toml)
forge build
forge test                     # MUST pass — especially the never-revert cases

# look at what the renderer actually produces (writes preview-out/image.svg + attributes.json):
forge script script/Preview.s.sol
# override the representative token id / seed / palette without editing the script:
PREVIEW_TOKEN_ID=42 PREVIEW_SEED=0x00...abc PREVIEW_PALETTE=0x00...ff3366 forge script script/Preview.s.sol

# deploy to your testnet, then copy the printed addresses:
forge script script/Deploy.s.sol --rpc-url <your-rpc-url> --private-key <key> --broadcast

# optional PostParam hooks, deployed separately after the token exists:
forge script script/DeployHooks.s.sol --sig "run(address,uint256)" <token> 1024 \
  --rpc-url <your-rpc-url> --private-key <key> --broadcast
```

`script/Preview.s.sol`'s gas numbers are a local-EVM sanity check, not a production gas measurement —
see the disclaimer in that file. For real gas numbers, deploy (above) and read `tokenURI` on the
actual chain you're targeting.

## Wire it into a drop

```bash
abx deploy-code \
  --image-renderer <MyRenderer address> \
  --attributes-renderer <MyTraits address> \
  --onchain-uri \
  --schema palette:HexColor:TokenOwner \
  --name "Your Collection" --symbol SYM [--max N] --sign --for <your wallet>
```

Then, only if using the hook examples:

```bash
abx set-param-hooks <token> --configure <configure> --augment <augment> --transfer <transfer>
```

The transfer hook is a veto surface and also runs on mint. The reference counts only real
non-zero-to-non-zero moves and pins `msg.sender` to the token. On ERC-1155 it counts copies moved per
id; it never pretends a multi-copy id has one current owner. Freeze the selected hook addresses with
`abx lock-param-hooks` when the project is ready to make that authority immutable.

- `--onchain-uri` (no `--script`/`--code-dir`) is the in-chain lane — a small Solidity SVG is a
  great fit for an on-chain `tokenURI` (unlike a 200KB JS bundle).
- `--schema palette:HexColor:TokenOwner` declares the collector param your renderer reads. **Omit it
  and the palette is fixed at the default** — collectors can't set it. After launch, a collector
  runs `abx configure-param <addr> <id> palette #ff3366` and the on-chain image re-tints instantly
  (the renderer reads the live param — nothing to re-render).
- Verify from chain with `abx tokenuri <addr>` — no server involved.

## The renderer contract, in one breath

Implement `render(address token, uint256 tokenId, bytes32 field) view → (string contentType, bytes data)`:
read live state via `IAbxParams(token).tokenParam(...)` / `.contractParam(...)`, compute the field's
bytes, return them with the right MIME. Never revert. Keep the output small. `forge test` before you wire.
