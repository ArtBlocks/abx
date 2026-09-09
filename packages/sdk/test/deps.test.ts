import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {decodeFunctionData, stringToHex} from 'viem';
import {
  DEP_RESOLUTION,
  activeRegistry,
  checkRegistryDeps,
  decodeDependencyRef,
  dependencyScriptTags,
  dependencySetupCalls,
  encodeDependencyName,
  parseDependencyRef,
  readRegistryDependency,
  registryDepUrl,
  resetRegistryDependencyCache,
  resolveDepRegistryPointer,
  resolveRegistryDep,
} from '../src/deps.ts';
import {
  prepareLockDependencies,
  prepareRemoveLastDependency,
  prepareSetDependency,
  prepareSetDependencyRegistry,
} from '../src/ops.ts';
import {AB_DEPENDENCY_REGISTRY, resolveDependencyRegistry} from '../src/deployments.ts';
import {seriesCodeAbi} from '../src/abi/index.ts';
import {InflateRequiredError} from '../src/errors.ts';
import {nodeInflate} from '../src/node.ts';
import type {ProjectState} from '../src/types.ts';

const TOKEN = '0x1111111111111111111111111111111111111111' as const;
const REG = '0x5Fcc415BCFb164C5F826B5305274749BeB684e9b' as const;
const CHAIN = 11155111;

// ── ref encoding: the readable bytes32 (a Solidity `bytes32("p5@1.0.0")` twin) ──

test('parseDependencyRef: name@version → Registry, left-aligned readable bytes32, round-trips', () => {
  for (const name of ['p5@1.0.0', 'three@0.124.0', 'p5js@1.9.0', 'cannon-es@0.20.0']) {
    const dep = parseDependencyRef(name);
    assert.equal(dep.resolution, DEP_RESOLUTION.registry);
    assert.equal(dep.display, name);
    // exactly the contract-test encoding: ASCII left-aligned, zero-padded to 32 bytes
    const ascii = Buffer.from(name, 'ascii').toString('hex');
    assert.equal(dep.ref, `0x${ascii}${'0'.repeat(64 - ascii.length)}`);
    assert.equal(decodeDependencyRef(dep.resolution, dep.ref), name); // round trip
  }
});

test('parseDependencyRef: a full-width 32-byte name fits; 33 bytes is refused', () => {
  const max = `${'a'.repeat(25)}@1.23.4`; // 32 ASCII bytes
  assert.equal(max.length, 32);
  assert.equal(parseDependencyRef(max).ref.length, 66);
  assert.throws(() => parseDependencyRef(`${'a'.repeat(26)}@1.23.4`), /at most 32/);
});

test('encodeDependencyName rejections: @-arity, empties, non-ASCII, whitespace', () => {
  assert.throws(() => encodeDependencyName('p5'), /exactly one '@'/); // no version
  assert.throws(() => encodeDependencyName('a@b@c'), /exactly one '@'/); // two @
  assert.throws(() => encodeDependencyName('@1.0.0'), /exactly one '@'/); // empty name
  assert.throws(() => encodeDependencyName('p5@'), /exactly one '@'/); // empty version
  assert.throws(() => encodeDependencyName('p5é@1.0.0'), /printable non-space ASCII/); // non-ASCII
  assert.throws(() => encodeDependencyName('p 5@1.0.0'), /printable non-space ASCII/); // inner space
  assert.throws(() => encodeDependencyName('p5\t@1.0.0'), /printable non-space ASCII/); // control char
});

test('parseDependencyRef: 0x + 40 hex → OnChain, address left-aligned in bytes32', () => {
  const dep = parseDependencyRef('0x000000000000000000000000000000000000CAfE');
  assert.equal(dep.resolution, DEP_RESOLUTION.onchain);
  assert.equal(dep.display, '0x000000000000000000000000000000000000cafe');
  assert.equal(dep.ref, '0x000000000000000000000000000000000000cafe000000000000000000000000');
  assert.equal(decodeDependencyRef(dep.resolution, dep.ref), dep.display); // round trip
});

test('parseDependencyRef: a 0x-ish non-address falls through to (and fails) name@version validation', () => {
  assert.throws(() => parseDependencyRef('0x1234'), /name@version|0x… data-contract/);
  assert.throws(() => parseDependencyRef('0x' + 'f'.repeat(30))); // 30 hex ≠ an address, and no '@'
  assert.throws(() => parseDependencyRef('0x' + 'f'.repeat(39)), /at most 32/); // 39 hex ≠ address; over the bytes32 budget
});

