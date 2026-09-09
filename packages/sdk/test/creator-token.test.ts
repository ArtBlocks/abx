import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData, zeroAddress, type PublicClient} from 'viem';
import {
  CREATOR_TOKEN_EXTENSION_ID,
  CREATOR_TOKEN_INTERFACE_ID,
  CREATOR_TOKEN_LEGACY_INTERFACE_ID,
  RECOMMENDED_TRANSFER_VALIDATOR,
  resolveRecommendedTransferValidator,
  prepareSetTransferValidator,
  probeTransferValidator,
} from '../src/creator-token.ts';
import {prepareDeployOneOfOne, prepareDeploySeries, prepareDeploySeriesCode} from '../src/ops.ts';
import {
  oneOfOneImageAbi,
  oneOfOneImageFactoryAbi,
  seriesImageFactoryAbi,
  seriesCodeFactoryAbi,
} from '../src/abi/index.ts';

const SEPOLIA = 11155111;
const BASE_SEPOLIA = 84532;
// OpenSea's StrictAuthorizedTransferSecurityRegistry.
const VALIDATOR = '0xA000027A9B2802E1ddf7000061001e5c005A0000';
const OWNER = '0x2222222222222222222222222222222222222222' as const;
const FACTORY = '0x3333333333333333333333333333333333333333' as const;
const CLONE = '0x4444444444444444444444444444444444444444' as const;
const SALT = `0x${'00'.repeat(32)}` as const;

// The manifest of recommended validators: both shipped chains carry OpenSea's Strict registry;
// an unshipped chain resolves to nothing (the CLI refuses `--721c recommended` there, naming
// the chains that have one — never guessing an address).
test('recommended transfer validator: shipped chains resolve, unshipped do not', () => {
  assert.equal(RECOMMENDED_TRANSFER_VALIDATOR[SEPOLIA], VALIDATOR);
  assert.equal(RECOMMENDED_TRANSFER_VALIDATOR[BASE_SEPOLIA], VALIDATOR);
  assert.equal(resolveRecommendedTransferValidator(SEPOLIA), VALIDATOR);
  assert.equal(resolveRecommendedTransferValidator(BASE_SEPOLIA), VALIDATOR);
  assert.equal(resolveRecommendedTransferValidator(8453), undefined);
});

// The identity constants marketplaces probe by. The interface ids come from ICreatorToken /
// ICreatorTokenLegacy; the extension id is keccak256("abx.extension.creator-token"). All three
// report true/1 ONLY on an enrolled token.
test('creator-token identity constants', () => {
  assert.equal(CREATOR_TOKEN_INTERFACE_ID, '0xad0d7f6c');
  assert.equal(CREATOR_TOKEN_LEGACY_INTERFACE_ID, '0xa07d229a');
  assert.equal(CREATOR_TOKEN_EXTENSION_ID, '0x0839e7ed7fc1f5db3f253851d61b10f852045c5520c2936138b121b73e7e27c0');
});

// The ABI-position invariant: `transferValidator` sits IMMEDIATELY AFTER `royaltyBps` in every
// factory's InitParams tuple. The SDK deploys from these encodings, so a drifted position would
// silently deploy misconfigured tokens — assert it against the generated ABI itself.
test('InitParams ABI: royaltyBps → maxRoyaltyBps → burnable → transferValidator on all three factories', () => {
  // Guards the field ordering the SDK's object-form encoding relies on.
  // the royalty cap (maxRoyaltyBps) and opt-in burn (burnable) sit between royaltyBps and the
  // transfer validator; viem matches tuple components by name, but this pins the intended shape.
  for (const abi of [oneOfOneImageFactoryAbi, seriesImageFactoryAbi, seriesCodeFactoryAbi]) {
    const deploy = (abi as readonly {type: string; name?: string; inputs?: unknown[]}[]).find(
      (i) => i.type === 'function' && i.name === 'deployDeterministic',
    ) as {inputs: [{components: {name: string}[]}]};
    const names = deploy.inputs[0].components.map((cm) => cm.name);
    const i = names.indexOf('royaltyBps');
    assert.equal(names[i + 1], 'maxRoyaltyBps');
    assert.equal(names[i + 2], 'burnable');
    assert.equal(names[i + 3], 'transferValidator');
  }
});

// Encode/decode round-trips for the three deploy preparers — the params object (with the new
// field set) must survive the tuple encoding at the exact ABI position.
test('deploy encodings carry transferValidator (1/1 · Series · SeriesCode)', () => {
  const shared = {
    name: 'T',
    symbol: 'T',
    tokenURIBase: '',
    tokenURIRenderer: zeroAddress,
    contractURIBase: '',
    contractURIRenderer: zeroAddress,
    royaltyReceiver: OWNER,
    royaltyBps: 500,
    maxRoyaltyBps: 1000,
    burnable: false,
    tokenFields: [],
    contractFields: [],
  } as const;

  const oneTx = prepareDeployOneOfOne({
    factory: FACTORY,
    params: {...shared, owner: OWNER, mintTo: zeroAddress, transferValidator: VALIDATOR},
    salt: SALT,
    chainId: SEPOLIA,
    clone: CLONE,
  });
  const one = decodeFunctionData({abi: oneOfOneImageFactoryAbi, data: oneTx.data});
  assert.equal(one.functionName, 'deployDeterministic');
  assert.equal((one.args[0] as {transferValidator: string}).transferValidator.toLowerCase(), VALIDATOR.toLowerCase());

  const seriesParams = {
    ...shared,
    owner: OWNER,
    transferValidator: zeroAddress, // plain ERC-721 — the default shape every call site bakes explicitly
    maxInvocations: 3n,
    primaryPayee: zeroAddress,
    minter: zeroAddress,
    paused: true,
    mintTo: zeroAddress,
    mintCount: 0n,
  };
  const seriesTx = prepareDeploySeries({factory: FACTORY, params: seriesParams, salt: SALT, chainId: SEPOLIA, clone: CLONE});
  const series = decodeFunctionData({abi: seriesImageFactoryAbi, data: seriesTx.data});
  assert.equal((series.args[0] as {transferValidator: string}).transferValidator, zeroAddress);
  assert.equal((series.args[0] as {royaltyBps: number}).royaltyBps, 500); // the neighbor decodes intact

  const codeTx = prepareDeploySeriesCode({
    factory: FACTORY,
    params: {...seriesParams, transferValidator: VALIDATOR, seedSource: zeroAddress, disableTokenOwnerDelegation: false},
    salt: SALT,
    chainId: SEPOLIA,
    clone: CLONE,
  });
  const code = decodeFunctionData({abi: seriesCodeFactoryAbi, data: codeTx.data});
  assert.equal((code.args[0] as {transferValidator: string}).transferValidator.toLowerCase(), VALIDATOR.toLowerCase());
});

