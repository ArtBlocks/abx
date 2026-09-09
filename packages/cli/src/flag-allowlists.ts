/**
 * Per-command flag allowlists — the one place that knows which flags each command accepts, so the
 * dispatcher can surface a typo'd or unsupported flag instead of silently ignoring it.
 *
 * WHY THIS FILE EXISTS, and why the obvious shortcut doesn't work
 * --------------------------------------------------------------
 * The CLI used to have three different behaviors for an unrecognized flag: `deploy*` REFUSED,
 * `preview`/`tokens`/`storage status`/`attach` WARNED, and ~35 other commands said nothing at all —
 * so `abx set-royalty --bsp 500` or `abx minter buy --quantiy 5` did something quietly different from
 * what was asked. That silence is the worst failure mode the CLI has, because the creator's next
 * action is to believe it worked.
 *
 * The tempting fix is to DERIVE each allowlist from the `usage` string every command already declares.
 * An audit of all ~45 commands says that would be actively harmful: several shared helpers read flags
 * that appear in NO usage string anywhere. `storageOverrides()` reads twelve
 * (`--backend`, `--gateway`, `--public-base`, `--storage-signer`, …) and is pulled in by `add`,
 * `render`, `effects`, `migrate`, `storage upload`, and `storage balance|topup`; `--remote-token` is
 * read by `index`, `verify`, `forget`, `status`, and `migrate`. A usage-derived allowlist would warn on
 * every one of those — a false warning on a VALID flag, which is worse than the silence it replaces,
 * because a notice people learn to distrust stops working for the real cases too.
 *
 * So the sets below are explicit, and composed from the shared groups by name. A command absent from
 * `COMMAND_FLAGS` is simply not checked — this can grow incrementally, and an unlisted command keeps
 * exactly its old behavior rather than acquiring a half-right allowlist.
 */

/**
 * Flags EVERY owner write accepts: the signing lane (`laneFromFlags`), the opt-in confirm gate, the
 * wallet-lane plumbing, the post-write reindex nudge (`reindexIfKnown` → `resolveRemote`), and
 * `--json`. Sourced from `riskgate.ts` + `ownerops.ts`, never from a usage string.
 */
export const SHARED_WRITE = [
  'send',
  'sign',
  'unsigned',
  'dry-run',
  'yes',
  'confirm',
  'port',
  'sign-url-file',
  'remote',
  'remote-token',
  'json',
] as const;

/**
 * What `storageOverrides()` (config.ts) reads. Any command that resolves a storage backend from flags
 * accepts all twelve — and none of them are documented per-command, which is exactly why a
 * usage-derived allowlist would have been wrong.
 */
export const STORAGE_OVERRIDE = [
  'backend',
  'endpoint',
  'bucket',
  'region',
  'prefix',
  'public-base',
  'gateway',
  'mode',
  'api-url',
  'upload-url',
  'provider',
  'storage-signer',
] as const;

/** `remoteFlag()` / `resolveRemote()` — a named service plus its token. */
export const REMOTE = ['remote', 'remote-token'] as const;

const set = (...groups: ReadonlyArray<readonly string[]>): ReadonlySet<string> => new Set(groups.flat());

/**
 * Command → accepted flags. Keys are the dispatch names in `main.ts`; a two-word command is keyed by
 * `"<cmd> <sub>"` (e.g. `"storage upload"`) and falls back to the bare command when no subcommand row
 * exists. `deploy`/`deploy-series`/`deploy-code` are deliberately ABSENT: they already enforce their
 * own exhaustive allowlists via `refuseStrayFlags`, and duplicating those sets here would be a second
 * copy to drift.
 */
