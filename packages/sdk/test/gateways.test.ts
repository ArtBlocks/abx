// Gateway behavior is split into a pure resolver (`resolveGatewayBase`) and a separate
// env-reading piece (`gatewayConfigFromEnv`). Storage's own `resolveGatewayBase` (override → env
// → default) now composes these two — see packages/storage/test/readiness.test.ts for coverage
// of that composed behavior; this file covers the two SDK pieces independently.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gatewayConfigFromEnv, gatewayUrlFor, resolveGatewayBase} from '../src/gateways.ts';

test('resolveGatewayBase: pure — no env read, ever', () => {
  const prevIpfs = process.env.ABX_IPFS_GATEWAY;
  const prevAr = process.env.ABX_ARWEAVE_GATEWAY;
  process.env.ABX_IPFS_GATEWAY = 'https://env-set.example';
  process.env.ABX_ARWEAVE_GATEWAY = 'https://env-set-ar.example';
  try {
    // even with env vars set, the pure resolver never reads them — only `overrides` and the default matter.
    assert.equal(resolveGatewayBase('ipfs'), 'https://ipfs.io');
    assert.equal(resolveGatewayBase('arweave'), 'https://arweave.net');
    assert.equal(resolveGatewayBase('ipfs', {ipfs: 'https://my.gw'}), 'https://my.gw');
    assert.equal(resolveGatewayBase('arweave', {arweave: 'https://my-ar.gw'}), 'https://my-ar.gw');
  } finally {
    if (prevIpfs === undefined) delete process.env.ABX_IPFS_GATEWAY;
    else process.env.ABX_IPFS_GATEWAY = prevIpfs;
    if (prevAr === undefined) delete process.env.ABX_ARWEAVE_GATEWAY;
    else process.env.ABX_ARWEAVE_GATEWAY = prevAr;
  }
});

test('resolveGatewayBase: an unrecognised network (e.g. "http", which carries its own base) resolves to empty', () => {
  assert.equal(resolveGatewayBase('http'), '');
  assert.equal(resolveGatewayBase('something-else'), '');
});

test('gatewayConfigFromEnv: reads ABX_IPFS_GATEWAY/ABX_ARWEAVE_GATEWAY, omitting unset ones', () => {
  const prevIpfs = process.env.ABX_IPFS_GATEWAY;
  const prevAr = process.env.ABX_ARWEAVE_GATEWAY;
  delete process.env.ABX_IPFS_GATEWAY;
  delete process.env.ABX_ARWEAVE_GATEWAY;
  try {
    assert.deepEqual(gatewayConfigFromEnv(), {});
    process.env.ABX_IPFS_GATEWAY = 'https://my-ipfs.example';
    assert.deepEqual(gatewayConfigFromEnv(), {ipfs: 'https://my-ipfs.example'});
    process.env.ABX_ARWEAVE_GATEWAY = 'https://my-arweave.example';
    assert.deepEqual(gatewayConfigFromEnv(), {ipfs: 'https://my-ipfs.example', arweave: 'https://my-arweave.example'});
  } finally {
    if (prevIpfs === undefined) delete process.env.ABX_IPFS_GATEWAY;
    else process.env.ABX_IPFS_GATEWAY = prevIpfs;
    if (prevAr === undefined) delete process.env.ABX_ARWEAVE_GATEWAY;
    else process.env.ABX_ARWEAVE_GATEWAY = prevAr;
  }
});

test('resolveGatewayBase + gatewayConfigFromEnv compose to override → env → default', () => {
  const prevIpfs = process.env.ABX_IPFS_GATEWAY;
  process.env.ABX_IPFS_GATEWAY = 'https://env.example';
  try {
    assert.equal(resolveGatewayBase('ipfs', gatewayConfigFromEnv()), 'https://env.example');
    assert.equal(resolveGatewayBase('ipfs', {ipfs: 'https://override.example'}), 'https://override.example');
  } finally {
    if (prevIpfs === undefined) delete process.env.ABX_IPFS_GATEWAY;
    else process.env.ABX_IPFS_GATEWAY = prevIpfs;
  }
});

