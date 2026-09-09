import {gunzipSync} from 'node:zlib';
import {decodeAbiParameters, hexToBytes, type Hex} from 'viem';
import {
  decodeReader,
  encodeTag,
  METADATA_REPRESENTATION as R,
  type MetadataField,
  type PublicClient,
} from '@artblocks/abx-sdk';

/**
 * The off-chain twin of the on-chain resolution path: turn a field's `(representation,
 * value)` into its actual content bytes, applying whatever decode the representation
 * implies. This is the one place the four on-chain-content flavors are handled, so the
 * image route and the JSON text fields resolve identically:
 *
 *  - `inline`        → the value bytes
 *  - `inline-gzip`   → gunzip(value)                    (on-chain can't gunzip; we do it here)
 *  - `reader`        → chunkStore.read(manifest)        (multi-chunk + per-chunk FastLZ, decoded on-chain)
 *  - `reader-gzip`   → gunzip(reader.read(manifest))    (chunks hold gzip(content); inflate here)
 *
 * Returns null for representations that aren't byte content here (`keccak256`/`sha256` →
 * custody by hash; `url`/`ipfs`/`arweave` → locators), so callers fall through to those paths.
 */

/** The on-chain reader interface — `read(pointer) → bytes` returns finished, on-chain-decoded content. */
export const READER_ABI = [
  {
    type: 'function',
    name: 'read',
    stateMutability: 'view',
    inputs: [{name: 'pointer', type: 'address'}],
    outputs: [{type: 'bytes'}],
  },
] as const;

const gunzip = (b: Uint8Array): Uint8Array => new Uint8Array(gunzipSync(Buffer.from(b)));

/** Resolve a field to its content bytes (decoding inline/gzip/reader), or null if not byte content here. */
export async function resolveFieldBytes(
  client: PublicClient,
  field: MetadataField | null,
): Promise<Uint8Array | null> {
  if (!field) return null;
  switch (field.representation) {
    case R.inline:
      return hexToBytes(field.value);
    case R.inlineGzip:
      return gunzip(hexToBytes(field.value));
    case R.reader:
    case R.readerGzip: {
      const {reader, pointer} = decodeReader(field.value);
      const out = (await client.readContract({
        address: reader,
        abi: READER_ABI,
        functionName: 'read',
        args: [pointer],
      })) as Hex;
      const bytes = hexToBytes(out);
      return field.representation === R.readerGzip ? gunzip(bytes) : bytes;
    }
    default:
      return null; // keccak256 / sha256 (custody) · url / ipfs / arweave (locator)
  }
}

/** True if the representation carries its content on-chain (inline or reader, gzip'd or not). */
export function isOnChainContent(representation: string): boolean {
  return (
    representation === R.inline ||
    representation === R.inlineGzip ||
    representation === R.reader ||
    representation === R.readerGzip
  );
}

/** `IAbxFieldRenderer.render(token, tokenId, field) → (contentType, data)` — the `renderer`
 *  representation's compute-at-read call, the off-chain twin of the on-chain metadata renderer's
 *  staticcall. */
export const FIELD_RENDERER_ABI = [
  {
    type: 'function',
    name: 'render',
    stateMutability: 'view',
    inputs: [
      {name: 'token', type: 'address'},
      {name: 'tokenId', type: 'uint256'},
      {name: 'field', type: 'bytes32'},
    ],
    outputs: [
      {name: 'contentType', type: 'string'},
      {name: 'data', type: 'bytes'},
    ],
  },
] as const;

/** Collection-surface reads (no token, e.g. contractURI) pass this sentinel to a field renderer
 *  (`type(uint256).max` — mirrors the on-chain renderer's COLLECTION_TOKEN_ID). */
export const COLLECTION_TOKEN_ID = (2n ** 256n - 1n).toString();

/**
 * Dispatch a `renderer`-represented field: eth_call the field renderer for its computed
 * `(contentType, bytes)` — the one representation whose type is declared on-chain at the source
 * (`onchain-metadata.md → Resolution`). Returns null for any other representation. A returned
 * contentType of `text/uri-list` means the bytes ARE a locator (landed verbatim, never wrapped)
 * — callers redirect rather than serve.
 */
export async function resolveFieldRendered(
  client: PublicClient,
  tokenAddress: string,
  tokenId: string,
  fieldName: string,
  field: MetadataField | null,
): Promise<{contentType: string; bytes: Uint8Array} | null> {
  if (!field || field.representation !== R.renderer) return null;
  const [renderer] = decodeAbiParameters([{type: 'address'}], field.value);
  const [contentType, data] = (await client.readContract({
    address: renderer,
    abi: FIELD_RENDERER_ABI,
    functionName: 'render',
    args: [tokenAddress as `0x${string}`, BigInt(tokenId), encodeTag(fieldName)],
  })) as [string, Hex];
  return {contentType, bytes: hexToBytes(data)};
}
