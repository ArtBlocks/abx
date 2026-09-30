# @artblocks/abx-token-api

## 0.2.0

### Minor Changes

- 7947ba9: Drop-in for read-only consumers. Hosts that serve stored images should adopt `storedImageType`.

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

### Patch Changes

- Updated dependencies [7947ba9]
  - @artblocks/abx-sdk@0.2.0
  - @artblocks/abx-indexer@0.1.1
  - @artblocks/abx-storage@0.1.1

## 0.1.0

### Minor Changes

- 21e3d6c: Drop-in for existing v2 integrations; new deployments use the canonical v3 contracts.
  Record the synchronized v3 factory generation and testnet deployments, retain full v2 service
  compatibility (including already-assigned v2 sale minters), and update the renderer scaffold to
  `abx-contracts` 3.0.0.
- 9065128: Drop-in for existing clients; service consumers can now inspect verified contract-generation facts.
  Advertise understood generations and include a project generation in summaries and status responses
  only when factory provenance and the on-chain core version agree.

### Patch Changes

- 4d5e2b1: Return minimal metadata for unminted token positions and keep their image, data, and live-view URLs unavailable until mint.
- 8f35dae: Prepare package metadata, release notes, and public-facing source comments for the initial public
  source release.
- 719b9fe: Make the bundled skill read network and sponsorship support from CLI capabilities and the live
  service descriptor instead of a hardcoded network list. Refresh public documentation references in
  the published packages.
- Updated dependencies [21e3d6c]
- Updated dependencies [22abce8]
- Updated dependencies [4d5e2b1]
- Updated dependencies [56973c4]
- Updated dependencies [2290b0a]
- Updated dependencies [b9197bc]
- Updated dependencies [8ccbede]
- Updated dependencies [d925eb1]
- Updated dependencies [ea57f7a]
- Updated dependencies [3ddba71]
- Updated dependencies [8f35dae]
- Updated dependencies [719b9fe]
- Updated dependencies [9065128]
- Updated dependencies [c2400a7]
- Updated dependencies [3d7fe3c]
- Updated dependencies [7b462e2]
- Updated dependencies [ddb2e0b]
- Updated dependencies [4512962]
- Updated dependencies [76cfc6a]
- Updated dependencies [5522192]
  - @artblocks/abx-sdk@0.1.0
  - @artblocks/abx-indexer@0.1.0
  - @artblocks/abx-storage@0.1.0

## 0.1.0-alpha.52

### Patch Changes

- 719b9fe: Make the bundled skill read network and sponsorship support from CLI capabilities and the live
  service descriptor instead of a hardcoded network list. Refresh public documentation references in
  the published packages.
- Updated dependencies [719b9fe]
  - @artblocks/abx-indexer@0.1.0-alpha.50
  - @artblocks/abx-sdk@0.1.0-alpha.49
  - @artblocks/abx-storage@0.1.0-alpha.49

## 0.1.0-alpha.51

### Patch Changes

- 4d5e2b1: Return minimal metadata for unminted token positions and keep their image, data, and live-view URLs unavailable until mint.
- Updated dependencies [4d5e2b1]
  - @artblocks/abx-sdk@0.1.0-alpha.48
  - @artblocks/abx-indexer@0.1.0-alpha.49
  - @artblocks/abx-storage@0.1.0-alpha.48

## 0.1.0-alpha.50

### Patch Changes

- Updated dependencies [56973c4]
  - @artblocks/abx-sdk@0.1.0-alpha.47
  - @artblocks/abx-indexer@0.1.0-alpha.48
  - @artblocks/abx-storage@0.1.0-alpha.47

## 0.1.0-alpha.49

### Patch Changes

- Updated dependencies [ddb2e0b]
- Updated dependencies [76cfc6a]
  - @artblocks/abx-sdk@0.1.0-alpha.46
  - @artblocks/abx-indexer@0.1.0-alpha.47
  - @artblocks/abx-storage@0.1.0-alpha.46

## 0.1.0-alpha.48

### Patch Changes

- Updated dependencies [d925eb1]
  - @artblocks/abx-sdk@0.1.0-alpha.45
  - @artblocks/abx-indexer@0.1.0-alpha.46
  - @artblocks/abx-storage@0.1.0-alpha.45

## 0.1.0-alpha.47