test('gatewayUrlFor: ipfs gets /ipfs/, arweave gets the bare path, an absolute URL is untouched', () => {
  const CID = 'bafybeiephmsx65ezq3mqxhkcrjsadgeipvg4bsb5ngenbxognechc32qaq';
  const TXID = 'lZQ9gm4EPPKCkxLLuvKMLPBpxUtHkzHqRTdyEBQBgYs';
  assert.equal(gatewayUrlFor('ipfs', CID, 'https://ipfs.io/'), `https://ipfs.io/ipfs/${CID}`);
  assert.equal(gatewayUrlFor('arweave', TXID, 'https://arweave.net'), `https://arweave.net/${TXID}`);
  // Rewriting a URL someone handed us would answer a question they didn't ask.
  assert.equal(gatewayUrlFor('arweave', 'https://custom.gw/x', 'https://arweave.net'), 'https://custom.gw/x');
});

// ── the on-chain projection (spec v11) ───────────────────────────────────────
//
// These four functions are the off-chain half of a pair whose whole value is that both halves agree:
// `AbxMetadataRenderer._gatewayUrl`/`_gatewayPrefix` and `AbxGenerator._gateway` implement the same
// rules in Solidity, and a token served by the chain and by a resolver must produce the same URL.
// Any change here without the matching Solidity change (or the reverse) is the sibling drift this
// repo has been bitten by before — see contracts/test/AbxMetadataRenderer.t.sol's v11 block.
import {
  contentIdFromLocator,
  gatewayPrefixFrom,
  projectGatewayPrefix,
  projectGatewayUrl,
} from '../src/gateways.ts';
// The floors and the two reserved field keys live with the rest of the on-chain vocabulary, in
// `spine.ts` — they are what the CONTRACTS name, not host configuration.
import {GATEWAY_FLOOR} from '../src/spine.ts';
import {stringToHex} from 'viem';

const inlineField = (field: string, value: string) => ({field, representation: 'inline', value: stringToHex(value)});
const state = (...fields: ReturnType<typeof inlineField>[]) => ({collectionFields: fields}) as never;

test('projectGatewayUrl: bare id, scheme-prefixed id, and {id} all reach the same shape', () => {
  assert.equal(projectGatewayUrl('ipfs', 'QmCid', GATEWAY_FLOOR.ipfs), 'https://ipfs.io/ipfs/QmCid');
  assert.equal(projectGatewayUrl('ipfs', 'ipfs://QmCid', GATEWAY_FLOOR.ipfs), 'https://ipfs.io/ipfs/QmCid');
  assert.equal(projectGatewayUrl('arweave', 'ar://TX', GATEWAY_FLOOR.arweave), 'https://arweave.net/TX');
  // one collection-scope field → a whole pinned directory (the O(1) series pattern)
  assert.equal(projectGatewayUrl('ipfs', 'QmDir/{id}.png', GATEWAY_FLOOR.ipfs, '7'), 'https://ipfs.io/ipfs/QmDir/7.png');
  // no tokenId (the collection surface) leaves the placeholder alone, as `url-template` does
  assert.equal(projectGatewayUrl('ipfs', 'QmDir/{id}.png', GATEWAY_FLOOR.ipfs), 'https://ipfs.io/ipfs/QmDir/{id}.png');
});

test('projectGatewayUrl: an absolute value is never re-prefixed, and a scheme-only value locates nothing', () => {
  // exactly what a `backend.locator()` return looks like — the double-prefix bug this guards
  assert.equal(
    projectGatewayUrl('arweave', 'https://arweave.net/TX', GATEWAY_FLOOR.arweave),
    'https://arweave.net/TX',
  );
  assert.equal(projectGatewayUrl('ipfs', 'ipfs://', GATEWAY_FLOOR.ipfs), null);
  assert.equal(projectGatewayUrl('arweave', '', GATEWAY_FLOOR.arweave), null);
});