export const COMMAND_FLAGS: Record<string, ReadonlySet<string>> = {
  // ── read-only ──
  inspect: set(['dep']),
  capabilities: set(['json']),
  predict: set(['salt', 'for', 'factory', 'copies', 'script', 'code-dir', 'image-renderer', 'dir', 'image']),
  tokenuri: set(['token', 'fetch', 'json']),
  contracturi: set([]),
  tokens: set(['json', 'limit', 'from', 'holder']),
  state: set(['json']),
  status: set(['watch'], REMOTE),
  verify: set(['json', 'yes', 'generator'], REMOTE),
  artifacts: set(['json', 'token'], REMOTE, STORAGE_OVERRIDE),
  doctor: set(['for', 'fix', 'global', 'agent']),
  serve: set(['port']),
  vacuum: set([]),
  'vacuum convert': set([]),
  'vacuum incremental': set(['pages']),
  'skill install': set(['target', 'global', 'agent']),
  'skill path': set(['target', 'global', 'agent']),

  // ── indexing / projection ──
  add: set(
    ['from-block', 'factory', 'label', 'description', 'external-url', 'full', 'yes', 'traits', 'attributes', 'no-wait', 'dry-run'],
    REMOTE,
    STORAGE_OVERRIDE,
  ),
  index: set(['full', 'no-wait', 'yes', 'to-block'], REMOTE),
  forget: set([], REMOTE),
  migrate: set(['from', 'to', 'from-block', 'factory', 'label', 'yes'], REMOTE, STORAGE_OVERRIDE),
  remote: set(['conformance', 'remote-token', 'chain-id', 'address', 'from-block']),
  'remote set': set(['url']),
  feedback: set([
    'remote',
    'remote-token',
    'mine',
    'area',
    'component',
    'kind',
    'summary',
    'detail',
    'detail-file',
    'severity',
    'via',
    'context',
    'context-file',
    'limit',
    'yes',
    'json',
  ]),
  'auth login': set(['remote', 'no-open', 'force']),
  'auth logout': set(['remote']),

  // ── rendering / effects ──
  render: set(['force', 'effects-url'], REMOTE, STORAGE_OVERRIDE),
  effects: set(['once', 'port', 'resolver-port', 'interval-ms', 'concurrency'], REMOTE, STORAGE_OVERRIDE),
  'mint-page': set(['dir', 'name', 'rpc', 'minter-contract']),
  'scaffold-renderer': set(['force']),
  'scaffold solidity': set(['force']),

  // ── hosting artifacts ──
  'deploy-resolver': set(['provider', 'domain', 'app', 'dir', 'from-source']),
  'deploy-effects': set(['provider', 'resolver-url', 'app', 'dir', 'interval-ms', 'env-id']),

  // ── storage ──
  // `show` honors the full override set now (it previews what a given set of flags WOULD resolve to);
  // before that it read env-only, and the warning correctly fired because the flags really were ignored.
  storage: set(['check'], STORAGE_OVERRIDE),
  'storage show': set(['check'], STORAGE_OVERRIDE),
  'storage upload': set(['key', 'json', 'dry-run'], STORAGE_OVERRIDE),
  // `status` documents --json and --primary-only in its own usage string; without a row here it fell
  // back to the bare `storage` row and warned "unrecognized flag(s), ignored: --json" while the flag
  // visibly worked — a readout contradicting itself is worse than no readout.
  'storage status': set(['json', 'primary-only'], STORAGE_OVERRIDE),
  'storage balance': set(['for'], STORAGE_OVERRIDE),
  'storage topup': set(['usd'], STORAGE_OVERRIDE),
  'storage backup-key': set(['out']),

  // ── owner writes (every one also takes SHARED_WRITE) ──
  refresh: set(['token']), // sends no tx — SHARED_WRITE deliberately does NOT apply
  'set-minter': set(['minter'], SHARED_WRITE),
  'set-max-invocations': set(['max'], SHARED_WRITE),
  'ping-uri': set(['token-ids'], SHARED_WRITE),
  'configure-param': set(['file', 'remote'], SHARED_WRITE),
  'submit-app': set(
    ['name', 'summary', 'description', 'mark', 'tone', 'category', 'stage', 'url', 'url-label', 'image', 'tags', 'registry', 'minter'],
    SHARED_WRITE,
  ),
  'set-schema': set(['schema', 'force'], SHARED_WRITE),
  'retire-param': set([], SHARED_WRITE),
  'set-param-hooks': set(['configure', 'augment', 'transfer', 'clear'], SHARED_WRITE),
  'set-dependency': set([], SHARED_WRITE),
  'remove-last-dependency': set([], SHARED_WRITE),
  'set-dependency-registry': set([], SHARED_WRITE),
  'lock-dependencies': set([], SHARED_WRITE),
  'lock-script': set([], SHARED_WRITE),
  'lock-param-hooks': set([], SHARED_WRITE),
  'set-primary-payee': set(['payee'], SHARED_WRITE),
  pause: set([], SHARED_WRITE),
  unpause: set([], SHARED_WRITE),
  'set-token-uri': set(['uri', 'override', 'token'], SHARED_WRITE),
  'set-contract-uri': set(['uri', 'override'], SHARED_WRITE),
  'set-royalty': set(['bps', 'receiver'], SHARED_WRITE),
  'set-royalty-cap': set(['cap'], SHARED_WRITE),
  'set-transfer-validator': set([], SHARED_WRITE),
  'set-seed-source': set([], SHARED_WRITE),
  'set-field': set(['field', 'text', 'value', 'representation', 'collection', 'token', 'file', 'compress'], SHARED_WRITE),
  'lock-field': set(['field', 'collection', 'token', 'force-field'], SHARED_WRITE),
  'set-renderer': set(['collection', 'off', 'renderer'], SHARED_WRITE),
  'lock-uri': set(['collection'], SHARED_WRITE),
  'set-admin': set(['to'], SHARED_WRITE),
};

/**
 * The allowlist for a dispatched command, preferring a `"<cmd> <sub>"` row. Returns undefined when the
 * command isn't listed, which means "don't check" — never "nothing is allowed".
 */
export function allowlistFor(cmd: string, sub?: string): ReadonlySet<string> | undefined {
  if (sub) {
    const withSub = COMMAND_FLAGS[`${cmd} ${sub}`];
    if (withSub) return withSub;
  }
  return COMMAND_FLAGS[cmd];
}
