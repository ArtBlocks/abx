// Registry-aware dependency resolution + the query-string size budget
// (site/content/docs/protocol/code-projects.mdx "Consumers"; code-projects.md "The canonical
// generator" / tokenData delivery). The resolution order under test: the collection's
// registry pointer (availableOnChain → inline the gunzipped bytes → else preferredCDN
// `<script src>`) → the built-in CDN map (last resort, warns). Resolution NEVER throws —
// the document always assembles. The URL budget applies only to URL-carried ?abx= lanes
// (the directory 302 fallback); inline injection is the directory primary and exempt.
// All chain + gateway reads are mocked; no network.
import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {stringToHex} from 'viem';
import type {DependencyInfo, ParamValue, ProjectState, TokenState} from '@artblocks/abx-sdk';
import {resetEntryDocumentCache, resolveLiveView} from '../src/code.js';
import {
  depStatusReport,
  registryDepUrl,
  resetDependencyResolutionState,
  urlBudgetStatus,
  URL_BUDGET_BYTES,
} from '../src/deps.js';

const ADDR = '0x0000000000000000000000000000000000000abc' as `0x${string}`;
const REGISTRY = '0x1111111111111111111111111111111111111111' as `0x${string}`;

const registryDep = (tag: string): DependencyInfo => ({
  resolution: 'registry',
  ref: stringToHex(tag, {size: 32}),
  refDecoded: tag,
});

/** A template-mode code project (script chunks on chain, no `code` field). */
function templateState(deps: DependencyInfo[], registry: `0x${string}` | null): ProjectState {
  return {
    address: ADDR,
    chainId: 11155111,
    name: 'Drift',
    collectionFields: [],
    tokens: [],
    paramHooks: null,
    maxInvocations: '8',
    script: {chunkCount: 1, locked: false},
    dependencies: {list: deps, registry, locked: false},
  } as never;
}

/** A directory-mode code project (`code` field → inline injection, ?abx= 302 as fallback). */
function directoryState(): ProjectState {
  return {
    address: ADDR,
    chainId: 11155111,
    name: 'Drift',
    collectionFields: [{field: 'code', representation: 'ipfs', value: stringToHex('QmDir')}],
    tokens: [],
    paramHooks: null,
    maxInvocations: '8',
  } as never;
}

const token = (params?: ParamValue[]): TokenState =>
  ({tokenId: '0', lifecycle: 'live', owner: null, tokenURI: null, fields: [], lockedFields: [], params}) as never;

const pv = (key: string, value: bigint): ParamValue => ({
  key,
  value: `0x${value.toString(16).padStart(64, '0')}` as `0x${string}`,
  valueIsHash: false,
  updatedBy: ADDR,
});

/** IDependencyRegistryV0.getDependencyDetails return tuple, defaulted to "not registered". */
const details = (over: Partial<{nameAndVersion: string; preferredCDN: string; availableOnChain: boolean; scriptCount: number}> = {}) => [
  over.nameAndVersion ?? '',
  '',
  over.preferredCDN ?? '',
  0,
  '',
  0,
  '',
  over.availableOnChain ?? false,
  over.scriptCount ?? 0,
];

type ReadCall = {functionName: string; address: string; args: readonly unknown[]};

/** A mock PublicClient: script chunks via multicall, registry reads via readContract. */
function mockClient(over: Partial<Record<'readContract' | 'getCode', (a: never) => Promise<unknown>>> = {}, calls?: ReadCall[]) {
  return {
    multicall: async ({contracts}: {contracts: Array<unknown>}) =>
      contracts.map(() => ({status: 'success', result: stringToHex('draw();')})),
    readContract: async (req: ReadCall) => {
      calls?.push(req);
      if (!over.readContract) throw new Error('unexpected readContract');
      return over.readContract(req as never);
    },
    getCode: async (req: never) => (over.getCode ? over.getCode(req) : undefined),
  } as never;
}

/** Capture console.warn/console.debug for a block (the fallback + budget paths log there). */
async function capture<T>(fn: () => Promise<T>): Promise<{result: T; warns: string[]; debugs: string[]}> {
  const warns: string[] = [];
  const debugs: string[] = [];
  const origWarn = console.warn;
  const origDebug = console.debug;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(' '));
  console.debug = (...a: unknown[]) => void debugs.push(a.map(String).join(' '));
  try {
    return {result: await fn(), warns, debugs};
  } finally {
    console.warn = origWarn;
    console.debug = origDebug;
  }
}