test('projectGatewayPrefix: on-chain preference wins; env is a floor; only `inline` counts', () => {
  const env = {ipfs: 'https://host.gw', arweave: 'https://ar.host.gw'};
  // nothing stated anywhere → the public floor
  assert.equal(projectGatewayPrefix(state(), 'ipfs'), GATEWAY_FLOOR.ipfs);
  // host config fills a silence
  assert.equal(projectGatewayPrefix(state(), 'ipfs', env), 'https://host.gw/ipfs/');
  // …but never overrides a project that stated one: two conforming resolvers must agree
  const stated = state(inlineField('abx_gateway_ipfs', 'https://stated.example/ipfs/'));
  assert.equal(projectGatewayPrefix(stated, 'ipfs', env), 'https://stated.example/ipfs/');
  // per scheme, so an ipfs preference never reaches arweave
  assert.equal(projectGatewayPrefix(stated, 'arweave', env), 'https://ar.host.gw/');
  // a non-`inline` value reads as "no preference stated", matching the renderer and the generator
  const wrongRep = {collectionFields: [{field: 'abx_gateway_ipfs', representation: 'url', value: stringToHex('https://x/')}]} as never;
  assert.equal(projectGatewayPrefix(wrongRep, 'ipfs'), GATEWAY_FLOOR.ipfs);
});

test('gatewayPrefixFrom: a host-shaped value becomes a full prefix; an already-full one is left alone', () => {
  assert.equal(gatewayPrefixFrom('ipfs', 'https://my.gw'), 'https://my.gw/ipfs/');
  assert.equal(gatewayPrefixFrom('ipfs', 'https://my.gw/'), 'https://my.gw/ipfs/');
  assert.equal(gatewayPrefixFrom('ipfs', 'https://my.gw/ipfs/'), 'https://my.gw/ipfs/');
  assert.equal(gatewayPrefixFrom('arweave', 'https://ar.gw'), 'https://ar.gw/');
  assert.equal(gatewayPrefixFrom('ipfs', ''), GATEWAY_FLOOR.ipfs);
});

test('contentIdFromLocator: recovers identity from every form a backend hands back', () => {
  // what `IpfsBackend.locator()` / `putDirectory()` actually return
  assert.equal(contentIdFromLocator('ipfs', 'https://gateway.pinata.cloud/ipfs/QmCid'), 'QmCid');
  assert.equal(contentIdFromLocator('ipfs', 'https://gw/ipfs/QmDir/{id}.png'), 'QmDir/{id}.png');
  assert.equal(contentIdFromLocator('arweave', 'https://arweave.net/TX'), 'TX');
  assert.equal(contentIdFromLocator('arweave', 'https://arweave.net/TXDIR/{id}.png'), 'TXDIR/{id}.png');
  // scheme forms and already-bare ids
  assert.equal(contentIdFromLocator('ipfs', 'ipfs://QmCid'), 'QmCid');
  assert.equal(contentIdFromLocator('arweave', 'ar://TX'), 'TX');
  assert.equal(contentIdFromLocator('ipfs', 'QmCid'), 'QmCid');
  // a subdomain gateway carries no recoverable id → null, so the caller keeps the URL and says so
  assert.equal(contentIdFromLocator('ipfs', 'https://QmCid.ipfs.dweb.link'), null);
  assert.equal(contentIdFromLocator('ipfs', ''), null);
});

test('round trip: what deploy commits is what a resolver serves', () => {
  // the exact sequence `--onchain-uri --backend ipfs` runs: upload → locator → strip → commit → serve
  const locator = 'https://gateway.pinata.cloud/ipfs/QmDir/{id}.png';
  const committed = contentIdFromLocator('ipfs', locator)!;
  assert.equal(committed, 'QmDir/{id}.png'); // NO gateway host on chain — that is the whole point
  assert.equal(
    projectGatewayUrl('ipfs', committed, projectGatewayPrefix(state(), 'ipfs'), '3'),
    'https://ipfs.io/ipfs/QmDir/3.png',
  );
  // …and a later repoint moves every token without the committed value changing
  const repointed = state(inlineField('abx_gateway_ipfs', 'https://fast.example/ipfs/'));
  assert.equal(
    projectGatewayUrl('ipfs', committed, projectGatewayPrefix(repointed, 'ipfs'), '3'),
    'https://fast.example/ipfs/QmDir/3.png',
  );
});
