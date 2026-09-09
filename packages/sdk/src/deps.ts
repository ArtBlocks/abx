/**
 * Dependencies extension helpers — the vocabulary of a code project's ordered library
 * declarations (`IAbxDependencies`): `(Resolution, bytes32 ref)` pairs, index 0 = the
 * runtime by convention.
 *
 * Two ref shapes, auto-detectable from the human form:
 *   - `name@version` (e.g. `p5@1.0.0` — AB registry naming convention) → `Resolution.Registry`;
 *     encoded as readable-ASCII bytes32, left-aligned + zero-padded (a Solidity `bytes32`
 *     string literal) — resolved through the collection's soft `dependencyRegistry()` pointer.
 *   - `0x` + 40 hex (a raw data contract) → `Resolution.OnChain`; the address left-aligned
 *     in bytes32 — read directly, never through a registry.
 *
 * Also speaks the AB-compatible registry READ interface (`IDependencyRegistryV0`,
 * site/content/docs/protocol/code-projects.mdx): `getDependencyDetails(bytes32)` is the
 * load-bearing read behind the CLI's best-effort selection-time check, and
 * `getDependencyScript(bytes32, index)` is the resolver's own read for on-chain bytes (see the
 * "resolver's registry-aware serving lane" section below — shared with
 * `@artblocks/abx-token-api`, because it uses this exact
 * vocabulary end to end).
 */
import {encodeFunctionData, hexToString, padHex, toHex, type Address, type Hex, type PublicClient} from 'viem';
import {decodeTag} from './spine.js';
import {seriesCodeAbi} from './abi/index.js';
import {resolveDependencyRegistry} from './deployments.js';
import {escapeInlineScript} from './generator-document.js';
import {base64ToBytes} from './util.js';
import {InflateRequiredError} from './errors.js';
import type {DependencyInfo, ProjectState} from './types.js';

/** `IAbxDependencies.Resolution` — index-aligned with the Solidity enum. */
export const DEP_RESOLUTION = {registry: 0, onchain: 1} as const;
export type DepResolution = (typeof DEP_RESOLUTION)[keyof typeof DEP_RESOLUTION];

/** One parsed dependency ref: the enum value + the bytes32 the contract stores + the human form. */
export interface ParsedDependencyRef {
  resolution: DepResolution;
  ref: Hex; // bytes32, encoded per the resolution
  display: string; // `name@version`, or the (lowercase) address
}

// Printable non-space ASCII — what a readable bytes32 tag can carry unambiguously
// (trailing spaces are stripped by the tag decode, so a space anywhere is refused).
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;

/** Encode a registry `name@version` as its readable-ASCII bytes32 (left-aligned, zero-padded —
 *  exactly `bytes32("p5@1.0.0")` in Solidity). Validates the AB naming convention: printable
 *  non-space ASCII, ≤ 32 bytes, exactly one `@` with a non-empty name and version. */
export function encodeDependencyName(nameAndVersion: string): Hex {
  const tag = nameAndVersion.trim();
  if (!PRINTABLE_ASCII.test(tag)) {
    throw new Error(`dependency ref '${nameAndVersion}' must be printable non-space ASCII (a registry ref is a readable bytes32)`);
  }
  if (tag.length > 32) {
    throw new Error(`dependency ref '${tag}' is ${tag.length} bytes — a bytes32 ref holds at most 32`);
  }
  const at = tag.indexOf('@');
  if (at <= 0 || at !== tag.lastIndexOf('@') || at === tag.length - 1) {
    throw new Error(`dependency ref '${tag}' must be name@version with exactly one '@' (e.g. p5@1.0.0), or a 0x… data-contract address`);
  }
  return toHex(tag, {size: 32});
}

/**
 * Parse a human `--dep` ref into its `(Resolution, bytes32)` pair — the one auto-detection
 * rule: `0x` + 40 hex ⇒ `OnChain` (address left-aligned in bytes32); anything else must be a
 * valid registry `name@version` ⇒ `Registry`.
 */
export function parseDependencyRef(input: string): ParsedDependencyRef {
  const t = input.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) {
    const addr = t.toLowerCase() as Address;
    return {resolution: DEP_RESOLUTION.onchain, ref: padHex(addr, {size: 32, dir: 'right'}), display: addr};
  }
  return {resolution: DEP_RESOLUTION.registry, ref: encodeDependencyName(t), display: t};
}

/** The reverse read: an evented `(resolution, bytes32)` back to its human form (the twin of
 *  the reconstruction fold's decode — registry ⇒ the tag, onchain ⇒ the address). */
