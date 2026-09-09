// `detectTokenKind` (kind.ts) is the centralized replacement for the ad-hoc kind probes that used
// to live separately in commands/project.ts (`state`), commands/scaffold.ts
// (`assertMintableSeries`), and ownerops.ts (the set-param-hooks guard). Pure unit tests against a
// MOCKED client (no network) — one per concrete kind, exercising exactly the three probes
// (ERC-165 0xd9b67a26, maxInvocations(), paramHooks()) in the order detectTokenKind reads them.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Address, PublicClient} from 'viem';
import {detectTokenKind, describeKind, isEditionContract, assertHasParamsSurface} from '../src/kind.js';

type Resp = boolean | bigint | readonly [Address, Address, Address] | 'revert' | 'rpc-error';

function wrappedError(causeName: string, message: string): Error {
  const cause = Object.assign(new Error(message), {name: causeName});
  return Object.assign(new Error(`readContract failed: ${message}`), {
    name: 'ContractFunctionExecutionError',
    cause,
  });
}

/**
 * A minimal mock satisfying what detectTokenKind calls: `readContract({functionName})` and `getCode`.
 *
 * `code` models the existence precondition: a bytecode string (contract present), `'0x'` (nothing
 * deployed), `'throw'` (the RPC couldn't tell us), or omitted — omitted behaves like `'throw'`, i.e.
 * fail-open, which is why the per-kind tests below need no `code` argument at all.
 */
