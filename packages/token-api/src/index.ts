/**
 * @artblocks/abx-token-api — Layer 3 reference token API + byte-custody server.
 *
 * Serves standard token metadata (ERC-721 tokenURI / ERC-1155 editions' uri), ERC-7572
 * collection metadata, the token image, a JSON state API, and a demo dashboard — all from
 * the reconstructed projection. The on-chain URIs point here, so this node is the resolver;
 * switching nodes is a repoint.
 */
export {
  createTokenApiServer,
  startTokenApiServer,
  resolveBaseUrl,
  resolveContent,
  verifyProject,
  DEFAULT_PORT,
  type ServerOptions,
} from './server.js';
export {
  buildTokenMetadata,
  buildContractMetadata,
  tokenArtifacts,
  tokenImageUrl,
  type DisplayMeta,
  type FieldProvenance,
  type ArtifactEntry,
  type EffectArtifactStatus,
  type TokenArtifactsResult,
  type PlaneAccess,
  type PlaneArtifactRow,
} from './metadata.js';
export {currentRenderArtifact, liveViewEnabled} from './code.js';
// The generator-document family (the runtime companion, the inline-safety escapes, and the
// document-shape builders) lives in `@artblocks/abx-sdk`. It is a pure string-ops surface with no
// resolver-specific behavior; the SDK, the CLI's
// `abx preview`, and any third-party provider all consume the same one. Re-exported here
// unchanged: this package's public API is unaffected by where the implementation lives.
export {ABX_JS, buildGeneratorDocument, escapeInlineJson, escapeInlineScript, injectTokenDataIntoHtml} from '@artblocks/abx-sdk';
export {
  depStatusReport,
  dependencyScriptTags,
  resolveRegistryDep,
  registryDepUrl,
  activeRegistry,
  urlBudgetStatus,
  URL_BUDGET_BYTES,
  DEPENDENCY_REGISTRY_ABI,
  type DepStatus,
  type DirectoryServeMode,
  type RegistryResolution,
  type ResolvedVia,
} from './deps.js';
export {startChainWatcher, notifyEffects, watchIntervalMs, DEFAULT_WATCH_INTERVAL_MS, type WatcherOptions, type WatcherStatus} from './watcher.js';
export {generateContent, contentHash, fallbackImageSvg, IMAGE_MEDIA_TYPE} from './content.js';
export {renderDashboard} from './dashboard.js';