export function decodeDependencyRef(resolution: DepResolution, ref: Hex): string {
  return resolution === DEP_RESOLUTION.onchain ? '0x' + ref.slice(2, 42) : decodeTag(ref);
}

// ── the AB-compatible registry read (IDependencyRegistryV0) ───────────────────

/**
 * The load-bearing reads of AB's `IDependencyRegistryV0` — the exact upstream signatures (any
 * registry ABX consumers read from speaks this shape; see the dependency-registry spec).
 * `getDependencyDetails` backs both the CLI's best-effort selection-time check and the
 * resolver's own resolution; `getDependencyScript` is the resolver-only per-chunk read for a
 * dep whose bytes live on chain. (Merging this hoist: token-api's `DEPENDENCY_REGISTRY_ABI` and
 * this module's prior `dependencyRegistryReadAbi` declared the identical `getDependencyDetails`
 * entry twice — one array now backs both callers.)
 */
export const DEPENDENCY_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'getDependencyDetails',
    stateMutability: 'view',
    inputs: [{name: 'dependencyNameAndVersion', type: 'bytes32'}],
    outputs: [
      {name: 'nameAndVersion', type: 'string'},
      {name: 'licenseType', type: 'string'},
      {name: 'preferredCDN', type: 'string'},
      {name: 'additionalCDNCount', type: 'uint24'},
      {name: 'preferredRepository', type: 'string'},
      {name: 'additionalRepositoryCount', type: 'uint24'},
      {name: 'dependencyWebsite', type: 'string'},
      {name: 'availableOnChain', type: 'bool'},
      {name: 'scriptCount', type: 'uint24'},
    ],
  },
  {
    type: 'function',
    name: 'getDependencyScript',
    stateMutability: 'view',
    inputs: [
      {name: 'dependencyNameAndVersion', type: 'bytes32'},
      {name: 'index', type: 'uint256'},
    ],
    outputs: [{type: 'string'}],
  },
] as const;

/** What the selection-time check cares about from a registry record. */
export interface RegistryDependencyDetails {
  nameAndVersion: string;
  licenseType: string;
  preferredCDN: string;
  availableOnChain: boolean;
  scriptCount: number;
}

/** The one read this module needs — structurally satisfied by a viem `PublicClient` or a test mock. */
export interface DependencyReadClient {
  readContract(args: {address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[]}): Promise<unknown>;
}

/**
 * Read one dependency's registry record. Returns `null` when the registry doesn't know the
 * ref — AB's registry doesn't revert for an unknown dependency: it ECHOES the requested
 * `nameAndVersion` back with every other field zero-valued (verified against Sepolia), so
 * existence is "any substantive field set" (license is required at registration upstream,
 * so a real record always has at least that — e.g. `js@na` is license-only). Any
 * transport/revert error propagates — the caller decides whether that means "not found"
 * (a revert) or "check unavailable" (RPC down); this stays a pure read.
 */
export async function readRegistryDependency(
  client: DependencyReadClient,
  registry: Address,
  ref: Hex,
): Promise<RegistryDependencyDetails | null> {
  const out = (await client.readContract({
    address: registry,
    abi: DEPENDENCY_REGISTRY_ABI,
    functionName: 'getDependencyDetails',
    args: [ref],
  })) as [string, string, string, number, string, number, string, boolean, number];
  const [nameAndVersion, licenseType, preferredCDN, , preferredRepository, , website, availableOnChain, scriptCount] = out;
  const exists = Boolean(licenseType || preferredCDN || preferredRepository || website || availableOnChain || Number(scriptCount) > 0);
  if (!nameAndVersion || !exists) return null;
  return {nameAndVersion, licenseType, preferredCDN, availableOnChain, scriptCount: Number(scriptCount)};
}

// ── the deploy-time dependency lane (registry pointer, setup legs, selection-time check) ──────
// The rest of a code project's dependency handling: resolving which registry a deploy should point
// at, composing the setup-multicall legs, and the best-effort existence check against that registry.
// `parseDepFlag` (the `--dep` CLI flag grammar) is CLI-local and stays there — everything downstream
// of a parsed `ParsedDependencyRef[]` lives here.

/**
 * The registry pointer a deploy with ≥1 Registry-resolution dep should set: an explicit
 * `--dep-registry` wins (validated), else the chain's known AB registry (env-overridable),
 * else none — the caller WARNS and skips the leg (soft pointer; the resolver falls back to
 * its built-in CDN map). Never a blocker.
 */