// The owner-op wrapper: setTransferValidator(address), with the suspend case labeled honestly
// (zero suspends enforcement — the token STAYS enrolled; there is no un-enroll).
test('prepareSetTransferValidator encodes setTransferValidator; zero = suspend', () => {
  const point = prepareSetTransferValidator({contract: CLONE, validator: VALIDATOR as `0x${string}`, chainId: SEPOLIA});
  const decoded = decodeFunctionData({abi: oneOfOneImageAbi, data: point.data});
  assert.equal(decoded.functionName, 'setTransferValidator');
  assert.equal((decoded.args[0] as string).toLowerCase(), VALIDATOR.toLowerCase());
  assert.equal(point.to, CLONE);
  assert.equal(point.value, '0x0');

  const suspend = prepareSetTransferValidator({contract: CLONE, validator: zeroAddress, chainId: SEPOLIA});
  assert.deepEqual(decodeFunctionData({abi: oneOfOneImageAbi, data: suspend.data}).args, [zeroAddress]);
  assert.match(suspend.summary, /suspend/i);
  assert.match(suspend.summary, /stays enrolled/);
});


// ── probeTransferValidator — the guard that has-code could not be ─────────────
//
// `code.length > 0` is not enough, and the gap is not theoretical: `validateTransfer` returns
// nothing, so there is no ABI decode to fail, and any address whose fallback succeeds for an unknown
// selector passes a has-code check and then waves EVERY transfer through while ERC-165,
// `getTransferValidator()` and the extension beacon all report enforcement as on. A creator pasting
// their own Safe is the likely real case. So the probe asks a question no validator implements and
// requires it to FAIL — the same rule, and the same selector, as the contract's own guard.

/** A PublicClient stub: `getCode` answers `code`, `call` succeeds or throws `callThrows`. */
function validatorClient(opts: {code?: string; callThrows?: string; onCall?: (a: {to: string; data: string}) => void}): PublicClient {
  return {
    getCode: async () => {
      if (opts.code === 'THROW') throw new Error('fetch failed: ECONNREFUSED');
      return opts.code;
    },
    call: async (a: {to: string; data: string}) => {
      opts.onCall?.(a);
      if (opts.callThrows) throw new Error(opts.callThrows);
      return {data: '0x'};
    },
  } as unknown as PublicClient;
}

test('probe: a real validator REVERTS the bogus selector — that is the pass', async () => {
  let seen = '';
  const probe = await probeTransferValidator(
    validatorClient({
      code: '0x6080',
      callThrows: 'execution reverted (unknown selector)',
      onCall: (a) => {
        seen = a.data;
      },
    }),
    VALIDATOR as `0x${string}`,
  );
  assert.equal(probe.verdict, 'ok');
  // The exact selector the contract probes with. If these ever diverge, the CLI would accept an
  // address the chain refuses (or the reverse), which is the whole failure this closes.
  assert.equal(seen, '0xa9b1c2d3');
});

test('probe: no code — enforcement would read as ON and check nothing', async () => {
  for (const code of [undefined, '0x'] as const) {
    const probe = await probeTransferValidator(validatorClient({code}), VALIDATOR as `0x${string}`);
    assert.equal(probe.verdict, 'no-code', `code ${String(code)}`);
  }
});

test('probe: a permissive fallback (Safe / bare proxy / 7702 EOA) is REFUSED, not called no-code', async () => {
  // The direction that matters for the error message: this address plainly HAS code, so telling a
  // creator "no code on this chain" would be a false statement about their Safe.
  const probe = await probeTransferValidator(validatorClient({code: '0x6080'}), VALIDATOR as `0x${string}`);
  assert.equal(probe.verdict, 'permissive-fallback');
  assert.equal(probe.address, VALIDATOR);
});

test('probe: a node that will not answer is unreachable — never a pass', async () => {
  assert.equal((await probeTransferValidator(validatorClient({code: 'THROW'}), VALIDATOR as `0x${string}`)).verdict, 'unreachable');
  // A transport failure on the CALL leg must not be mistaken for the revert that means "ok".
  for (const msg of ['fetch failed', 'request timed out', 'socket hang up', 'HTTP request failed: status code 429']) {
    const probe = await probeTransferValidator(validatorClient({code: '0x6080', callThrows: msg}), VALIDATOR as `0x${string}`);
    assert.equal(probe.verdict, 'unreachable', msg);
  }
});