### Patch Changes

- Updated dependencies [22abce8]
  - @artblocks/abx-sdk@0.1.0-alpha.44
  - @artblocks/abx-indexer@0.1.0-alpha.45
  - @artblocks/abx-storage@0.1.0-alpha.44

## 0.1.0-alpha.46

### Patch Changes

- Updated dependencies [2290b0a]
  - @artblocks/abx-sdk@0.1.0-alpha.43
  - @artblocks/abx-indexer@0.1.0-alpha.44
  - @artblocks/abx-storage@0.1.0-alpha.43

## 0.1.0-alpha.45

### Patch Changes

- Updated dependencies [ea57f7a]
  - @artblocks/abx-sdk@0.1.0-alpha.42
  - @artblocks/abx-indexer@0.1.0-alpha.43
  - @artblocks/abx-storage@0.1.0-alpha.42

## 0.1.0-alpha.44

### Patch Changes

- Updated dependencies [8ccbede]
  - @artblocks/abx-sdk@0.1.0-alpha.41
  - @artblocks/abx-indexer@0.1.0-alpha.42
  - @artblocks/abx-storage@0.1.0-alpha.41

## 0.1.0-alpha.43

### Patch Changes

- Updated dependencies [b9197bc]
  - @artblocks/abx-sdk@0.1.0-alpha.40
  - @artblocks/abx-indexer@0.1.0-alpha.41
  - @artblocks/abx-storage@0.1.0-alpha.40

## 0.1.0-alpha.42

### Patch Changes

- Updated dependencies [3d7fe3c]
- Updated dependencies [7b462e2]
  - @artblocks/abx-sdk@0.1.0-alpha.39
  - @artblocks/abx-indexer@0.1.0-alpha.40
  - @artblocks/abx-storage@0.1.0-alpha.39

## 0.1.0-alpha.41

### Patch Changes

- Updated dependencies [c2400a7]
  - @artblocks/abx-sdk@0.1.0-alpha.38
  - @artblocks/abx-indexer@0.1.0-alpha.39
  - @artblocks/abx-storage@0.1.0-alpha.38

## 0.1.0-alpha.40

### Patch Changes

- Updated dependencies [4512962]
  - @artblocks/abx-sdk@0.1.0-alpha.37
  - @artblocks/abx-indexer@0.1.0-alpha.38
  - @artblocks/abx-storage@0.1.0-alpha.37

## 0.1.0-alpha.39

### Patch Changes

- Updated dependencies [5522192]
  - @artblocks/abx-sdk@0.1.0-alpha.36
  - @artblocks/abx-indexer@0.1.0-alpha.37
  - @artblocks/abx-storage@0.1.0-alpha.36

## 0.1.0-alpha.38

### Minor Changes

- 21e3d6c: Drop-in for existing v2 integrations; new deployments use the v3 production-candidate contracts.
  Record the synchronized v3 factory generation and testnet deployments, retain full v2 service
  compatibility (including already-assigned v2 sale minters), and update the renderer scaffold to
  `abx-contracts` 3.0.0.

### Patch Changes

- Updated dependencies [21e3d6c]
- Updated dependencies [a73922c]
  - @artblocks/abx-sdk@0.1.0-alpha.35
  - @artblocks/abx-indexer@0.1.0-alpha.36
  - @artblocks/abx-storage@0.1.0-alpha.35

## 0.1.0-alpha.37

### Minor Changes

- 9065128: Drop-in for existing clients; service consumers can now inspect verified contract-generation facts.
  Advertise understood generations and include a project generation in summaries and status responses
  only when factory provenance and the on-chain core version agree.

### Patch Changes

- Updated dependencies [3ddba71]
- Updated dependencies [9065128]
  - @artblocks/abx-sdk@0.1.0-alpha.34
  - @artblocks/abx-storage@0.1.0-alpha.34
  - @artblocks/abx-indexer@0.1.0-alpha.35

## 0.1.0-alpha.36

### Patch Changes

- 9242a05: Prepare package metadata, release notes, and public-facing source comments for the initial public
  source release.
- Updated dependencies [9242a05]
  - @artblocks/abx-indexer@0.1.0-alpha.34
  - @artblocks/abx-sdk@0.1.0-alpha.33
  - @artblocks/abx-storage@0.1.0-alpha.33
