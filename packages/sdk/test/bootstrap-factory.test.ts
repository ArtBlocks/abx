// Every ABX singleton — factories, libraries, renderer, minters, seed source — is deployed by CREATE2
// through the keyless proxy, so the transaction is a CALL to that proxy and NOT a contract creation.
// `receipt.contractAddress` is therefore **null by protocol** on every one of these sends, and the
// address has to be computed (`predict*`), which is the whole reason the addresses are canonical and
// identical across chains in the first place.
//
// Two of the six factory bootstraps (the two oldest, the ERC-721 image ones) kept reading the receipt
// after the deploy moved to CREATE2. The effect was nasty precisely because it was not a clean
// failure: the factory DID land, the throw came after, so `abx deploy --bootstrap-factory` on a fresh
// chain always failed on the first run and always "worked" on the second — which reads as flakiness,
// not as a bug, and which no unit test noticed because nothing exercised the bootstrap path. It also
// silently broke the mock-provider fixture the hosted-services eval rooms depend on.
//
// So this file pins the invariant two ways: behaviourally on the two functions that had the bug, and
// statically across the whole module, so a seventh factory added later cannot reintroduce it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import type {Address} from 'viem';
import {deployFactory, deploySeriesFactory} from '../src/deploy.js';
import {predictFactory, predictSeriesFactory, CREATE2_PROXY} from '../src/create2.js';

const DEPLOY_TS = resolve(dirname(fileURLToPath(import.meta.url)), '../src/deploy.ts');
const IMPLEMENTATION = '0x00000000000000000000000000000000000000ff' as Address;

/** A `send` that answers the way a real CREATE2-proxy send does: mined, successful, and carrying NO
 *  `contractAddress`, because the tx targeted the proxy rather than creating a contract. */
function create2Send() {
  const sent: {to: unknown}[] = [];
  const send = async (tx: {to?: unknown}) => {
    sent.push({to: tx.to});
    return {
      contractAddress: null,
      transactionHash: '0xfeed' as const,
      blockNumber: 1n,
      status: 'success' as const,
    } as never;
  };
  return {send, sent};
}

/** A public client that reports an empty chain (so library legs deploy) and a fixed implementation. */
const publicClient = {
  chain: {id: 11155111},
  getCode: async () => '0x',
  readContract: async () => IMPLEMENTATION,
} as never;

test('deployFactory returns the deterministic address, not the (null) receipt address', async () => {
  const {send, sent} = create2Send();
  const result = await deployFactory(send as never, publicClient);
  assert.equal(result.factory, predictFactory(), 'factory must be the CREATE2-predicted address');
  assert.equal(result.implementation, IMPLEMENTATION);
  // and every leg really did go through the keyless proxy — if one ever became a plain creation
  // (`to: null`), the address would go nonce-dependent and stop matching the manifest.
  assert.ok(sent.length > 0, 'expected at least the factory send');
  for (const tx of sent) assert.equal(tx.to, CREATE2_PROXY, 'every bootstrap leg is CREATE2 via the proxy');
});

test('deploySeriesFactory returns the deterministic address, not the (null) receipt address', async () => {
  const {send, sent} = create2Send();
  const result = await deploySeriesFactory(send as never, publicClient);
  assert.equal(result.factory, predictSeriesFactory(), 'series factory must be the CREATE2-predicted address');
  assert.equal(result.implementation, IMPLEMENTATION);
  for (const tx of sent) assert.equal(tx.to, CREATE2_PROXY, 'every bootstrap leg is CREATE2 via the proxy');
});

test('no bootstrap in deploy.ts derives an address from receipt.contractAddress', () => {
  const src = readFileSync(DEPLOY_TS, 'utf8');
  const offenders = src
    .split('\n')
    .map((line, i) => ({line: line.trim(), n: i + 1}))
    .filter(({line}) => /\breceipt\.contractAddress\b/.test(line) && !line.startsWith('//') && !line.startsWith('*'));
  assert.deepEqual(
    offenders,
    [],
    `every deploy here is CREATE2 through the proxy, so receipt.contractAddress is always null — ` +
      `compute the address with a predict*() helper instead. Offending line(s): ` +
      offenders.map((o) => `${o.n}: ${o.line}`).join(' · '),
  );
});