export function resolveDepRegistryPointer(
  flagValue: string | undefined,
  chainId: number,
): {registry: Address | null; source: 'flag' | 'default' | 'none'} {
  if (flagValue !== undefined) {
    if (flagValue === 'true' || !/^0x[0-9a-fA-F]{40}$/.test(flagValue)) {
      throw new Error(`--dep-registry must be an address (0x + 40 hex); got '${flagValue}'`);
    }
    return {registry: flagValue as Address, source: 'flag'};
  }
  const known = resolveDependencyRegistry(chainId);
  return known ? {registry: known, source: 'default'} : {registry: null, source: 'none'};
}

/**
 * The dependency legs of the setup multicall: one `setDependency(i, resolution, ref)` per
 * dep in index order, plus the `setDependencyRegistry` leg when a pointer resolved. These
 * ride the SAME atomic setup multicall as script chunks/schemas/mints, in every signing lane.
 */
export function dependencySetupCalls(deps: ParsedDependencyRef[], registry: Address | null): Hex[] {
  const calls = deps.map((d, i) =>
    encodeFunctionData({abi: seriesCodeAbi, functionName: 'setDependency', args: [BigInt(i), d.resolution, d.ref]}),
  );
  if (deps.length && registry) {
    calls.push(encodeFunctionData({abi: seriesCodeAbi, functionName: 'setDependencyRegistry', args: [registry]}));
  }
  return calls;
}

/** One dep's selection-time verdict (Registry-resolution deps only — OnChain refs never touch a registry). */
export type DepCheck =
  | {dep: string; status: 'found'; details: RegistryDependencyDetails}
  | {dep: string; status: 'not-found'}
  | {dep: string; status: 'skipped'};

/**
 * Best-effort existence/on-chain-ness check of every Registry-resolution dep against the
 * pointer registry. A revert or an empty record ⇒ `not-found` (a warning — the owner may
 * intend a custom registry). A transport failure ⇒ the remaining checks are `skipped` and
 * `rpcOk: false` — one info line, never an error: the deploy proceeds regardless.
 */
export async function checkRegistryDeps(
  client: DependencyReadClient,
  registry: Address,
  deps: ParsedDependencyRef[],
): Promise<{checks: DepCheck[]; rpcOk: boolean}> {
  const registryDeps = deps.filter((d) => d.resolution === DEP_RESOLUTION.registry);
  const checks: DepCheck[] = [];
  let rpcOk = true;
  for (const d of registryDeps) {
    if (!rpcOk) {
      checks.push({dep: d.display, status: 'skipped'});
      continue;
    }
    try {
      const details = await readRegistryDependency(client, registry, d.ref);
      checks.push(details ? {dep: d.display, status: 'found', details} : {dep: d.display, status: 'not-found'});
    } catch (e) {
      // A contract revert means the registry answered "no such dependency"; anything else
      // (DNS, timeout, HTTP) means we couldn't ask — degrade to skipped, not failed.
      const msg = `${(e as Error).name ?? ''} ${(e as Error).message ?? ''}`;
      if (/ContractFunction|revert|returned no data/i.test(msg)) {
        checks.push({dep: d.display, status: 'not-found'});
      } else {
        rpcOk = false;
        checks.push({dep: d.display, status: 'skipped'});
      }
    }
  }
  return {checks, rpcOk};
}

// ── the resolver's registry-aware serving lane (on-chain bytes → CDN → built-in map) ──────────
// The resolver's leg of the site/content/docs/protocol/code-projects.mdx "Consumers" table:
//
//   the collection's registry pointer: `availableOnChain` → serve the bytes
//   → else `preferredCDN` → else the built-in CDN map (last resort, warns)
//
// Script chunks are stored gzip'd THEN base64'd on chain; a resolver concatenates the chunk
// strings, base64-decodes, and gunzips so the document inlines plain JS. SDK core carries no
// `node:zlib` (it must stay browser-clean — see `test/browser-bundle.test.ts`), so decompression
// is an INJECTED `inflate` rather than a direct call: a Node host passes `nodeInflate` from
// `@artblocks/abx-sdk/node`; a browser host passes a `DecompressionStream`-based implementation.
// Omitting it when a resolved dep actually needs decompressing throws {@link InflateRequiredError}
// — a host-configuration bug, so it propagates rather than being swallowed into the CDN fallback.
//
// Every OTHER failure still degrades to the built-in map with one warn — the document must
// always assemble; a dead registry or a bad record is data, not a wiring mistake.