// ── the PreparedTx ops encode the exact contract calls ─────────────────────────

test('prepareSetDependency encodes setDependency(index, resolution, ref)', () => {
  const dep = parseDependencyRef('p5@1.0.0');
  const tx = prepareSetDependency({contract: TOKEN, index: 0, resolution: dep.resolution, ref: dep.ref, display: dep.display, chainId: CHAIN});
  const {functionName, args} = decodeFunctionData({abi: seriesCodeAbi, data: tx.data});
  assert.equal(functionName, 'setDependency');
  assert.deepEqual(args, [0n, DEP_RESOLUTION.registry, dep.ref]);
  assert.equal(tx.to, TOKEN);
  assert.match(tx.summary, /p5@1\.0\.0/);
  assert.match(tx.summary, /index 0 = the runtime/);
});

test('prepareRemoveLastDependency / prepareSetDependencyRegistry / prepareLockDependencies encode their fns', () => {
  const rm = prepareRemoveLastDependency({contract: TOKEN, chainId: CHAIN});
  assert.equal(decodeFunctionData({abi: seriesCodeAbi, data: rm.data}).functionName, 'removeLastDependency');

  const reg = prepareSetDependencyRegistry({contract: TOKEN, registry: REG, chainId: CHAIN});
  const rd = decodeFunctionData({abi: seriesCodeAbi, data: reg.data});
  assert.equal(rd.functionName, 'setDependencyRegistry');
  assert.deepEqual(rd.args, [REG]);

  const lock = prepareLockDependencies({contract: TOKEN, chainId: CHAIN});
  assert.equal(decodeFunctionData({abi: seriesCodeAbi, data: lock.data}).functionName, 'lockDependencies');
  assert.match(lock.summary, /permanent/i);
});

// ── the per-chain resolution root (AB's DependencyRegistryV0) ──────────────────

test('resolveDependencyRegistry: known chains default to the AB registry; unknown → undefined', () => {
  assert.equal(resolveDependencyRegistry(11155111), AB_DEPENDENCY_REGISTRY[11155111]);
  assert.equal(resolveDependencyRegistry(11155111), '0x5Fcc415BCFb164C5F826B5305274749BeB684e9b');
  assert.equal(resolveDependencyRegistry(1), '0x37861f95882ACDba2cCD84F5bFc4598e2ECDDdAF');
  assert.equal(resolveDependencyRegistry(8453), undefined); // no entry — soft: deploy skips the leg
});

test('resolveDependencyRegistry precedence: override → env → manifest', () => {
  const OTHER = '0x2222222222222222222222222222222222222222';
  assert.equal(resolveDependencyRegistry(11155111, OTHER), OTHER);
  process.env.ABX_DEPENDENCY_REGISTRY = '0x3333333333333333333333333333333333333333';
  try {
    assert.equal(resolveDependencyRegistry(11155111), '0x3333333333333333333333333333333333333333');
    assert.equal(resolveDependencyRegistry(11155111, OTHER), OTHER); // override still wins
  } finally {
    delete process.env.ABX_DEPENDENCY_REGISTRY;
  }
});

// ── the AB-compatible registry read (mocked client — tests stay network-free) ──

