import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData, zeroAddress} from 'viem';
import {
  encodeTag,
  seriesCodeAbi,
  METADATA_FIELD as F,
  METADATA_REPRESENTATION as R,
  type Address,
  type Hex,
  type ProjectState,
} from '../src/index.ts';
import {parseDependencyRef, checkRegistryDeps, type DepCheck} from '../src/deps.ts';
import {
  expectedChainComplete,
  generatorFor,
  hasOnChainUriLane,
  hasParamEnumeration,
  onchainUriSetupCalls,
  onChainUriReport,
  readParamSchemaKeys,
  readSetParamKeys,
} from '../src/onchain-uri.ts';

const GENERATOR = '0x7fcf8118D400FF004fF0772a37c24196D9aA7b17' as Address; // the manifest's Sepolia generator
const RENDERER = '0x4D222Af14840FB49040aF73efc311D21Ba45aB50' as Address;
const TOKEN = '0x4861cAc4B3D97903e6A0Ea1AfF3923302445298f' as Address;

// ── the --onchain-uri legs of the setup multicall ──────────────────────────────
// THREE legs, not four: the param surface enumerates on-chain, so no deploy declares it. A fourth
// leg reappearing here means the retired `params.keys` convention crept back in.

test('onchainUriSetupCalls: animation field (renderer rep, abi.encode(generator)) + both URI renderers, in order', () => {
  const calls = onchainUriSetupCalls({generator: GENERATOR, metadataRenderer: RENDERER});
  assert.equal(calls.length, 3);

  // leg 1 — the collection-scope animation_url field: representation `renderer`, value
  // abi.encode(address generator) (32 bytes, address right-aligned) — the exact shape
  // AbxMetadataRenderer abi.decodes before staticcalling render(token, id, field).
  const d0 = decodeFunctionData({abi: seriesCodeAbi, data: calls[0]});
  assert.equal(d0.functionName, 'setContractField');
  assert.equal(d0.args![0], encodeTag(F.animationUrl)); // bytes32("animation_url") — the renderer's constant
  assert.equal(d0.args![1], encodeTag(R.renderer));
  assert.equal(d0.args![2], `0x${'0'.repeat(24)}${GENERATOR.slice(2).toLowerCase()}`);

  // legs 2+3 — the URI toggles flip ON-CHAIN resolution as the LAST config legs (before mints)
  const d1 = decodeFunctionData({abi: seriesCodeAbi, data: calls[1]});
  assert.equal(d1.functionName, 'setTokenURIRenderer');
  assert.deepEqual(d1.args, [RENDERER]);
  const d2 = decodeFunctionData({abi: seriesCodeAbi, data: calls[2]});
  assert.equal(d2.functionName, 'setContractURIRenderer');
  assert.deepEqual(d2.args, [RENDERER]);

  // no param leg at all — nothing writes a key list any more
  for (const c of calls) {
    assert.notEqual(decodeFunctionData({abi: seriesCodeAbi, data: c}).functionName, 'setContractParam');
    assert.notEqual(decodeFunctionData({abi: seriesCodeAbi, data: c}).functionName, 'setContractParamData');
  }
});

test('onchainUriSetupCalls: a renderer-only drop (zero generator) emits the two URI legs only', () => {
  const calls = onchainUriSetupCalls({generator: zeroAddress as Address, metadataRenderer: RENDERER});
  assert.equal(calls.length, 2);
  assert.equal(decodeFunctionData({abi: seriesCodeAbi, data: calls[0]}).functionName, 'setTokenURIRenderer');
});

// ── the param surface, enumerated FROM CHAIN ──────────────────────────────────

test('readSetParamKeys: contract scope alone, or both scopes when a token is named', async () => {
  const seen: string[] = [];
  const client = {
    readContract: async (req: {functionName: string; args: readonly unknown[]}) => {
      seen.push(req.functionName);
      if (req.functionName === 'contractParamKeys') return [encodeTag('display.animation')];
      if (req.functionName === 'tokenParamKeys') return [encodeTag('palette'), encodeTag('density')];
      throw new Error(`unexpected read ${req.functionName}`);
    },
  };
  assert.deepEqual(await readSetParamKeys(client, TOKEN), {contract: ['display.animation'], token: []});
  assert.deepEqual(seen, ['contractParamKeys']); // no token read when no token is named

  assert.deepEqual(await readSetParamKeys(client, TOKEN, 0n), {
    contract: ['display.animation'],
    token: ['palette', 'density'],
  });
});