/** What a registry ref resolved to: on-chain bytes (decompressed, inline-ready JS) or a CDN URL. */
export type RegistryResolution = {kind: 'onchain'; script: string} | {kind: 'cdn'; url: string};

export interface RegistryResolveOptions {
  /** Decompress gzip bytes — required only when the resolved dependency is on-chain bytes
   *  (`availableOnChain` with `scriptCount > 0`); a CDN-resolved or unresolved dep never needs
   *  it. Omitting it in that case throws {@link InflateRequiredError} naming the fix. */
  inflate?: (bytes: Uint8Array) => Uint8Array;
}

type RegistryCacheEntry = {value: RegistryResolution | null; error?: string; expiresAt: number};

// Resolved registry entries are effectively immutable (admin-gated writes), so an in-process
// cache is safe; the TTL only guards admin updates. Failures negative-cache briefly so a dead
// registry doesn't cost an eth_call (and a warn) per request.
const REGISTRY_CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const REGISTRY_NEGATIVE_TTL_MS = 60 * 1000; // 1min
const registryCache = new Map<string, RegistryCacheEntry>();

/** Reset the in-process registry-resolution cache — for tests. */
export function resetRegistryDependencyCache(): void {
  registryCache.clear();
}

/** The collection's registry pointer, if set to a real address (zero/undefined ⇒ none). */
export function activeRegistry(state: ProjectState): Address | null {
  const registry = state.dependencies?.registry ?? null;
  if (!registry || /^0x0{40}$/i.test(registry)) return null;
  return registry;
}

/**
 * Resolve one `name@version` ref through the collection's registry. Returns the resolution
 * (or null when the registry couldn't answer — caller falls back to the built-in map) plus
 * whether it was served from cache. Never throws for a resolution failure; a fresh one logs ONE
 * warn (the negative cache rate-limits it) naming the dep and why. DOES throw
 * {@link InflateRequiredError} when the resolution needs decompression and `opts.inflate` is
 * absent — that is a caller-configuration bug, not a resolution outcome.
 */
export async function resolveRegistryDep(
  client: PublicClient,
  registry: Address,
  dep: DependencyInfo,
  opts: RegistryResolveOptions = {},
): Promise<{resolution: RegistryResolution | null; cached: boolean; error?: string}> {
  const key = `${registry.toLowerCase()}|${dep.refDecoded}`;
  const hit = registryCache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return {resolution: hit.value, cached: true, error: hit.error};
  }
  try {
    // nameAndVersion rides as readable-ASCII bytes32 — the raw evented ref, right-padded.
    const ref = padHex(dep.ref, {size: 32, dir: 'right'});
    const details = (await client.readContract({
      address: registry,
      abi: DEPENDENCY_REGISTRY_ABI,
      functionName: 'getDependencyDetails',
      args: [ref],
    })) as readonly [string, string, string, number, string, number, string, boolean, number];
    const [nameAndVersion, , preferredCDN, , , , , availableOnChain, scriptCount] = details;

    if (availableOnChain && scriptCount > 0) {
      // Per-chunk reads; the concatenated chunk strings form one base64(gzip(script)) stream.
      const chunks = (await Promise.all(
        Array.from({length: Number(scriptCount)}, (_, i) =>
          client.readContract({
            address: registry,
            abi: DEPENDENCY_REGISTRY_ABI,
            functionName: 'getDependencyScript',
            args: [ref, BigInt(i)],
          }),
        ),
      )) as string[];
      if (!opts.inflate) throw new InflateRequiredError();
      const gz = base64ToBytes(chunks.join(''));
      const script = new TextDecoder().decode(opts.inflate(gz));
      const value: RegistryResolution = {kind: 'onchain', script};
      registryCache.set(key, {value, expiresAt: Date.now() + REGISTRY_CACHE_TTL_MS});
      return {resolution: value, cached: false};
    }
    if (preferredCDN) {
      const value: RegistryResolution = {kind: 'cdn', url: preferredCDN};
      registryCache.set(key, {value, expiresAt: Date.now() + REGISTRY_CACHE_TTL_MS});
      return {resolution: value, cached: false};
    }
    // An empty struct back means the entry simply isn't registered.
    const why = nameAndVersion
      ? 'registered but has neither on-chain bytes nor a preferredCDN'
      : 'not registered in the registry';
    return failRegistryResolution(key, dep, registry, why);
  } catch (err) {
    // A missing inflate is a host-configuration bug, not a resolution outcome — surface it
    // rather than mis-reporting it as "registry read failed" and quietly falling back.
    if (err instanceof InflateRequiredError) throw err;
    return failRegistryResolution(key, dep, registry, `registry read failed: ${(err as Error).message}`);
  }
}