function mockClient(result: unknown[] | Error) {
  const calls: {address: string; functionName: string; args: unknown[]}[] = [];
  return {
    calls,
    readContract: async (req: {address: `0x${string}`; abi: unknown; functionName: string; args: unknown[]}) => {
      calls.push({address: req.address, functionName: req.functionName, args: req.args});
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test('readRegistryDependency parses a found record (getDependencyDetails tuple order)', async () => {
  const client = mockClient(['p5@1.0.0', 'LGPL', 'https://cdn.example/p5.min.js', 2, 'repo', 1, 'https://p5js.org', true, 3]);
  const dep = parseDependencyRef('p5@1.0.0');
  const details = await readRegistryDependency(client, REG, dep.ref);
  assert.deepEqual(details, {
    nameAndVersion: 'p5@1.0.0',
    licenseType: 'LGPL',
    preferredCDN: 'https://cdn.example/p5.min.js',
    availableOnChain: true,
    scriptCount: 3,
  });
  assert.equal(client.calls[0].functionName, 'getDependencyDetails');
  assert.deepEqual(client.calls[0].args, [dep.ref]);
});

test('readRegistryDependency: an unknown ref → null (the registry ECHOES the name back, zero-valued elsewhere)', async () => {
  // AB's registry does NOT revert for an unknown dep — verified against Sepolia: it returns
  // the requested nameAndVersion with every substantive field empty.
  const echo = mockClient(['nope@0.0.1', '', '', 0, '', 0, '', false, 0]);
  assert.equal(await readRegistryDependency(echo, REG, parseDependencyRef('nope@0.0.1').ref), null);

  // …while a real license-only record (e.g. AB's `js@na`) counts as existing.
  const licenseOnly = mockClient(['js@na', 'NA', '', 0, '', 0, '', false, 0]);
  const details = await readRegistryDependency(licenseOnly, REG, parseDependencyRef('js@na').ref);
  assert.equal(details?.licenseType, 'NA');
  assert.equal(details?.availableOnChain, false);

  const down = mockClient(new Error('fetch failed'));
  await assert.rejects(() => readRegistryDependency(down, REG, parseDependencyRef('p5@1.0.0').ref), /fetch failed/);
});

// ── the deploy-time dependency lane: registry pointer, setup legs, selection-time check ──────
// Moved from the CLI's deps.ts (WP-2b item 4) — `parseDepFlag` (the `--dep` flag grammar) stays
// CLI-local, so fixtures here build refs directly with `parseDependencyRef` instead.

const dep = (...specs: string[]): ReturnType<typeof parseDependencyRef>[] => specs.map(parseDependencyRef);

// ── registry pointer defaulting: flag → known AB registry → none (warn+skip) ──

test('resolveDepRegistryPointer: explicit flag wins (validated), else the chain default, else none', () => {
  const OTHER = '0x2222222222222222222222222222222222222222';
  assert.deepEqual(resolveDepRegistryPointer(OTHER, 11155111), {registry: OTHER, source: 'flag'});
  assert.deepEqual(resolveDepRegistryPointer(undefined, 11155111), {registry: REG, source: 'default'});
  assert.deepEqual(resolveDepRegistryPointer(undefined, 1), {registry: AB_DEPENDENCY_REGISTRY[1], source: 'default'});
  assert.deepEqual(resolveDepRegistryPointer(undefined, 8453), {registry: null, source: 'none'});
  assert.throws(() => resolveDepRegistryPointer('not-an-address', 11155111), /--dep-registry must be an address/);
  assert.throws(() => resolveDepRegistryPointer('true', 11155111), /--dep-registry must be an address/); // bare flag
});

// ── setup-multicall leg composition ────────────────────────────────────────────

test('dependencySetupCalls: setDependency(i,…) per dep in order + the registry pointer leg', () => {
  const deps = dep('p5@1.0.0', '0x000000000000000000000000000000000000cafe');
  const calls = dependencySetupCalls(deps, REG);
  assert.equal(calls.length, 3);

  const d0 = decodeFunctionData({abi: seriesCodeAbi, data: calls[0]});
  assert.equal(d0.functionName, 'setDependency');
  assert.deepEqual(d0.args, [0n, DEP_RESOLUTION.registry, deps[0].ref]);

  const d1 = decodeFunctionData({abi: seriesCodeAbi, data: calls[1]});
  assert.deepEqual(d1.args, [1n, DEP_RESOLUTION.onchain, deps[1].ref]);

  const d2 = decodeFunctionData({abi: seriesCodeAbi, data: calls[2]});
  assert.equal(d2.functionName, 'setDependencyRegistry');
  assert.deepEqual(d2.args, [REG]);
});

test('dependencySetupCalls: no registry pointer → no pointer leg; no deps → no legs at all', () => {
  const deps = dep('p5@1.0.0');
  const noPointer = dependencySetupCalls(deps, null);
  assert.equal(noPointer.length, 1);
  assert.equal(decodeFunctionData({abi: seriesCodeAbi, data: noPointer[0]}).functionName, 'setDependency');
  assert.deepEqual(dependencySetupCalls([], REG), []); // a pointer without deps is not emitted
});

// ── selection-time check (mocked RPC — tests stay network-free) ────────────────

const FOUND = ['p5@1.0.0', 'LGPL', 'https://cdn.example/p5.min.js', 0, '', 0, '', false, 0];
// an unknown dep: the AB registry echoes the name back, all substantive fields zero-valued
const EMPTY = ['nope@9.9.9', '', '', 0, '', 0, '', false, 0];

test('checkRegistryDeps: found / not-found per Registry dep; OnChain refs never touch the registry', async () => {
  const seen: unknown[][] = [];
  const client = {
    readContract: async (req: {args: unknown[]}) => {
      seen.push(req.args);
      return seen.length === 1 ? FOUND : EMPTY;
    },
  };
  const deps = dep('p5@1.0.0', '0x000000000000000000000000000000000000cafe', 'nope@9.9.9');
  const {checks, rpcOk} = await checkRegistryDeps(client, REG, deps);
  assert.equal(rpcOk, true);
  assert.equal(seen.length, 2); // the OnChain dep made NO registry read
  assert.deepEqual(
    checks.map((chk) => ({dep: chk.dep, status: chk.status})),
    [
      {dep: 'p5@1.0.0', status: 'found'},
      {dep: 'nope@9.9.9', status: 'not-found'},
    ],
  );
  assert.equal(checks[0].status === 'found' && checks[0].details.preferredCDN, 'https://cdn.example/p5.min.js');
});

test('checkRegistryDeps: a contract revert reads as not-found; a transport failure degrades to skipped', async () => {
  const reverting = {
    readContract: async () => {
      throw Object.assign(new Error('execution reverted'), {name: 'ContractFunctionExecutionError'});
    },
  };
  const revertRes = await checkRegistryDeps(reverting, REG, dep('p5@1.0.0'));
  assert.equal(revertRes.rpcOk, true);
  assert.deepEqual(revertRes.checks, [{dep: 'p5@1.0.0', status: 'not-found'}]);

  const offline = {
    readContract: async () => {
      throw Object.assign(new Error('fetch failed'), {name: 'HttpRequestError'});
    },
  };
  const offRes = await checkRegistryDeps(offline, REG, dep('p5@1.0.0', 'three@0.124.0'));
  assert.equal(offRes.rpcOk, false); // one info line at the CLI; deploy proceeds
  assert.deepEqual(
    offRes.checks.map((chk) => chk.status),
    ['skipped', 'skipped'],
  );
});

// ── the resolver's registry-aware serving lane (hoisted from token-api) ───────────────────────
// `resolveRegistryDep`/`dependencyScriptTags`/`activeRegistry`/`registryDepUrl` moved here from
// `@artblocks/abx-token-api`; token-api's own
// test/deps.test.ts keeps the integration coverage that exercises this through
// `resolveLiveView`/`depStatusReport`. The tests below are the load-bearing NEW coverage: the
// injected-`inflate` design (SDK core carries no node:zlib) was never testable before this hoist
// — the old implementation called `gunzipSync` directly, with no seam to intercept.

const ADDR = '0x0000000000000000000000000000000000000abc' as const;

const registryDepInfo = (tag: string) => ({resolution: 'registry' as const, ref: stringToHex(tag, {size: 32}), refDecoded: tag});

const registryDetails = (
  over: Partial<{nameAndVersion: string; preferredCDN: string; availableOnChain: boolean; scriptCount: number}> = {},
) => [
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

type RegistryReadCall = {functionName: string; address: string; args: readonly unknown[]};

function mockRegistryClient(
  over: Partial<Record<'readContract' | 'getCode', (a: never) => Promise<unknown>>> = {},
  calls?: RegistryReadCall[],
) {
  return {
    readContract: async (req: RegistryReadCall) => {
      calls?.push(req);
      if (!over.readContract) throw new Error('unexpected readContract');
      return over.readContract(req as never);
    },
    getCode: async (req: never) => (over.getCode ? over.getCode(req) : undefined),
  } as never;
}

test('activeRegistry: a real address passes through; undefined/zero-address/no-extension read as none', () => {
  const state = (registry: string | null) => ({dependencies: {list: [], registry, locked: false}}) as never as ProjectState;
  assert.equal(activeRegistry(state(REG)), REG);
  assert.equal(activeRegistry(state(null)), null);
  assert.equal(activeRegistry(state('0x0000000000000000000000000000000000000000')), null);
  assert.equal(activeRegistry({dependencies: null} as never as ProjectState), null);
});

test('registryDepUrl: known runtimes get dist paths, unknown get best-effort npm, no @ → null', () => {
  assert.equal(registryDepUrl('p5@1.0.0'), 'https://cdn.jsdelivr.net/npm/p5@1.0.0/lib/p5.min.js');
  assert.equal(registryDepUrl('three@0.124.0'), 'https://cdn.jsdelivr.net/npm/three@0.124.0/build/three.min.js');
  assert.equal(registryDepUrl('somelib@1.2.3'), 'https://cdn.jsdelivr.net/npm/somelib@1.2.3');
  assert.equal(registryDepUrl('notatag'), null);
});

test('resolveRegistryDep: a CDN-resolved dep never needs `inflate`', async () => {
  const client = mockRegistryClient({
    readContract: async () => registryDetails({nameAndVersion: 'tone@14.7.77', preferredCDN: 'https://cdn.example/tone.js'}),
  });
  const {resolution} = await resolveRegistryDep(client, REG, registryDepInfo('tone@14.7.77'));
  assert.deepEqual(resolution, {kind: 'cdn', url: 'https://cdn.example/tone.js'});
});

test('resolveRegistryDep: on-chain gzip bytes with NO inflate → throws InflateRequiredError naming the fix', async () => {
  resetRegistryDependencyCache();
  const js = 'window.__p5 = "loaded";';
  const b64 = Buffer.from(gzipSync(Buffer.from(js, 'utf8'))).toString('base64');
  const client = mockRegistryClient({
    readContract: async ({functionName}: RegistryReadCall) => {
      if (functionName === 'getDependencyDetails') return registryDetails({nameAndVersion: 'p5@1.0.0', availableOnChain: true, scriptCount: 1});
      if (functionName === 'getDependencyScript') return b64;
      throw new Error('unexpected');
    },
  });
  await assert.rejects(
    () => resolveRegistryDep(client, REG, registryDepInfo('p5@1.0.0')),
    (err: unknown) => {
      assert.ok(err instanceof InflateRequiredError);
      assert.match((err as Error).message, /nodeInflate/);
      assert.match((err as Error).message, /@artblocks\/abx-sdk\/node/);
      return true;
    },
  );
});

test('resolveRegistryDep: on-chain gzip bytes WITH nodeInflate → decompresses to the original script; cached on the second call', async () => {
  resetRegistryDependencyCache();
  const js = 'window.__p5 = "loaded";';
  const b64 = Buffer.from(gzipSync(Buffer.from(js, 'utf8'))).toString('base64');
  // split mid-stream — the chunks concatenate before decoding, exactly as on-chain storage does
  const chunks = [b64.slice(0, Math.ceil(b64.length / 2)), b64.slice(Math.ceil(b64.length / 2))];
  const client = mockRegistryClient({
    readContract: async ({functionName, args}: RegistryReadCall) => {
      if (functionName === 'getDependencyDetails') return registryDetails({nameAndVersion: 'p5@1.0.0', availableOnChain: true, scriptCount: 2});
      if (functionName === 'getDependencyScript') return chunks[Number(args[1])];
      throw new Error('unexpected');
    },
  });
  const {resolution, cached} = await resolveRegistryDep(client, REG, registryDepInfo('p5@1.0.0'), {inflate: nodeInflate});
  assert.deepEqual(resolution, {kind: 'onchain', script: js});
  assert.equal(cached, false);

  // second call for the SAME (registry, ref) is served from cache — no `inflate` needed at all
  // this time, even though the cached value came from one.
  const {resolution: again, cached: cachedAgain} = await resolveRegistryDep(client, REG, registryDepInfo('p5@1.0.0'));
  assert.deepEqual(again, {kind: 'onchain', script: js});
  assert.equal(cachedAgain, true);
});

test('resolveRegistryDep: an unrelated registry-read failure still degrades to a null resolution (never throws)', async () => {
  resetRegistryDependencyCache();
  const client = mockRegistryClient({
    readContract: async () => {
      throw new Error('connection refused');
    },
  });
  const {resolution, error} = await resolveRegistryDep(client, REG, registryDepInfo('p5@1.0.0'));
  assert.equal(resolution, null);
  assert.match(error ?? '', /connection refused/);
});

test("dependencyScriptTags: an on-chain SSTORE2 dep needs no inflate — its bytecode is raw, never gzip'd", async () => {
  const sstore2 = '0x2222222222222222222222222222222222222222';
  const state = {
    address: ADDR,
    dependencies: {list: [{resolution: 'onchain', ref: `0x${sstore2.slice(2).padEnd(64, '0')}`, refDecoded: sstore2}], registry: null, locked: false},
  } as never as ProjectState;
  const client = mockRegistryClient({getCode: async () => `0x00${Buffer.from('window.lib=1;', 'utf8').toString('hex')}`});
  const tags = await dependencyScriptTags(client, state);
  assert.deepEqual(tags, ['<script>window.lib=1;</script>']);
});