/** A dead gateway — forces the directory live view onto the ?abx= redirect fallback
 *  (the only lane the URL budget applies to). */
const failingFetch = (async () => {
  throw new Error('gateway down');
}) as unknown as typeof fetch;

/** A stub gateway serving a minimal entry document (the inline-injection primary). */
const okFetch = (async () => ({ok: true, status: 200, text: async () => '<html><head></head><body></body></html>'})) as unknown as typeof fetch;

beforeEach(() => {
  resetDependencyResolutionState();
  resetEntryDocumentCache();
});

// ── (a) on-chain registry dep → inlined gunzipped script ─────────────────────────

test('registry dep availableOnChain: chunks concatenate, base64-decode, gunzip → inline <script>', async () => {
  const js = 'window.__p5 = "loaded";';
  const b64 = gzipSync(Buffer.from(js, 'utf8')).toString('base64');
  const chunks = [b64.slice(0, Math.ceil(b64.length / 2)), b64.slice(Math.ceil(b64.length / 2))]; // 2 chunks: the split rides mid-stream
  const calls: ReadCall[] = [];
  const client = mockClient(
    {
      readContract: async ({functionName, args}: ReadCall) => {
        if (functionName === 'getDependencyDetails') return details({nameAndVersion: 'p5@1.0.0', availableOnChain: true, scriptCount: 2});
        if (functionName === 'getDependencyScript') return chunks[Number(args[1])];
        throw new Error(`unexpected ${functionName}`);
      },
    },
    calls,
  );
  const view = await resolveLiveView(client, templateState([registryDep('p5@1.0.0')], REGISTRY), token());
  assert.equal(view?.kind, 'html');
  const html = (view as {html: string}).html;
  assert.ok(html.includes(`<script>${js}</script>`), 'inlines the gunzipped registry bytes');
  assert.ok(html.includes('draw();'), 'the project script chunks still ride');
  // the eth_call went to the collection's registry with the readable-ASCII bytes32 ref
  assert.equal(calls[0].address, REGISTRY);
  assert.equal(calls[0].args[0], stringToHex('p5@1.0.0', {size: 32}));
});

// ── (b) CDN registry dep → preferredCDN src tag ───────────────────────────────────

test('registry dep with preferredCDN (not on-chain) → <script src="preferredCDN">', async () => {
  const client = mockClient({
    readContract: async () => details({nameAndVersion: 'tone@14.7.77', preferredCDN: 'https://cdn.example/tone.js'}),
  });
  const view = await resolveLiveView(client, templateState([registryDep('tone@14.7.77')], REGISTRY), token());
  const html = (view as {html: string}).html;
  assert.ok(html.includes('<script src="https://cdn.example/tone.js"></script>'));
});

// ── (c) registry error → built-in map fallback, one warn, document assembles ─────

test('registry unreachable → built-in CDN map + one warn; the document still assembles', async () => {
  const client = mockClient({
    readContract: async () => {
      throw new Error('connection refused');
    },
  });
  const {result: view, warns} = await capture(() =>
    resolveLiveView(client, templateState([registryDep('p5@1.0.0')], REGISTRY), token()),
  );
  const html = (view as {html: string}).html;
  assert.ok(html.includes('<script src="https://cdn.jsdelivr.net/npm/p5@1.0.0/lib/p5.min.js"></script>'), 'falls back to the built-in map');
  assert.ok(html.includes('draw();'), 'the document assembled despite the registry failure');
  const relevant = warns.filter((w) => w.includes('p5@1.0.0'));
  assert.equal(relevant.length, 1, 'exactly one warn naming the dep');
  assert.ok(relevant[0].includes('connection refused'), 'the warn says why');
});

test('registry entry missing (empty struct) → built-in map fallback + warn', async () => {
  const client = mockClient({readContract: async () => details()}); // all-empty: not registered
  const {result: view, warns} = await capture(() =>
    resolveLiveView(client, templateState([registryDep('p5@1.0.0')], REGISTRY), token()),
  );
  assert.ok((view as {html: string}).html.includes('cdn.jsdelivr.net/npm/p5@1.0.0/lib/p5.min.js'));
  assert.ok(warns.some((w) => w.includes('not registered')));
});

// ── (d) registry unset → the pre-registry behavior, untouched ─────────────────────

test('registry unset: built-in CDN map, and the registry is NEVER called', async () => {
  const client = mockClient(); // readContract throws 'unexpected' if reached
  const view = await resolveLiveView(client, templateState([registryDep('p5@1.0.0')], null), token());
  const html = (view as {html: string}).html;
  assert.ok(html.includes('<script src="https://cdn.jsdelivr.net/npm/p5@1.0.0/lib/p5.min.js"></script>'));
});

