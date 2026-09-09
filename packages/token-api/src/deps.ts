import {
  activeRegistry,
  codeField,
  dependencyScriptTags as sdkDependencyScriptTags,
  DEPENDENCY_REGISTRY_ABI,
  registryDepUrl,
  resetRegistryDependencyCache,
  resolveRegistryDep as sdkResolveRegistryDep,
  URL_BUDGET_BYTES,
  type Address,
  type DependencyInfo,
  type ProjectState,
  type PublicClient,
  type RegistryResolution,
} from '@artblocks/abx-sdk';
import {nodeInflate} from '@artblocks/abx-sdk/node';

/**
 * The resolver-only half of the dependency-registry lane: the query-string size budget and the
 * directory-serving observability surface that `GET /api/deps/:chainId/:addr` reports.
 *
 * The registry-resolution vocabulary itself — `DEPENDENCY_REGISTRY_ABI`, `activeRegistry`,
 * `resolveRegistryDep`, `registryDepUrl`, `dependencyScriptTags`, `URL_BUDGET_BYTES` — lives in
 * `@artblocks/abx-sdk` (src/deps.ts): it is chain-read and
 * string-assembly logic with no resolver-specific behavior, so a third-party provider or the
 * CLI's offline preview can now share the identical resolution order instead of reimplementing
 * it. This module re-exports that family below, PRE-WIRED with `nodeInflate`
 * (`@artblocks/abx-sdk/node`) — the SDK core takes decompression as an injected `inflate` rather
 * than importing `node:zlib` directly (it has to stay reachable from a browser bundle), and this
 * resolver runs on Node, so the wiring happens once, here, rather than at every call site.
 *
 * What stays here: `depStatusReport`'s per-dep status assembly (a read-only dry run of the same
 * resolution the generator document uses, sharing its cache), the query-string budget check +
 * flag (`checkUrlBudget`/`urlBudgetStatus`), and which directory-serving path a live view
 * actually took (`recordDirectoryServe`) — all resolver-serving observability, not resolution
 * rules, so they don't belong in the neutral layer.
 */
export {DEPENDENCY_REGISTRY_ABI, activeRegistry, registryDepUrl, URL_BUDGET_BYTES, type RegistryResolution};

/** `resolveRegistryDep`, pre-wired with `nodeInflate` — same signature callers here always used. */
export function resolveRegistryDep(
  client: PublicClient,
  registry: Address,
  dep: DependencyInfo,
): ReturnType<typeof sdkResolveRegistryDep> {
  return sdkResolveRegistryDep(client, registry, dep, {inflate: nodeInflate});
}

/** `dependencyScriptTags`, pre-wired with `nodeInflate` — same signature callers here always used. */
export function dependencyScriptTags(client: PublicClient, state: ProjectState): ReturnType<typeof sdkDependencyScriptTags> {
  return sdkDependencyScriptTags(client, state, {inflate: nodeInflate});
}

/** Reset all in-process dependency state (the SDK's registry-resolution cache + this module's
 *  budget flags + serve modes) — for tests. */
export function resetDependencyResolutionState(): void {
  resetRegistryDependencyCache();
  budgetFlags.clear();
  directoryServeModes.clear();
}

// ── directory serving-path observability ─────────────────────────────────────────

export type DirectoryServeMode = 'inline-injection' | 'redirect-fallback';

// The last directory serve outcome per project (in-process): inline injection is the
// primary; a redirect only happens when the entry-document fetch failed. /api/deps reports it.
const directoryServeModes = new Map<string, {mode: DirectoryServeMode; at: string}>();

/** Record which directory serving path a live-view request actually took. */
export function recordDirectoryServe(address: string, mode: DirectoryServeMode): void {
  directoryServeModes.set(address.toLowerCase(), {mode, at: new Date().toISOString()});
}

// ── the query-string size budget (URL-carried tokenData lanes only) ──────────────

// Per-project over-budget observations (in-process). First breach warns loudly; repeats
// drop to debug so a hot token doesn't spam the log once the fact is known.
const budgetFlags = new Map<string, {bytes: number; tokenId: string; at: string}>();

/**
 * Measure a URL-carried `?abx=` payload (the directory 302 fallback) against the ~8KB
 * budget ({@link URL_BUDGET_BYTES}, from `@artblocks/abx-sdk`). The FULL URL is always served —
 * params are never dropped — this only makes the breach visible: a loud structured warn on the
 * first over-budget redirect per project per process, debug-level after. Inline-injection
 * serving never routes through here.
 */
