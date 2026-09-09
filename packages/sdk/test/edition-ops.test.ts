// ERC-1155 edition ops: prepare* calldata correctness (decoded with viem against the real ABIs,
// same idiom as series-ops.test.ts/minter-ops.test.ts) + mintedTokenIds/mintedEditionAmounts on
// synthetic 1155 mint receipts.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseEther, zeroAddress, type PublicClient} from 'viem';

import {
  prepareEditionMint,
  prepareEditionTransfer,
  prepareSetMaxSupply,
  preparePingURI,
  prepareConfigureSale1155,
  preparePurchase1155,
  prepareDeployOneOfOneEditionFactory,
  prepareDeployEditionFactory,
  prepareDeployFixedPriceMinter1155,
  mintedTokenIds,
  mintedEditionAmounts,
} from '../src/ops.ts';
import {oneOfOneEditionAbi, abxFixedPriceMinter1155Abi, abxFixedPriceMinter1155Bytecode} from '../src/abi/index.ts';
import {
  ABX_SALT,
  CREATE2_PROXY,
  create2Calldata,
  linkEditionFactory,
  linkOneOfOneEditionFactory,
} from '../src/create2.ts';

const TOKEN = '0x1111111111111111111111111111111111111111' as const;
const TO = '0x2222222222222222222222222222222222222222' as const;
const FROM = '0x4444444444444444444444444444444444444444' as const;
const MINTER = '0x9999999999999999999999999999999999999999' as const;
const ERC20 = '0x3333333333333333333333333333333333333333' as const;
const CHAIN = 11155111;

test('prepareEditionMint: encodes mint(to, id, amount)', () => {
  const tx = prepareEditionMint({contract: TOKEN, to: TO, tokenId: 7, amount: 3, chainId: CHAIN});
  const {functionName, args} = decodeFunctionData({abi: oneOfOneEditionAbi, data: tx.data});
  assert.equal(functionName, 'mint');
  assert.deepEqual(args, [TO, 7n, 3n]);
  assert.equal(tx.to, TOKEN);
  assert.equal(tx.value, '0x0');
});

test('prepareEditionTransfer: encodes safeTransferFrom(from, to, id, amount, "")', () => {
  const tx = prepareEditionTransfer({contract: TOKEN, from: FROM, to: TO, tokenId: 2, amount: 5, chainId: CHAIN});
  const {functionName, args} = decodeFunctionData({abi: oneOfOneEditionAbi, data: tx.data});
  assert.equal(functionName, 'safeTransferFrom');
  assert.deepEqual(args, [FROM, TO, 2n, 5n, '0x']);
});

test('prepareSetMaxSupply: encodes setMaxSupply(id, cap)', () => {
  const tx = prepareSetMaxSupply({contract: TOKEN, tokenId: 4, cap: 100, chainId: CHAIN});
  const {functionName, args} = decodeFunctionData({abi: oneOfOneEditionAbi, data: tx.data});
  assert.equal(functionName, 'setMaxSupply');
  assert.deepEqual(args, [4n, 100n]);
});

test('preparePingURI: encodes pingURI(ids[])', () => {
  const tx = preparePingURI({contract: TOKEN, tokenIds: [0, 1, 2], chainId: CHAIN});
  const {functionName, args} = decodeFunctionData({abi: oneOfOneEditionAbi, data: tx.data});
  assert.equal(functionName, 'pingURI');
  assert.deepEqual(args, [[0n, 1n, 2n]]);
});

test('prepareConfigureSale1155: encodes configure(token, id, paymentToken, price, allocation); ETH default', () => {
  const tx = prepareConfigureSale1155({minter: MINTER, token: TOKEN, tokenId: 1, price: parseEther('0.2'), allocation: 10, chainId: CHAIN});
  const {functionName, args} = decodeFunctionData({abi: abxFixedPriceMinter1155Abi, data: tx.data});
  assert.equal(functionName, 'configure');
  assert.deepEqual(args, [TOKEN, 1n, zeroAddress, parseEther('0.2'), 10n]);
  assert.equal(tx.to, MINTER);
  assert.equal(tx.value, '0x0');
});

