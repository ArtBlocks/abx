/**
 * @artblocks/abx-storage — Layer 3 reference byte custody.
 *
 * Holds the source-of-truth bytes a token's on-chain content commitment points
 * at, content-addressed by that hash, behind a pluggable backend. The reference
 * backend is local disk; cloud / content-addressed backends slot in behind the
 * same interface.
 */
export type {StorageBackend, StoredContent} from './backend.js';
export {hashContent, contentTypeFromPath} from './backend.js';
export {LocalFsBackend} from './fs.js';
export {
  CloudStorageBackend,
  cloudConfigFromEnv,
  deriveSigningKey,
  sigv4Signature,
  type CloudStorageConfig,
  type SigV4Input,
} from './cloud.js';
export {ContentIndex, type IndexEntry} from './content-index.js';
export {IpfsBackend, ipfsConfigFromEnv, type IpfsConfig} from './ipfs.js';
export {
  ArweaveBackend,
  HttpBundlerUploader,
  arweaveConfigFromEnv,
  resolveArweaveJwk,
  arweaveKeyFilePath,
  arweaveFunding,
  arweaveProvider,
  turboIdentity,
  resolveTurboIdentity,
  turboIdentityAddress,
  isEthIdentity,
  ARWEAVE_FREE_UPLOAD_LIMIT,
  turboUploadCostUsd,
  turboUploadWinc,
  turboBalanceForAddress,
  type ArweaveConfig,
  type ArweaveProvider,
  type ArweaveUploader,
  type ArweaveFunding,
  type TurboIdentity,
} from './arweave.js';
export {generateArweaveJwk, arweaveAddress, type ArweaveJwk} from './arweave-identity.js';
export {resolveBackend, type ResolveStorageOptions} from './resolve.js';
export {repinNodeCustody, type RepinResult} from './migrate.js';
export {uploadAndLocate, type UploadResult} from './upload.js';
export {
  DIRECT_URL_BACKENDS,
  decideImageContentLane,
  validateRenderStorageCombo,
  type ImageContentLane,
  type ImageContentDecision,
  type RenderStorageCombo,
  type RenderStorageResult,
} from './content-plan.js';
export {
  isTurboArweave,
  planTurboUpload,
  assessStorageReadiness,
  assessTurboFunds,
  type TurboUploadPlan,
  type StorageReadinessReport,
  type TurboFundsCheck,
} from './upload-readiness.js';
export {
  locatorStatus,
  awaitLocatorReady,
  parseLocator,
  probeGateway,
  gatewayUrlFor,
  resolveGatewayBase,
  type LocatorStatus,
  type LocatorStatusOptions,
  type LocatorNetwork,
  type GatewayProbe,
  type Readiness,
  type AwaitLocatorReadyOptions,
  type AwaitLocatorReadyEvent,
  type AwaitLocatorReadyResult,
} from './readiness.js';
export {
  probeStorageBackend,
  checkCloudBackend,
  checkArweaveBackend,
  checkViaHealth,
  type StorageCheckResult,
  type StorageCheckOptions,
} from './probe.js';