export function checkUrlBudget(address: string, tokenId: string, redirectUrl: string): void {
  const bytes = Buffer.byteLength(redirectUrl, 'utf8');
  if (bytes <= URL_BUDGET_BYTES) return;
  const key = address.toLowerCase();
  const seen = budgetFlags.has(key);
  budgetFlags.set(key, {bytes, tokenId, at: new Date().toISOString()});
  const payload = JSON.stringify({
    warn: 'url-budget-exceeded',
    address,
    tokenId,
    bytes,
    limit: URL_BUDGET_BYTES,
    hint: 'exceeds the 8KB URL budget — template mode or locator params recommended; resolver inline serving unaffected',
  });
  if (seen) console.debug(`[deps] ${payload}`);
  else console.warn(`[deps] ${payload}`);
}

/** The project's URL-budget status (directory projects) — surfaced by /api/deps. */
export function urlBudgetStatus(address: string): {
  limit: number;
  exceeded: boolean;
  lastBytes?: number;
  lastTokenId?: string;
  lastAt?: string;
} {
  const flag = budgetFlags.get(address.toLowerCase());
  if (!flag) return {limit: URL_BUDGET_BYTES, exceeded: false};
  return {limit: URL_BUDGET_BYTES, exceeded: true, lastBytes: flag.bytes, lastTokenId: flag.tokenId, lastAt: flag.at};
}

// ── the dep-status surface (GET /api/deps/:chainId/:addr) ───────────────────────

export type ResolvedVia = 'onchain-registry' | 'cdn-registry' | 'builtin-map' | 'inline-onchain' | 'unresolved';

export interface DepStatus {
  ref: string;
  resolution: 'registry' | 'onchain';
  resolvedVia: ResolvedVia;
  registry: Address | null;
  cached: boolean;
}

/**
 * Per-dep resolution status for a project — a read-only dry run of the same resolution the
 * generator document uses (and it shares the cache, so a status read warms serving). For
 * directory projects the active serving path (inline-injection primary vs the ?abx= 302
 * fallback) and the URL-budget flag ride along.
 */
export async function depStatusReport(client: PublicClient, state: ProjectState): Promise<Record<string, unknown>> {
  const registry = activeRegistry(state);
  const deps: DepStatus[] = [];
  for (const dep of state.dependencies?.list ?? []) {
    if (dep.resolution === 'onchain') {
      // an SSTORE2 data contract — resolvable iff code is actually there
      let resolvedVia: ResolvedVia = 'unresolved';
      try {
        const bytecode = await client.getCode({address: dep.refDecoded as Address});
        if (bytecode && bytecode.length > 4) resolvedVia = 'inline-onchain';
      } catch {
        // unreachable RPC reads as unresolved — this surface is observational, never throws
      }
      deps.push({ref: dep.refDecoded, resolution: 'onchain', resolvedVia, registry: null, cached: false});
      continue;
    }
    if (registry) {
      const {resolution, cached} = await resolveRegistryDep(client, registry, dep);
      if (resolution) {
        deps.push({
          ref: dep.refDecoded,
          resolution: 'registry',
          resolvedVia: resolution.kind === 'onchain' ? 'onchain-registry' : 'cdn-registry',
          registry,
          cached,
        });
        continue;
      }
    }
    const url = registryDepUrl(dep.refDecoded);
    deps.push({
      ref: dep.refDecoded,
      resolution: 'registry',
      resolvedVia: url ? 'builtin-map' : 'unresolved',
      registry,
      cached: false,
    });
  }
  const directory = !!codeField(state);
  const serve = directoryServeModes.get(state.address.toLowerCase());
  return {
    address: state.address,
    registry,
    locked: state.dependencies?.locked ?? false,
    deps,
    ...(directory
      ? {
          // inline injection is the primary; a redirect only ever means the last serve's
          // entry-document fetch failed. `at` is absent until a live view has been served.
          directoryServing: {primary: 'inline-injection', active: serve?.mode ?? 'inline-injection', ...(serve ? {at: serve.at} : {})},
          urlBudget: urlBudgetStatus(state.address),
        }
      : {}),
  };
}