test('built-in map: known runtimes get dist paths, unknown get best-effort npm, no @ → null', () => {
  assert.equal(registryDepUrl('three@0.124.0'), 'https://cdn.jsdelivr.net/npm/three@0.124.0/build/three.min.js');
  assert.equal(registryDepUrl('somelib@1.2.3'), 'https://cdn.jsdelivr.net/npm/somelib@1.2.3');
  assert.equal(registryDepUrl('notatag'), null);
});

// ── the cache: one registry read per (registry, ref) per TTL ──────────────────────

test('resolved entries cache in-process: the second document assembly does zero registry reads', async () => {
  const calls: ReadCall[] = [];
  const client = mockClient({readContract: async () => details({nameAndVersion: 'tone@14.7.77', preferredCDN: 'https://cdn.example/tone.js'})}, calls);
  const state = templateState([registryDep('tone@14.7.77')], REGISTRY);
  await resolveLiveView(client, state, token());
  const after = calls.length;
  await resolveLiveView(client, state, token());
  assert.equal(calls.length, after, 'served from cache — no new eth_calls');
});

// ── (e) the query-string size budget — URL-carried lanes only (the 302 fallback) ──
// Inline injection is the directory primary and carries tokenData inside the document;
// the budget applies only when tokenData rides a URL, so these force the fallback
// (dead gateway) explicitly.

test('over-budget fallback redirect: the FULL URL is still served; warn once per project, then debug', async () => {
  // ~150 params × ~75 bytes of canonical JSON each ≈ 11KB before base64url — over 8192.
  const bigParams = Array.from({length: 150}, (_, i) => pv(`p${String(i).padStart(3, '0')}`, BigInt(i)));
  const state = directoryState();
  const {result: first, warns, debugs} = await capture(async () => {
    const a = await resolveLiveView({} as never, state, token(bigParams), failingFetch);
    const b = await resolveLiveView({} as never, state, token(bigParams), failingFetch); // the repeat → debug-level
    return {a, b};
  });
  assert.equal(first.a?.kind, 'redirect');
  const loc = (first.a as {location: string}).location;
  assert.ok(Buffer.byteLength(loc, 'utf8') > URL_BUDGET_BYTES, 'the fixture really is over budget');
  assert.match(loc, /\?abx=/, 'params never dropped — the full URL is served');
  assert.equal((first.b as {location: string}).location, loc, 'the repeat serves the same full URL');

  const budgetWarns = warns.filter((w) => w.includes('url-budget-exceeded'));
  assert.equal(budgetWarns.length, 1, 'warns once per project per process');
  assert.ok(budgetWarns[0].includes(ADDR) && budgetWarns[0].includes('"tokenId":"0"') && budgetWarns[0].includes('"bytes":'), 'structured: addr + tokenId + byte size');
  assert.ok(budgetWarns[0].includes('template mode or locator params'), 'names the fix');
  assert.ok(budgetWarns[0].includes('resolver inline serving unaffected'), 'scopes the budget to URL-carried lanes');
  assert.equal(debugs.filter((d) => d.includes('url-budget-exceeded')).length, 1, 'repeats drop to debug');

  const status = urlBudgetStatus(ADDR);
  assert.equal(status.exceeded, true);
  assert.ok((status.lastBytes ?? 0) > URL_BUDGET_BYTES);
});

test('under-budget fallback redirect: no warn, no flag', async () => {
  const {result: view, warns} = await capture(() => resolveLiveView({} as never, directoryState(), token([pv('seed', 1n)]), failingFetch));
  assert.equal(view?.kind, 'redirect');
  assert.equal(warns.filter((w) => w.includes('url-budget-exceeded')).length, 0);
  assert.deepEqual(urlBudgetStatus(ADDR), {limit: URL_BUDGET_BYTES, exceeded: false});
});

test('inline-injection serving is exempt from the budget: a huge param surface serves html, no warn', async () => {
  const bigParams = Array.from({length: 150}, (_, i) => pv(`p${String(i).padStart(3, '0')}`, BigInt(i)));
  const {result: view, warns} = await capture(() => resolveLiveView({} as never, directoryState(), token(bigParams), okFetch));
  assert.equal(view?.kind, 'html');
  assert.ok((view as {html: string}).html.includes('window.abxTokenData='), 'tokenData rides inside the document, not a URL');
  assert.equal(warns.filter((w) => w.includes('url-budget-exceeded')).length, 0);
  assert.deepEqual(urlBudgetStatus(ADDR), {limit: URL_BUDGET_BYTES, exceeded: false});
});