/** Negative-cache a failed resolution + one warn (per negative-TTL window). Never throws. */
function failRegistryResolution(
  key: string,
  dep: DependencyInfo,
  registry: Address,
  why: string,
): {resolution: null; cached: false; error: string} {
  registryCache.set(key, {value: null, error: why, expiresAt: Date.now() + REGISTRY_NEGATIVE_TTL_MS});
  console.warn(
    `[deps] registry resolution failed for ${dep.refDecoded} via ${registry}: ${why} — falling back to the built-in CDN map`,
  );
  return {resolution: null, cached: false, error: why};
}

/**
 * Resolve a `name@version` registry ref to a CDN URL — the built-in reference convention,
 * the LAST-resort rung of the resolution order (the soft registry pointer stays
 * non-validating). Known runtimes get their real dist paths; anything else is best-effort npm.
 */
export function registryDepUrl(ref: string): string | null {
  const at = ref.lastIndexOf('@');
  if (at <= 0) return null;
  const name = ref.slice(0, at);
  const version = ref.slice(at + 1);
  const known: Record<string, string> = {
    p5js: `https://cdn.jsdelivr.net/npm/p5@${version}/lib/p5.min.js`,
    p5: `https://cdn.jsdelivr.net/npm/p5@${version}/lib/p5.min.js`,
    threejs: `https://cdn.jsdelivr.net/npm/three@${version}/build/three.min.js`,
    three: `https://cdn.jsdelivr.net/npm/three@${version}/build/three.min.js`,
    tonejs: `https://cdn.jsdelivr.net/npm/tone@${version}/build/Tone.js`,
  };
  return known[name] ?? `https://cdn.jsdelivr.net/npm/${name}@${version}`;
}

/**
 * The ordered dependency `<script>` tags for the generator document, each dep resolved per
 * the Consumers table: registry on-chain bytes → registry preferredCDN → built-in map;
 * `onchain`-resolution refs read their SSTORE2 data contract directly (never a registry).
 * Never throws for a resolution failure — an unresolvable dep is skipped (after the warn) and
 * the document assembles. DOES propagate {@link InflateRequiredError} (see
 * {@link resolveRegistryDep}) — a missing `inflate` is a host wiring bug, not a bad dep.
 */
export async function dependencyScriptTags(
  client: PublicClient,
  state: ProjectState,
  opts: RegistryResolveOptions = {},
): Promise<string[]> {
  const registry = activeRegistry(state);
  const tags: string[] = [];
  for (const dep of state.dependencies?.list ?? []) {
    if (dep.resolution === 'registry') {
      if (registry) {
        const {resolution} = await resolveRegistryDep(client, registry, dep, opts);
        if (resolution?.kind === 'onchain') {
          tags.push(`<script>${escapeInlineScript(resolution.script)}</script>`);
          continue;
        }
        if (resolution?.kind === 'cdn') {
          tags.push(`<script src="${resolution.url}"></script>`);
          continue;
        }
        // fell through — resolveRegistryDep already warned; last resort below
      }
      const url = registryDepUrl(dep.refDecoded);
      if (url) tags.push(`<script src="${url}"></script>`);
    } else {
      // on-chain dep: an SSTORE2 data contract holding the JS (code = 0x00 ‖ content). No
      // inflate needed here — raw bytecode, never gzip'd — so this branch never touches `opts`.
      const bytecode = await client.getCode({address: dep.refDecoded as Address});
      if (bytecode && bytecode.length > 4) {
        tags.push(`<script>${escapeInlineScript(hexToString(('0x' + bytecode.slice(4)) as Hex))}</script>`);
      }
    }
  }
  return tags;
}

/** The spec's URL-carried tokenData size budget: gateway front-ends commonly cap request lines
 *  near 8KB. Applies to URL-carried `?abx=` payloads (a resolver's directory-mode 302 fallback);
 *  inline document serving is unaffected. Hoisted alongside the rest of this lane — the
 *  budget-tracking/observability surface built on it (`checkUrlBudget`, `urlBudgetStatus`) stays
 *  resolver-local (token-api/src/deps.ts), since it's a serving-observability concern rather than
 *  a resolution rule. */
export const URL_BUDGET_BYTES = 8192;
