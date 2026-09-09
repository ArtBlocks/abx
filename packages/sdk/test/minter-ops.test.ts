import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData, parseEther, zeroAddress} from 'viem';
import {prepareConfigureSale, preparePurchase, prepareDeployFixedPriceMinter} from '../src/ops.ts';
import {abxFixedPriceMinterAbi} from '../src/abi/index.ts';
import {ABX_SALT, CREATE2_PROXY, create2Calldata} from '../src/create2.ts';
import {abxFixedPriceMinterBytecode} from '../src/abi/index.ts';

const MINTER = '0x9999999999999999999999999999999999999999' as const;
const TOKEN = '0x1111111111111111111111111111111111111111' as const;
const TO = '0x2222222222222222222222222222222222222222' as const;
const ERC20 = '0x3333333333333333333333333333333333333333' as const;
const CHAIN = 11155111;

test('prepareConfigureSale: encodes configure(token, paymentToken, price, allocation); ETH default', () => {
  const tx = prepareConfigureSale({minter: MINTER, token: TOKEN, price: parseEther('0.1'), allocation: 5, chainId: CHAIN});
  const {functionName, args} = decodeFunctionData({abi: abxFixedPriceMinterAbi, data: tx.data});
  assert.equal(functionName, 'configure');
  assert.deepEqual(args, [TOKEN, zeroAddress, parseEther('0.1'), 5n]); // paymentToken defaults to ETH (0x0)
  assert.equal(tx.to, MINTER);
  assert.equal(tx.value, '0x0'); // configure is never payable
});

test('prepareConfigureSale: ERC-20 sale carries the token address', () => {
  const tx = prepareConfigureSale({minter: MINTER, token: TOKEN, paymentToken: ERC20, price: 1000n, allocation: 3, chainId: CHAIN});
  const {args} = decodeFunctionData({abi: abxFixedPriceMinterAbi, data: tx.data});
  assert.deepEqual(args, [TOKEN, ERC20, 1000n, 3n]);
});

test('preparePurchase: no recipient → purchase(token, terms); ETH value = price, from the terms read', () => {
  const tx = preparePurchase({minter: MINTER, token: TOKEN, sale: {paymentToken: zeroAddress, price: parseEther('0.1')}, chainId: CHAIN});
  const {functionName, args} = decodeFunctionData({abi: abxFixedPriceMinterAbi, data: tx.data});
  assert.equal(functionName, 'purchase');
  // the live terms ARE the buyer's bound by default — no unbounded price reaches the minter
  assert.deepEqual(args, [TOKEN, zeroAddress, parseEther('0.1')]);
  assert.equal(tx.value, `0x${parseEther('0.1').toString(16)}`); // derived, never passed in
});

test('preparePurchase: recipient → purchaseTo(token, to, terms); ERC-20 attaches no value', () => {
  const tx = preparePurchase({minter: MINTER, token: TOKEN, sale: {paymentToken: ERC20, price: 1000n}, to: TO, chainId: CHAIN});
  const {functionName, args} = decodeFunctionData({abi: abxFixedPriceMinterAbi, data: tx.data});
  assert.equal(functionName, 'purchaseTo');
  assert.deepEqual(args, [TOKEN, TO, ERC20, 1000n]);
  assert.equal(tx.value, '0x0'); // an ERC-20 sale pulls the allowance; sending ETH would revert
});

test('preparePurchase: an explicit maxPrice widens the bound but never the payment', () => {
  const tx = preparePurchase({
    minter: MINTER,
    token: TOKEN,
    sale: {paymentToken: zeroAddress, price: parseEther('0.1')},
    maxPrice: parseEther('0.12'), // caller tolerates a small move rather than re-signing
    chainId: CHAIN,
  });
  const {args} = decodeFunctionData({abi: abxFixedPriceMinterAbi, data: tx.data});
  assert.deepEqual(args, [TOKEN, zeroAddress, parseEther('0.12')]);
  assert.equal(tx.value, `0x${parseEther('0.1').toString(16)}`); // still exactly the live price
  assert.equal(tx.fields.maxPrice, parseEther('0.12').toString());
});

test('prepareDeployFixedPriceMinter: a CREATE2-proxy deploy, at the canonical predicted address', () => {
  const tx = prepareDeployFixedPriceMinter({chainId: CHAIN});
  // NOT a plain creation (`to: null`) — CREATE2 via the keyless proxy is what makes the address the
  // SAME on every chain (see `predictFixedPriceMinter`); a plain creation would be nonce-dependent.
  assert.equal(tx.to, CREATE2_PROXY);
  assert.equal(tx.data, create2Calldata(ABX_SALT.fixedPriceMinter, abxFixedPriceMinterBytecode));
  assert.equal(tx.value, '0x0');
});
