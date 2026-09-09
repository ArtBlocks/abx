import {
  keccak256,
  sha256,
  hexToString,
  hexToBytes,
  decodeAbiParameters,
  type Address,
  type Hex,
} from 'viem';
import {METADATA_REPRESENTATION as R} from './spine.js';
import type {MetadataField, ProjectState, TokenState} from './types.js';

/** The token in a reconstructed project, or null. */
export function findToken(state: ProjectState, tokenId: string | number): TokenState | null {
  const id = String(tokenId);
  return state.tokens.find((t) => t.tokenId === id) ?? null;
}

/** A field's single active on-chain entry (`{field, representation, value}`), or null if unset. */
export function fieldOf(fields: MetadataField[], fieldName: string): MetadataField | null {
  return fields.find((f) => f.field === fieldName) ?? null;
}

export function isOnChain(representation: string): boolean {
  return representation === R.inline || representation === R.reader;
}

// ── value decoding by representation ─────────────────────────────────────────

/** Decode an `inline` field value as UTF-8 text. */
export function inlineText(field: MetadataField): string {
  try {
    return hexToString(field.value);
  } catch {
    return '';
  }
}

/** Decode an `inline` field value as raw bytes. */
export function inlineBytes(field: MetadataField): Uint8Array {
  return hexToBytes(field.value);
}

/** Verify bytes against a field carried as a `keccak256`/`sha256` hash; null if not a hash representation. */
export function verifyAgainstHash(bytes: Uint8Array | string, field: MetadataField): boolean | null {
  const input = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  if (field.representation === R.keccak256) return keccak256(input) === field.value;
  if (field.representation === R.sha256) return sha256(input) === field.value;
  return null;
}

/**
 * Decode a `reader` field value → `(reader, pointer)` addresses. Content is then
 * obtained on-chain by `IAbxOnChainReader(reader).read(pointer)` (an `eth_call`). The
 * reader encapsulates storage + on-chain decoding; this just unpacks the two addresses.
 *
 * Requires the CANONICAL `abi.encode(address reader, address pointer)` shape: exactly two
 * 32-byte words, each zero-padded in its leading 12 bytes. `decodeAbiParameters` alone is
 * too permissive to use as the only gate here — it happily reads an `address` out of a word
 * with non-zero padding, and it ignores any bytes beyond the words a type list needs, so a
 * truncated-then-repadded, trailing-garbage, or double-encoded (e.g. `abi.encode(bytes)`
 * wrapping a reader pair) value can decode into a plausible but wrong address pair instead
 * of failing. Because the decoded `reader` address is then `eth_call`'d directly (see
 * `resolveFieldBytes` in token-api), a silent mis-decode here is a wrong-contract call, not
 * a cosmetic bug — so this checks shape and padding itself before trusting the ABI decode.
 */
export function decodeReader(value: Hex): {reader: Address; pointer: Address} {
  const hex = value.slice(2);
  const WORD_HEX_LEN = 64; // one 32-byte ABI word, as hex chars
  const EXPECTED_HEX_LEN = WORD_HEX_LEN * 2; // exactly two words: (address reader, address pointer)
  if (hex.length !== EXPECTED_HEX_LEN) {
    throw new Error(
      `decodeReader: expected exactly two 32-byte ABI words (abi.encode(address reader, address ` +
        `pointer) — ${EXPECTED_HEX_LEN / 2} bytes), received ${hex.length / 2} bytes (${value}). This ` +
        `looks like a truncated, trailing-byte, or double-encoded value; only output from ` +
        `encodeReader() is accepted.`,
    );
  }
  const ZERO_PAD = '0'.repeat(24); // the 12 zero bytes a canonical address word pads with
  const words: Array<['reader' | 'pointer', string]> = [
    ['reader', hex.slice(0, WORD_HEX_LEN)],
    ['pointer', hex.slice(WORD_HEX_LEN, WORD_HEX_LEN * 2)],
  ];
  for (const [name, word] of words) {
    if (!word.startsWith(ZERO_PAD)) {
      throw new Error(
        `decodeReader: ${name} word is not canonically zero-padded — expected its leading 12 bytes ` +
          `to be zero, received 0x${word}. A non-zero-padded address word is not produced by ` +
          `encodeReader() and is rejected as a non-canonical encoding.`,
      );
    }
  }
  const [reader, pointer] = decodeAbiParameters([{type: 'address'}, {type: 'address'}], value) as [Address, Address];
  return {reader, pointer};
}

/** Encode a `reader` field value from `(reader, pointer)` — the write-side counterpart. */
export function encodeReader(reader: Address, pointer: Address): Hex {
  // abi.encode(address, address)
  const strip = (a: Address) => a.slice(2).toLowerCase().padStart(64, '0');
  return (`0x${strip(reader)}${strip(pointer)}`) as Hex;
}

/**
 * Encode a `renderer` field value — `abi.encode(address fieldRenderer)` (the representations
 * table, site/content/docs/protocol/metadata.mdx). Content is COMPUTED at read: the metadata
 * renderer (and the off-chain resolver) staticcall `render(token, tokenId, field)` on it.
 */
export function encodeFieldRenderer(fieldRenderer: Address): Hex {
  return (`0x${fieldRenderer.slice(2).toLowerCase().padStart(64, '0')}`) as Hex;
}

/** Decode a `renderer` field value back to the field-renderer address (the read-side twin). */
export function decodeFieldRenderer(value: Hex): Address {
  const [renderer] = decodeAbiParameters([{type: 'address'}], value) as [Address];
  return renderer;
}