test('readSetParamKeys / readParamSchemaKeys / hasParamEnumeration: a legacy impl (getter absent) reports honestly', async () => {
  const legacy = {
    readContract: async () => {
      throw Object.assign(new Error('execution reverted'), {name: 'ContractFunctionExecutionError'});
    },
  };
  assert.equal(await readSetParamKeys(legacy, TOKEN), null);
  assert.equal(await readParamSchemaKeys(legacy, TOKEN), null);
  assert.equal(await hasParamEnumeration(legacy, TOKEN), false);
});

test('readParamSchemaKeys: the declared (append-only) key set, decoded from bytes32', async () => {
  const client = {
    readContract: async (req: {functionName: string}) => {
      assert.equal(req.functionName, 'paramSchemaKeys');
      return [encodeTag('palette'), encodeTag('density')];
    },
  };
  assert.deepEqual(await readParamSchemaKeys(client, TOKEN), ['palette', 'density']);
});

test('hasParamEnumeration: a token exposing tokenParamKeys passes the repoint probe', async () => {
  const modern = {
    readContract: async (req: {functionName: string; args: readonly unknown[]}) => {
      assert.equal(req.functionName, 'tokenParamKeys');
      assert.deepEqual(req.args, [0n]);
      return [];
    },
  };
  assert.equal(await hasParamEnumeration(modern, TOKEN), true); // an EMPTY list is still enumeration
});

// ── the deploy-time chain-complete expectation (from the P1 dependency report) ──

async function checksFor(specs: string[], details: Record<string, unknown[]>): Promise<DepCheck[]> {
  const client = {
    readContract: async (req: {args: unknown[]}) => {
      const hex = req.args[0] as string;
      const name = Buffer.from(hex.slice(2), 'hex').toString('utf8').replace(/\0+$/, '');
      const d = details[name];
      if (!d) throw Object.assign(new Error('execution reverted'), {name: 'ContractFunctionExecutionError'});
      return d;
    },
  };
  const {checks} = await checkRegistryDeps(client, '0x5Fcc415BCFb164C5F826B5305274749BeB684e9b', specs.map(parseDependencyRef));
  return checks;
}

const ONCHAIN_REC = (name: string) => [name, 'LGPL', 'https://cdn.example/x.js', 0, '', 0, '', true, 2];
const CDN_REC = (name: string) => [name, 'LGPL', 'https://cdn.example/x.js', 0, '', 0, '', false, 0];

test('expectedChainComplete: no deps / all-on-chain deps ⇒ expected; CDN or missing ⇒ not; skipped ⇒ unknown', async () => {
  assert.equal(expectedChainComplete([], []).expected, true);
  // OnChain-ref deps never touch the registry — still an on-chain graph
  assert.equal(expectedChainComplete(['0x000000000000000000000000000000000000cafe'].map(parseDependencyRef), []).expected, true);

  const onchain = await checksFor(['p5@1.0.0'], {'p5@1.0.0': ONCHAIN_REC('p5@1.0.0')});
  assert.equal(expectedChainComplete(['p5@1.0.0'].map(parseDependencyRef), onchain).expected, true);

  const cdn = await checksFor(['three@0.124.0'], {'three@0.124.0': CDN_REC('three@0.124.0')});
  const cdnRes = expectedChainComplete(['three@0.124.0'].map(parseDependencyRef), cdn);
  assert.equal(cdnRes.expected, false);
  assert.match(cdnRes.detail, /CDN-served/);

  const missing = await checksFor(['nope@9.9.9'], {});
  const missRes = expectedChainComplete(['nope@9.9.9'].map(parseDependencyRef), missing);
  assert.equal(missRes.expected, false);
  assert.match(missRes.detail, /not on the registry/);

  // no checks at all (registry check skipped) → honestly unknown, verify decides from chain
  const unknown = expectedChainComplete(['p5@1.0.0'].map(parseDependencyRef), []);
  assert.equal(unknown.expected, null);
});

// ── verify: the mocked-client onChainStatus + tokenURI report ──────────────────

function stateFixture(over: Partial<ProjectState> = {}): ProjectState {
  return {
    address: TOKEN,
    chainId: 11155111,
    tokenURIRenderer: RENDERER,
    collectionFields: [
      {field: F.animationUrl, representation: R.renderer, value: `0x${'0'.repeat(24)}${GENERATOR.slice(2).toLowerCase()}` as Hex},
    ],
    tokens: [{tokenId: '0', lifecycle: 'live', owner: null, tokenURI: null, fields: [], lockedFields: []}],
    ...over,
  } as unknown as ProjectState;
}

