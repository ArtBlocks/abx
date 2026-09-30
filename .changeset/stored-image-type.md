---
'@artblocks/abx-sdk': minor
'@artblocks/abx-cli': minor
'@artblocks/abx-token-api': minor
---

Drop-in for read-only consumers. Hosts that serve stored images should adopt `storedImageType`.

On-chain raster images now display correctly. Stored `image` bytes are labelled with the new reserved
`abx_image_type` field, and fall back to `image/svg+xml` when it is unset. Before this change, a JPEG
or PNG staged with `--onchain-image` was served as SVG, which browsers show as a broken image.

- SDK: `METADATA_FIELD.imageType`, `storedImageType`, `isDeclarableImageType`, and
  `DEFAULT_STORED_IMAGE_TYPE`. `isCurrentRenderer` now requires renderer spec v12, and the
  canonical renderer address points at the v12 build.
- CLI: `deploy --onchain-image`, `deploy-series --onchain-image`, and `set-field --field image --file`
  declare a raster's type from its file extension. They refuse formats browsers don't draw, such as
  TIFF, PSD, video, and files without an extension, before anything is staged.
- Token API: the image route, the `/data/image` route, and the `artifacts` manifest serve the
  declared type.
