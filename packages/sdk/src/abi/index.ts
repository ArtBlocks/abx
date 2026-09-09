// The ABI surface the SDK speaks. Generated artifacts come from the contracts
// package (Layer 1) via `pnpm sync-abis`; never hand-edit `generated.ts`.
export {
  oneOfOneImageFactoryAbi,
  oneOfOneImageFactoryBytecode,
  oneOfOneImageAbi,
  oneOfOneImageBytecode,
  seriesImageFactoryAbi,
  seriesImageFactoryBytecode,
  seriesImageAbi,
  seriesImageBytecode,
  seriesCodeFactoryAbi,
  seriesCodeFactoryBytecode,
  seriesCodeAbi,
  seriesCodeBytecode,
  // ERC-1155 editions — the twin token+factory set (see contracts/src/tokens/Edition*.sol).
  oneOfOneEditionFactoryAbi,
  oneOfOneEditionFactoryBytecode,
  oneOfOneEditionAbi,
  oneOfOneEditionBytecode,
  editionImageFactoryAbi,
  editionImageFactoryBytecode,
  editionImageAbi,
  editionImageBytecode,
  editionCodeFactoryAbi,
  editionCodeFactoryBytecode,
  editionCodeAbi,
  editionCodeBytecode,
  abxEditionLibAbi,
  abxEditionLibBytecode,
  abxMetadataLibAbi,
  abxMetadataLibBytecode,
  abxFixedPriceMinter1155Abi,
  abxFixedPriceMinter1155Bytecode,
  abxSeedSourceAbi,
  abxSeedSourceBytecode,
  abxParamsLibAbi,
  abxParamsLibBytecode,
  abxCodeLibAbi,
  abxCodeLibBytecode,
  abxMetadataRendererAbi,
  abxMetadataRendererBytecode,
  abxChunkStoreAbi,
  abxChunkStoreBytecode,
  abxFixedPriceMinterAbi,
  abxFixedPriceMinterBytecode,
} from './generated.js';

import {
  oneOfOneImageAbi,
  oneOfOneImageFactoryAbi,
  seriesImageAbi,
  seriesImageFactoryAbi,
  seriesCodeAbi,
  seriesCodeFactoryAbi,
  oneOfOneEditionAbi,
  oneOfOneEditionFactoryAbi,
  editionImageAbi,
  editionImageFactoryAbi,
  editionCodeAbi,
  editionCodeFactoryAbi,
  abxFixedPriceMinterAbi,
  abxFixedPriceMinter1155Abi,
  abxParamsLibAbi,
} from './generated.js';

/** A stable signature key for an ABI event fragment (name + input types), for de-duping. */
function eventKey(f: {type: string; name?: string; inputs?: ReadonlyArray<{type: string}>}): string {
  return `${f.name ?? ''}(${(f.inputs ?? []).map((i) => i.type).join(',')})`;
}

/**
 * The event-spine ABI: every event any ABX token type + its factory can emit — the set
 * the reference indexer decodes. Every concrete token (721: 1/1, Series, SeriesCode; 1155:
 * OneOfOneEdition, EditionImage, EditionCode) declares the full spine it participates in
 * (Register 1 standards + Register 2 native events); we union them plus the factories'
 * `Deployed` and both fixed-price minters' sibling Minter-spine events (`SaleConfigured`/
 * `Purchase`), de-duping shared fragments (e.g. `Transfer`, `ApprovalForAll`) so a single ABI
 * decodes any ABX contract's logs unambiguously. `eventKey` dedups by name **and** input
 * types, so same-named-but-different-shaped events (the 721 vs. 1155 minters' `SaleConfigured`/
 * `Purchase`, which differ by an `id`/`amount`) survive as distinct fragments — `parseEventLogs`
 * disambiguates them by topic0 (the full canonical signature hash) at decode time, same as it
 * already does for every other event here. `AbxEditionLib` (the EIP-170 relief-valve library all
 * three 1155 token types delegatecall) is deliberately excluded — its event mirrors are
 * byte-identical to the ones `oneOfOneEditionAbi`/`editionImageAbi`/`editionCodeAbi` already carry
 * via inheritance (Uri1155/CreatorToken1155/EditionSupply), so including it would only add pure
 * duplicates (`abxCodeLibAbi` is excluded for the same reason).
 *
 * **`abxParamsLibAbi` is unioned in**, unlike the other two libraries, because one of its events is
 * NOT a duplicate: `ParamHooksFrozen()` is declared only there — the token's `IAbxConfigurableParams`
 * interface declares `HooksConfigured` but not the freeze — so without this the one-way lock on the
 * param hooks would be invisible to every consumer that folds the spine, while the hook it freezes
 * can veto a transfer. `eventKey`'s dedup makes the rest of the library's mirrors free, so this
 * costs nothing beyond the fragment that was missing. (The durable fix is for the interface to
 * declare the event; unioning here keeps reconstruction honest either way.)
 */
export const spineEventAbi = (() => {
  const all = [
    ...oneOfOneImageAbi,
    ...seriesImageAbi,
    ...seriesCodeAbi,
    ...oneOfOneImageFactoryAbi,
    ...seriesImageFactoryAbi,
    ...seriesCodeFactoryAbi,
    ...abxFixedPriceMinterAbi,
    ...oneOfOneEditionAbi,
    ...editionImageAbi,
    ...editionCodeAbi,
    ...oneOfOneEditionFactoryAbi,
    ...editionImageFactoryAbi,
    ...editionCodeFactoryAbi,
    ...abxFixedPriceMinter1155Abi,
    ...abxParamsLibAbi, // for ParamHooksFrozen — see the note above; the rest dedup away
  ].filter((f: {type: string}) => f.type === 'event');
  const seen = new Set<string>();
  const out: typeof all = [];
  for (const f of all) {
    const key = eventKey(f as never);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
})();
