import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData} from 'viem';
import {
  prepareSeriesMint,
  prepareSeriesMintMany,
  prepareSetMinter,
  prepareSetMaxInvocations,
  prepareSetPrimaryPayee,
  prepareSetPaused,
} from '../src/ops.ts';
import {seriesImageAbi} from '../src/abi/index.ts';

const TOKEN = '0x1111111111111111111111111111111111111111' as const;
const TO = '0x2222222222222222222222222222222222222222' as const;
const CHAIN = 11155111;

// Sequential minting only (a token's metadata is its token id). Decode the calldata and
// assert the exact function + args.

test('prepareSeriesMint: mint(address) in-order lane', () => {
  const tx = prepareSeriesMint({contract: TOKEN, to: TO, chainId: CHAIN});
  const {functionName, args} = decodeFunctionData({abi: seriesImageAbi, data: tx.data});
  assert.equal(functionName, 'mint');
  assert.deepEqual(args, [TO]);
  assert.equal(tx.to, TOKEN);
});

test('prepareSeriesMintMany: count → mintMany(address,uint256)', () => {
  const tx = prepareSeriesMintMany({contract: TOKEN, to: TO, count: 3, chainId: CHAIN});
  const {functionName, args} = decodeFunctionData({abi: seriesImageAbi, data: tx.data});
  assert.equal(functionName, 'mintMany');
  assert.deepEqual(args, [TO, 3n]);
});

test('prepareSetMinter / prepareSetMaxInvocations / prepareSetPrimaryPayee encode their fns', () => {
  const setMinter = prepareSetMinter({contract: TOKEN, minter: TO, chainId: CHAIN});
  const md = decodeFunctionData({abi: seriesImageAbi, data: setMinter.data});
  assert.equal(md.functionName, 'setMinter');
  assert.deepEqual(md.args, [TO]);

  const cap = prepareSetMaxInvocations({contract: TOKEN, maxInvocations: 50, chainId: CHAIN});
  const capDecoded = decodeFunctionData({abi: seriesImageAbi, data: cap.data});
  assert.equal(capDecoded.functionName, 'setMaxInvocations');
  assert.deepEqual(capDecoded.args, [50n]);

  const payee = prepareSetPrimaryPayee({contract: TOKEN, payee: TO, chainId: CHAIN});
  assert.equal(decodeFunctionData({abi: seriesImageAbi, data: payee.data}).functionName, 'setPrimaryPayee');

  const pause = prepareSetPaused({contract: TOKEN, paused: true, chainId: CHAIN});
  const pd = decodeFunctionData({abi: seriesImageAbi, data: pause.data});
  assert.equal(pd.functionName, 'setPaused');
  assert.deepEqual(pd.args, [true]);
});