test('prepareConfigureSale1155: ERC-20 sale carries the token address', () => {
  const tx = prepareConfigureSale1155({minter: MINTER, token: TOKEN, tokenId: 3, paymentToken: ERC20, price: 500n, allocation: 2, chainId: CHAIN});
  const {args} = decodeFunctionData({abi: abxFixedPriceMinter1155Abi, data: tx.data});
  assert.deepEqual(args, [TOKEN, 3n, ERC20, 500n, 2n]);
});

test('preparePurchase1155: no recipient → purchase(token, id, qty, terms); ETH value = price*qty, bound to the TOTAL', () => {
  const tx = preparePurchase1155({minter: MINTER, token: TOKEN, tokenId: 5, quantity: 2, sale: {paymentToken: zeroAddress, price: parseEther('0.2')}, chainId: CHAIN});
  const {functionName, args} = decodeFunctionData({abi: abxFixedPriceMinter1155Abi, data: tx.data});
  assert.equal(functionName, 'purchase');
  // price × quantity is computed once — same number as the bound and as the attached ETH
  assert.deepEqual(args, [TOKEN, 5n, 2n, zeroAddress, parseEther('0.4')]);
  assert.equal(tx.value, `0x${parseEther('0.4').toString(16)}`);
});

test('preparePurchase1155: recipient → purchaseTo(token, id, qty, to, terms); ERC-20 attaches no value', () => {
  const tx = preparePurchase1155({minter: MINTER, token: TOKEN, tokenId: 5, quantity: 4, sale: {paymentToken: ERC20, price: 500n}, to: TO, chainId: CHAIN});
  const {functionName, args} = decodeFunctionData({abi: abxFixedPriceMinter1155Abi, data: tx.data});
  assert.equal(functionName, 'purchaseTo');
  assert.deepEqual(args, [TOKEN, 5n, 4n, TO, ERC20, 2000n]); // 500 × 4, the total that leaves the buyer
  assert.equal(tx.value, '0x0');
});

test('preparePurchase1155: an explicit maxTotalPrice widens the bound but never the payment', () => {
  const tx = preparePurchase1155({
    minter: MINTER,
    token: TOKEN,
    tokenId: 5,
    quantity: 3,
    sale: {paymentToken: zeroAddress, price: parseEther('0.1')},
    maxTotalPrice: parseEther('0.35'),
    chainId: CHAIN,
  });
  const {args} = decodeFunctionData({abi: abxFixedPriceMinter1155Abi, data: tx.data});
  assert.deepEqual(args, [TOKEN, 5n, 3n, zeroAddress, parseEther('0.35')]);
  assert.equal(tx.value, `0x${parseEther('0.3').toString(16)}`); // still exactly price × quantity
});

// ── the three new CREATE2-proxy deploys ────────────────────────────────────────

test('prepareDeployOneOfOneEditionFactory / prepareDeployEditionFactory / prepareDeployFixedPriceMinter1155: CREATE2-proxy deploys at the canonical predicted addresses', () => {
  // The two edition IMAGE factories embed library-linked implementations (`OneOfOneEdition`/
  // `EditionImage` delegate into `AbxEditionLib`), so the initcode is the LINKED form — asserting
  // against the raw `*Bytecode` export here is what let the unlinked-placeholder bug ship. The
  // minter links nothing, so its raw bytecode is its initcode. See link.test.ts for the guard that
  // makes this class of mistake impossible to repeat by name.
  const a = prepareDeployOneOfOneEditionFactory({chainId: CHAIN});
  assert.equal(a.to, CREATE2_PROXY);
  assert.equal(a.data, create2Calldata(ABX_SALT.oneOfOneEditionFactory, linkOneOfOneEditionFactory()));

  const b = prepareDeployEditionFactory({chainId: CHAIN});
  assert.equal(b.to, CREATE2_PROXY);
  assert.equal(b.data, create2Calldata(ABX_SALT.editionFactory, linkEditionFactory()));

  const c = prepareDeployFixedPriceMinter1155({chainId: CHAIN});
  assert.equal(c.to, CREATE2_PROXY);
  assert.equal(c.data, create2Calldata(ABX_SALT.fixedPriceMinter1155, abxFixedPriceMinter1155Bytecode));
  for (const tx of [a, b, c]) assert.equal(tx.value, '0x0');
});