// ── (f) the dep-status surface (GET /api/deps/:chainId/:addr) ─────────────────────

test('depStatusReport: per-dep {ref, resolution, resolvedVia, registry, cached} across all rungs', async () => {
  const client = mockClient({
    readContract: async ({args}: ReadCall) => {
      if (args[0] === stringToHex('p5@1.0.0', {size: 32})) {
        return details({nameAndVersion: 'p5@1.0.0', preferredCDN: 'https://cdn.example/p5.min.js'});
      }
      return details(); // three@0.124.0: not registered → builtin-map
    },
    getCode: async () => `0x00${Buffer.from('lib', 'utf8').toString('hex')}`, // SSTORE2: guard byte ‖ content
  });
  const sstore2 = '0x2222222222222222222222222222222222222222';
  const state = templateState(
    [registryDep('p5@1.0.0'), registryDep('three@0.124.0'), {resolution: 'onchain', ref: `0x${sstore2.slice(2).padEnd(64, '0')}` as never, refDecoded: sstore2}],
    REGISTRY,
  );
  const {result: report} = await capture(() => depStatusReport(client, state));
  assert.equal(report.address, ADDR);
  assert.equal(report.registry, REGISTRY);
  assert.equal(report.locked, false);
  assert.deepEqual(report.deps, [
    {ref: 'p5@1.0.0', resolution: 'registry', resolvedVia: 'cdn-registry', registry: REGISTRY, cached: false},
    {ref: 'three@0.124.0', resolution: 'registry', resolvedVia: 'builtin-map', registry: REGISTRY, cached: false},
    {ref: sstore2, resolution: 'onchain', resolvedVia: 'inline-onchain', registry: null, cached: false},
  ]);
  assert.equal(report.urlBudget, undefined, 'template mode carries no URL budget');

  // a second read reports cached: true for the registry-resolved dep (it shares serving's cache)
  const {result: again} = await capture(() => depStatusReport(client, state));
  assert.equal((again.deps as Array<{cached: boolean}>)[0].cached, true);
});

test('depStatusReport: a directory project carries urlBudget + the active serving path; a dead SSTORE2 dep reads unresolved', async () => {
  const state = {
    ...directoryState(),
    dependencies: {list: [{resolution: 'onchain', ref: '0x00', refDecoded: '0x3333333333333333333333333333333333333333'}], registry: null, locked: true},
  } as never as ProjectState;
  const client = mockClient({getCode: async () => undefined}); // no code at the address
  const report = await depStatusReport(client, state);
  assert.deepEqual(report.urlBudget, {limit: URL_BUDGET_BYTES, exceeded: false});
  assert.deepEqual(report.directoryServing, {primary: 'inline-injection', active: 'inline-injection'}, 'inline injection is the default-active path');
  assert.equal(report.locked, true);
  assert.equal((report.deps as Array<{resolvedVia: string}>)[0].resolvedVia, 'unresolved');
});

test('depStatusReport: the serving path tracks reality — a gateway outage flips it to redirect-fallback, recovery flips it back', async () => {
  const state = directoryState();
  const client = mockClient();
  await capture(() => resolveLiveView({} as never, state, token([pv('seed', 1n)]), failingFetch));
  const during = await depStatusReport(client, state);
  const outage = during.directoryServing as {primary: string; active: string; at?: string};
  assert.equal(outage.primary, 'inline-injection');
  assert.equal(outage.active, 'redirect-fallback');
  assert.ok(outage.at, 'stamped with the observation time');

  await resolveLiveView({} as never, state, token([pv('seed', 1n)]), okFetch);
  const after = await depStatusReport(client, state);
  assert.equal((after.directoryServing as {active: string}).active, 'inline-injection');
});

test('depStatusReport: a zero-address registry pointer reads as no registry (builtin-map)', async () => {
  const state = templateState([registryDep('p5@1.0.0')], '0x0000000000000000000000000000000000000000');
  const client = mockClient(); // any registry read would throw 'unexpected readContract'
  const report = await depStatusReport(client, state);
  assert.deepEqual(report.deps, [
    {ref: 'p5@1.0.0', resolution: 'registry', resolvedVia: 'builtin-map', registry: null, cached: false},
  ]);
});