const jsonDataUri = (obj: Record<string, unknown>): string =>
  `data:application/json;base64,${Buffer.from(JSON.stringify(obj)).toString('base64')}`;

function mockClient(status: unknown[], tokenUri: string | ((id: bigint) => string)) {
  const calls: string[] = [];
  return {
    calls,
    readContract: async (req: {address: Address; functionName: string; args: readonly unknown[]}) => {
      calls.push(`${req.functionName}(${req.args.join(',')})`);
      if (req.functionName === 'onChainStatus') return status;
      if (req.functionName === 'tokenURI') return typeof tokenUri === 'string' ? tokenUri : tokenUri(req.args[0] as bigint);
      throw new Error(`unexpected read ${req.functionName}`);
    },
  };
}

test('onChainUriReport: template branch — chain-complete, tokenURI on-chain, animation is inline data:text/html', async () => {
  const html = '<!doctype html><html><body><script>draw()</script></body></html>';
  const client = mockClient(
    [1, true, [], false],
    jsonDataUri({name: 'X #0', image: 'x', animation_url: `data:text/html;base64,${Buffer.from(html).toString('base64')}`}),
  );
  const report = await onChainUriReport(client, stateFixture());
  assert.equal(report.generator.toLowerCase(), GENERATOR.toLowerCase()); // decoded from the animation field's renderer value
  assert.equal(report.status.branchName, 'template');
  assert.equal(report.status.chainComplete, true);
  assert.deepEqual(report.status.unresolvedRefs, []);
  assert.equal(report.probe?.tokenId, '0');
  assert.equal(report.probe?.onChainJson, true);
  assert.deepEqual(report.probe?.animation, {form: 'data-html', bytes: Buffer.byteLength(html), marker: null});
});

test('onChainUriReport: template branch with unresolved refs — bytes32 tags decode to readable names; the marker is surfaced', async () => {
  const html = '<html><!-- abx:unresolved p5@1.0.0 --></html>';
  const client = mockClient(
    [1, false, [encodeTag('p5@1.0.0'), encodeTag('three@0.124.0')], false],
    jsonDataUri({name: 'X', image: 'x', animation_url: `data:text/html;base64,${Buffer.from(html).toString('base64')}`}),
  );
  const report = await onChainUriReport(client, stateFixture());
  assert.equal(report.status.chainComplete, false);
  assert.deepEqual(report.status.unresolvedRefs, ['p5@1.0.0', 'three@0.124.0']);
  const a = report.probe?.animation;
  assert.equal(a?.form, 'data-html');
  assert.equal(a?.form === 'data-html' && a.marker, '<!-- abx:unresolved p5@1.0.0 -->');
});

test('onChainUriReport: directory branch — animation_url is the raw gateway URL; urlOverBudget reported', async () => {
  const url = 'https://ipfs.io/ipfs/QmXyz/index.html?abx=eyJjaGFpbklkIjoxfQ';
  const client = mockClient([2, false, [], true], jsonDataUri({name: 'X', image: 'x', animation_url: url}));
  const report = await onChainUriReport(client, stateFixture());
  assert.equal(report.status.branchName, 'directory');
  assert.equal(report.status.urlOverBudget, true);
  assert.deepEqual(report.probe?.animation, {form: 'url', url});
});

test('onChainUriReport: none branch + nothing minted — status still reads; the tokenURI probe is skipped', async () => {
  const client = mockClient([0, false, [], false], () => {
    throw new Error('tokenURI must not be called with nothing minted');
  });
  const report = await onChainUriReport(
    client,
    stateFixture({tokens: [{tokenId: '0', lifecycle: 'unminted', owner: null, tokenURI: null, fields: [], lockedFields: []}]} as Partial<ProjectState>),
  );
  assert.equal(report.status.branchName, 'none');
  assert.equal(report.probe, null);
  assert.deepEqual(client.calls, [`onChainStatus(${TOKEN})`]); // exactly one read
});

test('onChainUriReport: probes the LOWEST minted token, and flags a non-data tokenURI honestly', async () => {
  const client = mockClient([1, true, [], false], (id) => `https://resolver.example/t/11155111/${TOKEN}/${id}`);
  const report = await onChainUriReport(
    client,
    stateFixture({
      tokens: [
        {tokenId: '3', lifecycle: 'live', owner: null, tokenURI: null, fields: [], lockedFields: []},
        {tokenId: '1', lifecycle: 'live', owner: null, tokenURI: null, fields: [], lockedFields: []},
        {tokenId: '0', lifecycle: 'unminted', owner: null, tokenURI: null, fields: [], lockedFields: []},
      ],
    } as Partial<ProjectState>),
  );
  assert.equal(report.probe?.tokenId, '1');
  assert.equal(report.probe?.onChainJson, false);
  assert.match(report.probe!.uriPrefix, /^https:\/\/resolver\.example/);
});