// ── mintedTokenIds / mintedEditionAmounts on a synthetic 1155 receipt ─────────────────────────

/** Build a viem-decodable log for one event, given the FULL args object (indexed + non-indexed).
 *  `encodeEventTopics` picks the indexed ones (+ topic0); the rest go in `data`, in ABI order. */
function makeLog(
  abi: typeof oneOfOneEditionAbi,
  eventName: string,
  args: Record<string, unknown>,
  opts: {logIndex?: number} = {},
) {
  const fragment = abi.find((f) => f.type === 'event' && f.name === eventName) as {
    inputs: ReadonlyArray<{name: string; type: string; indexed?: boolean}>;
  };
  const topics = encodeEventTopics({abi, eventName, args} as never);
  const nonIndexed = fragment.inputs.filter((i) => !i.indexed);
  const data =
    nonIndexed.length === 0
      ? ('0x' as const)
      : encodeAbiParameters(nonIndexed as never, nonIndexed.map((i) => args[i.name]) as never);
  return {
    address: TOKEN,
    topics,
    data,
    blockNumber: 42n,
    blockHash: `0x${'aa'.repeat(32)}` as const,
    transactionHash: `0x${'bb'.repeat(32)}` as const,
    transactionIndex: 0,
    logIndex: opts.logIndex ?? 0,
    removed: false,
  };
}

function fakeReceiptClient(logs: ReturnType<typeof makeLog>[]) {
  return {
    getTransactionReceipt: async () => ({logs}),
  } as unknown as PublicClient;
}

test('mintedTokenIds: a single TransferSingle mint reports its one id (not the amount)', async () => {
  const logs = [
    makeLog(oneOfOneEditionAbi, 'TransferSingle', {operator: FROM, from: zeroAddress, to: TO, id: 7n, amount: 50n}),
  ];
  const ids = await mintedTokenIds(fakeReceiptClient(logs), TOKEN, `0x${'bb'.repeat(32)}`);
  assert.deepEqual(ids, ['7']); // one id, regardless of the 50-copy amount
});

test('mintedTokenIds: TransferBatch unpacks every minted id, and a transfer leg (from != 0x0) is excluded', async () => {
  const logs = [
    makeLog(oneOfOneEditionAbi, 'TransferBatch', {
      operator: FROM,
      from: zeroAddress,
      to: TO,
      ids: [0n, 1n, 2n],
      amounts: [1n, 9n, 3n],
    }),
    makeLog(oneOfOneEditionAbi, 'TransferSingle', {operator: FROM, from: FROM, to: TO, id: 99n, amount: 1n}, {logIndex: 1}),
  ];
  const ids = await mintedTokenIds(fakeReceiptClient(logs), TOKEN, `0x${'bb'.repeat(32)}`);
  assert.deepEqual(ids, ['0', '1', '2']); // 99 excluded — that leg's `from` isn't the zero address
});

test('mintedEditionAmounts: carries the amount per id, summed if an id appears twice in one tx', async () => {
  const logs = [
    makeLog(oneOfOneEditionAbi, 'TransferSingle', {operator: FROM, from: zeroAddress, to: TO, id: 7n, amount: 50n}),
    makeLog(
      oneOfOneEditionAbi,
      'TransferBatch',
      {operator: FROM, from: zeroAddress, to: TO, ids: [7n, 8n], amounts: [2n, 6n]},
      {logIndex: 1},
    ),
  ];
  const out = await mintedEditionAmounts(fakeReceiptClient(logs), TOKEN, `0x${'bb'.repeat(32)}`);
  assert.deepEqual(out, [
    {tokenId: '7', amount: '52'}, // 50 (single) + 2 (batch) — same id, two legs, one tx
    {tokenId: '8', amount: '6'},
  ]);
});

test('mintedTokenIds / mintedEditionAmounts: a receipt read failure fails open to []', async () => {
  const client = {getTransactionReceipt: async () => { throw new Error('rpc down'); }} as unknown as PublicClient;
  assert.deepEqual(await mintedTokenIds(client, TOKEN, `0x${'cc'.repeat(32)}`), []);
  assert.deepEqual(await mintedEditionAmounts(client, TOKEN, `0x${'cc'.repeat(32)}`), []);
});
