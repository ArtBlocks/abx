/**
 * The declared media type of STORED image bytes — the `abx_image_type` rule every serving plane
 * applies identically (`AbxMetadataRenderer` spec v12, the reference resolver, any conforming host).
 *
 * An `image` field holding the bytes themselves (`inline`, `reader`, and the off-chain-decoded
 * `*-gzip` variants) carries no type of its own. Through spec v11 every plane labelled those bytes
 * `image/svg+xml`, which was right for inline SVG and wrong for the JPEG/PNG/GIF/WebP files the CLI
 * staged behind a `reader`: browsers refuse to draw a raster served as SVG. The type is therefore
 * DECLARED in a reserved field, never sniffed from the bytes.
 *
 * Token scope first, else collection scope — the same fallback the `image` field takes, so a Series
 * of JPEGs declares it once. Only `inline` counts, and only a well-formed `image/*` value: the type
 * lands inside a `data:` URI on chain, where `,` would end the mediatype and `;` would start a
 * parameter. Anything else resolves to the SVG default, so an unset field serves exactly what v11 did.
 */
import {METADATA_FIELD as F, METADATA_REPRESENTATION as R} from './spine.js';
import {inlineText} from './token.js';
import type {MetadataField} from './types.js';

/** What stored image bytes are served as when no valid `abx_image_type` is declared. */
export const DEFAULT_STORED_IMAGE_TYPE = 'image/svg+xml';

/** Byte-identical to `AbxMetadataRenderer._isImageType`: `image/` + 1–58 of `[a-z0-9.+-]`, first a
 *  letter or digit. Lowercase only — the contract does not fold case, so neither may a resolver. */
const DECLARABLE_IMAGE_TYPE = /^image\/[a-z0-9][a-z0-9.+-]{0,57}$/;

/** Can `type` be declared in `abx_image_type`? (Exactly the values the renderer honors.) */
export function isDeclarableImageType(type: string): boolean {
  return DECLARABLE_IMAGE_TYPE.test(type);
}

/**
 * The media type a plane serves a token's stored image bytes with: the token's `abx_image_type`,
 * else the collection's, when `inline` and declarable; else {@link DEFAULT_STORED_IMAGE_TYPE}.
 *
 * The scope walk matches the renderer's `_field`: a token-scope value — even an invalid one — is what
 * gets checked, and only an ABSENT token value falls back to collection scope.
 */
export function storedImageType(
  tokenFields: readonly MetadataField[] | undefined,
  collectionFields: readonly MetadataField[] | undefined,
): string {
  const entry =
    tokenFields?.find((f) => f.field === F.imageType) ?? collectionFields?.find((f) => f.field === F.imageType);
  if (!entry || entry.representation !== R.inline) return DEFAULT_STORED_IMAGE_TYPE;
  const declared = inlineText(entry);
  return isDeclarableImageType(declared) ? declared : DEFAULT_STORED_IMAGE_TYPE;
}