test('generatorFor + hasOnChainUriLane: the animation field wins; renderer-toggle alone still counts; plain projects do not', () => {
  // the field's decoded address is what the metadata renderer actually staticcalls — it wins over the manifest
  const OTHER = '0x00000000000000000000000000000000deadbeef' as Address;
  const withField = stateFixture({
    collectionFields: [{field: F.animationUrl, representation: R.renderer, value: `0x${'0'.repeat(24)}${OTHER.slice(2)}` as Hex}],
  } as Partial<ProjectState>);
  assert.equal(generatorFor(withField)?.toLowerCase(), OTHER.toLowerCase());
  assert.equal(hasOnChainUriLane(withField), true);

  // tokenURIRenderer set, no animation field → the lane is on; the generator falls back to the manifest
  const toggleOnly = stateFixture({collectionFields: []} as Partial<ProjectState>);
  assert.equal(hasOnChainUriLane(toggleOnly), true);
  assert.equal(generatorFor(toggleOnly)?.toLowerCase(), GENERATOR.toLowerCase());

  // neither → not on the lane
  const plain = stateFixture({collectionFields: [], tokenURIRenderer: null} as Partial<ProjectState>);
  assert.equal(hasOnChainUriLane(plain), false);
  const zeroed = stateFixture({collectionFields: [], tokenURIRenderer: zeroAddress} as Partial<ProjectState>);
  assert.equal(hasOnChainUriLane(zeroed), false);
});

// ── the accessor split: `tokenURI(id)` on a 721, `uri(id)` on an ERC-1155 edition ──────────────
//
// Regression: the probe hardcoded the ERC-721 `tokenURI` selector. An edition exposes `uri(id)` and
// has no `tokenURI`, so the read REVERTED for every edition — `abx verify` printed "on-chain URI
// check unavailable" plus a raw multi-line viem dump, and could never confirm that a fully-on-chain
// edition actually resolved. `reconstruct.ts` already switched on the same discriminator; this path
// was simply missed when the 1155 lane shipped.

/** Serves BOTH accessors but records which was asked for, so the test pins the selector choice. */
function dualAccessorClient(status: unknown[], uriValue: string) {
  const asked: string[] = [];
  return {
    asked,
    readContract: async (req: {functionName: string; args: readonly unknown[]}) => {
      asked.push(req.functionName);
      if (req.functionName === 'onChainStatus') return status;
      if (req.functionName === 'tokenURI' || req.functionName === 'uri') return uriValue;
      throw new Error(`unexpected read ${req.functionName}`);
    },
  };
}

for (const contractType of ['1of1-edition', 'edition', 'edition-code'] as const) {
  test(`onChainUriReport: a ${contractType} is probed with uri(id), never tokenURI(id)`, async () => {
    const client = dualAccessorClient([1, true, [], false], jsonDataUri({name: 'X #0', image: 'x'}));
    const report = await onChainUriReport(client, stateFixture({contractType} as Partial<ProjectState>));
    assert.ok(client.asked.includes('uri'), `expected a uri(id) read for ${contractType}, got: ${client.asked.join(', ')}`);
    assert.ok(!client.asked.includes('tokenURI'), `${contractType} must not be probed with the 721 tokenURI selector`);
    assert.equal(report.probe?.accessor, 'uri'); // readouts quote this, so an edition is never described in 721 terms
    assert.equal(report.probe?.onChainJson, true);
  });
}

for (const contractType of ['1of1', 'series', 'code'] as const) {
  test(`onChainUriReport: a ${contractType} keeps the 721 tokenURI(id) probe`, async () => {
    const client = dualAccessorClient([1, true, [], false], jsonDataUri({name: 'X #0', image: 'x'}));
    const report = await onChainUriReport(client, stateFixture({contractType} as Partial<ProjectState>));
    assert.ok(client.asked.includes('tokenURI'), `expected a tokenURI(id) read for ${contractType}`);
    assert.ok(!client.asked.includes('uri'));
    assert.equal(report.probe?.accessor, 'tokenURI');
  });
}

test('onChainUriReport: an absent contractType falls back to the 721 accessor (unchanged behavior)', async () => {
  const client = dualAccessorClient([1, true, [], false], jsonDataUri({name: 'X #0', image: 'x'}));
  const report = await onChainUriReport(client, stateFixture());
  assert.equal(report.probe?.accessor, 'tokenURI');
});