function mockClient(
  responses: {supportsInterface?: Resp; maxInvocations?: Resp; paramHooks?: Resp},
  code?: string | 'throw',
): PublicClient {
  const client = {
    readContract: async ({functionName}: {functionName: string}) => {
      const r = (responses as Record<string, Resp | undefined>)[functionName];
      if (r === undefined || r === 'revert') {
        throw wrappedError('ContractFunctionRevertedError', `${functionName}: reverted (no such getter on this mock)`);
      }
      if (r === 'rpc-error') throw wrappedError('HttpRequestError', `${functionName}: RPC unavailable`);
      return r;
    },
    getCode: async () => {
      if (code === undefined || code === 'throw') throw new Error('getCode unavailable on this mock');
      return code;
    },
    chain: {name: 'Base Sepolia'},
  };
  return client as unknown as PublicClient;
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Address;
const HOOKS = [ZERO_ADDR, ZERO_ADDR, ZERO_ADDR] as const;

test('detectTokenKind: 1of1 — no ERC-1155, no maxInvocations', async () => {
  const client = mockClient({supportsInterface: false, maxInvocations: 'revert'});
  const info = await detectTokenKind(client, ZERO_ADDR);
  assert.deepEqual(info, {kind: '1of1', isEdition: false, label: 'OneOfOneImage'});
});

test('detectTokenKind: series — no ERC-1155, has maxInvocations, no paramHooks', async () => {
  const client = mockClient({supportsInterface: false, maxInvocations: 16n, paramHooks: 'revert'});
  const info = await detectTokenKind(client, ZERO_ADDR);
  assert.deepEqual(info, {kind: 'series', isEdition: false, label: 'SeriesImage'});
});

test('detectTokenKind: code — no ERC-1155, has maxInvocations AND paramHooks', async () => {
  const client = mockClient({supportsInterface: false, maxInvocations: 16n, paramHooks: HOOKS});
  const info = await detectTokenKind(client, ZERO_ADDR);
  assert.deepEqual(info, {kind: 'code', isEdition: false, label: 'SeriesCode'});
});

test('detectTokenKind: 1of1-edition — ERC-1155, no maxInvocations (id space fixed to {0})', async () => {
  const client = mockClient({supportsInterface: true, maxInvocations: 'revert'});
  const info = await detectTokenKind(client, ZERO_ADDR);
  assert.deepEqual(info, {kind: '1of1-edition', isEdition: true, label: 'OneOfOneEdition'});
});

test('detectTokenKind: edition — ERC-1155, has maxInvocations, no paramHooks', async () => {
  const client = mockClient({supportsInterface: true, maxInvocations: 32n, paramHooks: 'revert'});
  const info = await detectTokenKind(client, ZERO_ADDR);
  assert.deepEqual(info, {kind: 'edition', isEdition: true, label: 'EditionImage'});
});

test('detectTokenKind: edition-code — ERC-1155, has maxInvocations AND paramHooks', async () => {
  const client = mockClient({supportsInterface: true, maxInvocations: 32n, paramHooks: HOOKS});
  const info = await detectTokenKind(client, ZERO_ADDR);
  assert.deepEqual(info, {kind: 'edition-code', isEdition: true, label: 'EditionCode'});
});

// This used to assert the OPPOSITE — that a no-code address "reads as 1of1" — which is precisely the
// bug: all three probes fail-closed, so the ladder's default made an EMPTY address indistinguishable
// from a real OneOfOneImage. `set-max-supply`/`minter buy` then told edition owners "…is a
// OneOfOneImage (721) — drop your edition flags" for a mistyped address or a wrong ABX_CHAIN.
test('detectTokenKind: an address with NO CODE is refused, never reported as a concrete type', async () => {
  const client = mockClient({supportsInterface: 'revert', maxInvocations: 'revert'}, '0x');
  await assert.rejects(() => detectTokenKind(client, ZERO_ADDR), /no contract at .* so there is no token type to read/);
});

test('detectTokenKind: the no-code refusal names the network, because a wrong chain is the usual cause', async () => {
  const client = mockClient({supportsInterface: 'revert'}, '0x');
  await assert.rejects(() => detectTokenKind(client, ZERO_ADDR), /ABX_CHAIN/);
});

// Fail OPEN, not closed: an RPC that can't answer `getCode` must never be turned into a "no contract"
// claim — we fall through to the probes exactly as before and let the caller's own error surface.
test('detectTokenKind: an unreadable getCode does NOT become a no-contract claim', async () => {
  const client = mockClient({supportsInterface: false, maxInvocations: 16n, paramHooks: 'revert'}, 'throw');
  const info = await detectTokenKind(client, ZERO_ADDR);
  assert.deepEqual(info, {kind: 'series', isEdition: false, label: 'SeriesImage'});
});

test('detectTokenKind: an RPC failure never becomes a false concrete kind', async () => {
  await assert.rejects(
    () => detectTokenKind(mockClient({supportsInterface: 'rpc-error'}), ZERO_ADDR),
    /RPC answered block\/code requests but failed eth_call.*not a contract verdict/,
  );
  await assert.rejects(
    () => detectTokenKind(mockClient({supportsInterface: false, maxInvocations: 'rpc-error'}), ZERO_ADDR),
    /RPC answered block\/code requests but failed eth_call.*not a contract verdict/,
  );
  await assert.rejects(
    () => detectTokenKind(mockClient({supportsInterface: false, maxInvocations: 16n, paramHooks: 'rpc-error'}), ZERO_ADDR),
    /RPC answered block\/code requests but failed eth_call.*not a contract verdict/,
  );
});

test('detectTokenKind: real code present → the probe ladder decides, unchanged', async () => {
  const client = mockClient({supportsInterface: true, maxInvocations: 16n, paramHooks: HOOKS}, '0x60806040');
  const info = await detectTokenKind(client, ZERO_ADDR);
  assert.deepEqual(info, {kind: 'edition-code', isEdition: true, label: 'EditionCode'});
});

test('isEditionContract: the single cheap ERC-165 probe, independent of the other two', async () => {
  assert.equal(await isEditionContract(mockClient({supportsInterface: true}), ZERO_ADDR), true);
  assert.equal(await isEditionContract(mockClient({supportsInterface: false}), ZERO_ADDR), false);
  assert.equal(await isEditionContract(mockClient({supportsInterface: 'revert'}), ZERO_ADDR), false);
});

test('describeKind: the shared one-line phrasing for a readout header', () => {
  assert.equal(describeKind({kind: '1of1', isEdition: false, label: 'OneOfOneImage'}), 'OneOfOneImage (1/1)');
  assert.equal(describeKind({kind: 'series', isEdition: false, label: 'SeriesImage'}), 'SeriesImage (series)');
  assert.equal(describeKind({kind: 'code', isEdition: false, label: 'SeriesCode'}), 'SeriesCode (code)');
  assert.equal(describeKind({kind: '1of1-edition', isEdition: true, label: 'OneOfOneEdition'}), 'OneOfOneEdition (edition)');
  assert.equal(describeKind({kind: 'edition', isEdition: true, label: 'EditionImage'}), 'EditionImage (edition)');
  assert.equal(describeKind({kind: 'edition-code', isEdition: true, label: 'EditionCode'}), 'EditionCode (edition-code)');
});

test('assertHasParamsSurface: a 1/1 is a capability mismatch, not a raw revert', async () => {
  const client = mockClient({supportsInterface: false, maxInvocations: 'revert'});
  await assert.rejects(
    () => assertHasParamsSurface(client, ZERO_ADDR, 'abx set-schema'),
    /exposes no PostParams.*SeriesCode\/EditionCode.*OneOfOneImage/,
  );
});

test('assertHasParamsSurface: SeriesCode is allowed', async () => {
  const client = mockClient({supportsInterface: false, maxInvocations: 16n, paramHooks: HOOKS});
  const info = await assertHasParamsSurface(client, ZERO_ADDR, 'abx set-schema');
  assert.equal(info.kind, 'code');
});
