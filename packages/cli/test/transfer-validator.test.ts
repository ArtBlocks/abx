// ERC-721C flag/arg grammar — the shared parse behind `--721c` (deploy) and
// `abx set-transfer-validator` (owner op). Membrane rule: enforce, don't warn — every bad
// combination below is a REFUSAL with the way out named, never a warning that proceeds.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getAddress, zeroAddress} from 'viem';
import {parseTransferValidatorValue} from '../src/ownerops.js';
import {resolveRecommendedTransferValidator} from '@artblocks/abx-sdk';

const SEPOLIA = {chainId: 11155111, chainLabel: 'sepolia'};
const BASE_SEPOLIA = {chainId: 84532, chainLabel: 'base-sepolia'};
const UNSHIPPED = {chainId: 8453, chainLabel: 'base'};

test('recommended (and a bare --721c, which parses as "true") resolve the per-chain constant', () => {
  const rec = resolveRecommendedTransferValidator(SEPOLIA.chainId)!;
  assert.ok(rec);
  assert.equal(parseTransferValidatorValue('recommended', SEPOLIA), rec);
  assert.equal(parseTransferValidatorValue('Recommended', SEPOLIA), rec); // case-insensitive
  assert.equal(parseTransferValidatorValue('true', SEPOLIA), rec); // bare `--721c`
  assert.equal(parseTransferValidatorValue('recommended', BASE_SEPOLIA), resolveRecommendedTransferValidator(BASE_SEPOLIA.chainId));
});

test('recommended on a chain with no entry: refused, naming the chains that have one', () => {
  assert.throws(
    () => parseTransferValidatorValue('recommended', UNSHIPPED),
    (e: Error) => {
      assert.match(e.message, /no recommended transfer validator .* 'base'/);
      assert.match(e.message, /sepolia/); // names at least one chain that DOES have an entry
      assert.match(e.message, /explicit validator address/); // …and the way out
      return true;
    },
  );
});

test('an explicit address is EIP-55 checksum-validated and canonicalized', () => {
  const lower = '0xa000027a9b2802e1ddf7000061001e5c005a0000';
  assert.equal(parseTransferValidatorValue(lower, SEPOLIA), getAddress(lower)); // all-lowercase OK → checksummed
  // mixed case with a WRONG checksum is a refusal (a mis-pasted validator must never enroll)
  assert.throws(() => parseTransferValidatorValue('0xA000027a9B2802E1ddf7000061001e5c005A0000', SEPOLIA), /checksum/);
  assert.throws(() => parseTransferValidatorValue('0xnope', SEPOLIA), /0x address/);
  assert.throws(() => parseTransferValidatorValue('opensea', SEPOLIA), /0x address/);
});

test('zero/none at DEPLOY is refused — plain ERC-721 is already the default', () => {
  for (const z of ['none', '0', '0x0', zeroAddress]) {
    assert.throws(
      () => parseTransferValidatorValue(z, SEPOLIA),
      (e: Error) => {
        assert.match(e.message, /never enrolls/);
        assert.match(e.message, /drop --721c/); // the fix is to not pass the flag
        return true;
      },
      `expected deploy-side "${z}" to be refused`,
    );
  }
});

test('zero/none for the OWNER OP is the suspend verb (allowNone)', () => {
  for (const z of ['none', 'zero', '0', '0x0', zeroAddress]) {
    assert.equal(parseTransferValidatorValue(z, {...SEPOLIA, allowNone: true}), zeroAddress, `"${z}" should suspend`);
  }
});
