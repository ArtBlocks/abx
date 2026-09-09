/**
 * @artblocks/abx-indexer — Layer 3 reference indexer.
 *
 * Replays the event spine from chain into a disposable, rebuildable projection.
 * The canonical re-index: how every service onboards or exits a project.
 */
export {
  SelfHostIndexer,
  DEFAULT_INCREMENTAL_VACUUM_PAGES,
  DEFAULT_VACUUM_INTERVAL_MS,
  type IndexResult,
  type ReindexOptions,
} from './indexer.js';
export {
  SqliteStore,
  type Store,
  type ProjectRegistration,
  type EffectStatusRow,
  type EffectArtifactRow,
} from './store.js';
