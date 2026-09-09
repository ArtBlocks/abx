import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Account, Address, Hex, PublicClient, WalletClient} from 'viem';
import {pinGas, makeHotSender, type SendEvent} from '../src/execute.ts';
import type {PreparedTx} from '../src/ops.ts';
import {GasEstimateBelowFloorError, TxRevertedError} from '../src/errors.ts';

// `gasFloor` is a DETECTOR, not a spare gas limit. It carries only the provable part of a payload's
// cost — EVM code deposit at exactly 200 gas/byte — so an estimate below it is impossible rather than
// merely low, which is proof the node is answering from stale state. The tests below pin that
// distinction, because the tempting alternative (send the floor instead) is subtly wrong: the same
// setup multicall also carries schema, dependency and mint legs whose cost the floor knows nothing
// about, so a padded floor would under-fund the next payload and reproduce the original bug.

const FROM = '0x71Cf70753636779Ed124F529De762B9A2B6629c4' as Address;
const TO = '0x7CcC774271daa029cF0284BE913611Bc66eA5155' as Address;
const DATA = '0xac9650d8' as Hex;

// The reported case: one 3,563-byte chunk ⇒ 712,600 gas of deposit that cannot be avoided.
const FLOOR_GAS = BigInt(3_563 * 200);
const FLOOR = `0x${FLOOR_GAS.toString(16)}` as Hex;

/** A client whose estimate follows a script, so retry behavior is observable. */
function clientSeq(...results: Array<bigint | Error>) {
  let i = 0;
  const calls = {count: 0};
  const client = {
    estimateGas: async () => {
      calls.count++;
      const r = results[Math.min(i++, results.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
  } as unknown as PublicClient;
  return {client, calls};
}

test('pinGas: a plausible estimate is trusted, with headroom', async () => {
  // 941,331 is the live measurement for the reported payload with the contract's code present.
  const {client} = clientSeq(941_331n);
  const gas = await pinGas(client, {from: FROM, to: TO, data: DATA, gasFloor: FLOOR});
  assert.equal(gas, (941_331n * 125n) / 100n);
});

test('pinGas: an IMPOSSIBLE estimate is refused, never replaced by a guess', async () => {
  // 201,616 is what the chain actually returned for this payload against a codeless target.
  const {client, calls} = clientSeq(201_616n);
  await assert.rejects(
    () => pinGas(client, {from: FROM, to: TO, data: DATA, gasFloor: FLOOR}, {attempts: 3, delayMs: 0}),
    (err: Error) => {
      assert.ok(err instanceof GasEstimateBelowFloorError, 'a typed error, catchable without parsing the message');
      assert.match(err.message, /Refusing to send/);
      assert.match(err.message, /stale state/);
      assert.match(err.message, /201616/); // names what it saw
      return true;
    },
  );
  assert.equal(calls.count, 3, 'a broken measurement should be retried before giving up');
});

test('pinGas: a transient bad estimate recovers on retry', async () => {
  // The lagging node catches up between attempts — the common case, and it must not error out.
  const {client, calls} = clientSeq(201_616n, 941_331n);
  const gas = await pinGas(client, {from: FROM, to: TO, data: DATA, gasFloor: FLOOR}, {attempts: 3, delayMs: 0});
  assert.equal(gas, (941_331n * 125n) / 100n);
  assert.equal(calls.count, 2);
});

test('pinGas: with nothing provable to check against, the estimate stands', async () => {
  const {client} = clientSeq(100_000n);
  const gas = await pinGas(client, {from: FROM, to: TO, data: DATA});
  assert.equal(gas, 125_000n);
});

test('pinGas: a revert during estimation surfaces immediately — it is an answer, not a lagging node', async () => {
  const {client, calls} = clientSeq(new Error('execution reverted: Ownable: caller is not the owner'));
  await assert.rejects(
    () => pinGas(client, {from: FROM, to: TO, data: DATA}, {attempts: 3, delayMs: 0}),
    /caller is not the owner/,
  );
  assert.equal(calls.count, 1, 'a revert is not retried — the message is the useful part');
});

test('pinGas: the floor is bare code deposit, with no padding that could be mistaken for a limit', async () => {
  // Guards the design: if someone later pads gasFloor into a "probably enough" number, a caller will
  // eventually send it as the gas limit and under-fund a multi-leg setup. 200/byte exactly.
  assert.equal(FLOOR_GAS, 712_600n);
  const {client} = clientSeq(712_600n); // exactly at the floor is plausible, not impossible
  const gas = await pinGas(client, {from: FROM, to: TO, data: DATA, gasFloor: FLOOR}, {attempts: 1, delayMs: 0});
  assert.equal(gas, (712_600n * 125n) / 100n);
});

// ── makeHotSender ─────────────────────────────────────────────────────────────
// A mock wallet/public client pair, following the `clientSeq` mocking style above: only the
// methods `makeHotSender` actually calls are implemented, cast through `unknown` like the rest of
// this file's mocks (and consistent with cli/test's existing mock style for these clients).

interface MockChain {
  publicClient: PublicClient;
  wallet: WalletClient;
  account: Account;
  sent: Array<{to?: Address; data: Hex; value?: bigint; nonce?: number; gas?: bigint}>;
  getTransactionCountCalls: number;
  getCodeCalls: number;
}

function mockChain(opts: {
  estimateGasResults?: Array<bigint | Error>;
  receiptStatus?: 'success' | 'reverted';
  startNonce?: number;
  /** A node whose `pending` view has fallen behind its own head answers LOWER here than `latest`. */
  pendingNonce?: number;
  codeAtTarget?: boolean;
}): MockChain {
  const sent: MockChain['sent'] = [];
  const estimateResults = opts.estimateGasResults ?? [100_000n];
  let estimateIdx = 0;
  let getTransactionCountCalls = 0;
  let getCodeCalls = 0;
  let hashCounter = 0;

  const publicClient = {
    getTransactionCount: async ({blockTag}: {blockTag?: string} = {}) => {
      getTransactionCountCalls++;
      const latest = opts.startNonce ?? 7;
      return blockTag === 'pending' ? (opts.pendingNonce ?? latest) : latest;
    },
    estimateGas: async () => {
      const r = estimateResults[Math.min(estimateIdx++, estimateResults.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
    getCode: async () => {
      getCodeCalls++;
      return opts.codeAtTarget === false ? '0x' : '0x1234';
    },
    waitForTransactionReceipt: async ({hash}: {hash: Hex}) => ({
      transactionHash: hash,
      blockNumber: 100n,
      status: opts.receiptStatus ?? 'success',
      logs: [],
    }),
  } as unknown as PublicClient;

  const wallet = {
    chain: {id: 11155111},
    sendTransaction: async (args: {to?: Address; data: Hex; value?: bigint; nonce?: number; gas?: bigint}) => {
      sent.push(args);
      hashCounter++;
      return `0x${hashCounter.toString().padStart(64, '0')}` as Hex;
    },
  } as unknown as WalletClient;

  const account = {address: FROM} as Account;
  return {
    publicClient,
    wallet,
    account,
    sent,
    get getTransactionCountCalls() {
      return getTransactionCountCalls;
    },
    get getCodeCalls() {
      return getCodeCalls;
    },
  } as MockChain;
}

function tx(overrides: Partial<PreparedTx> = {}): PreparedTx {
  return {op: 'test-op', to: TO, data: DATA, value: '0x0', chainId: 11155111, summary: 'a test tx', fields: {}, ...overrides};
}

test('makeHotSender: happy path — pins gas, sends, waits for the receipt, and narrates via onEvent', async () => {
  const m = mockChain({estimateGasResults: [100_000n]});
  const events: SendEvent[] = [];
  const send = makeHotSender({wallet: m.wallet, account: m.account, publicClient: m.publicClient, onEvent: (e) => events.push(e)});
  const receipt = await send(tx());
  assert.equal(receipt.status, 'success');
  assert.equal(m.sent.length, 1);
  assert.equal(m.sent[0].gas, 125_000n); // pinGas headroom: 100_000 * 1.25
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, 'sending');
  assert.equal(events[1].kind, 'mined');
});

test('makeHotSender: pins the nonce ONCE and increments it locally — no re-fetch per send', async () => {
  const m = mockChain({estimateGasResults: [100_000n], startNonce: 42});
  const send = makeHotSender({wallet: m.wallet, account: m.account, publicClient: m.publicClient});
  await send(tx({op: 'first'}));
  await send(tx({op: 'second'}));
  // Two reads — `pending` and `latest` — but ONE pair, for the whole sequence, not a pair per send.
  assert.equal(m.getTransactionCountCalls, 2, 'read once for the whole sequence, not once per send');
  assert.equal(m.sent[0].nonce, 42);
  assert.equal(m.sent[1].nonce, 43, 'incremented locally, never re-read from the RPC');
});

test('makeHotSender: a node whose pending view is BEHIND its own head cannot lower the nonce', async () => {
  // Measured on sepolia.base.org right after a confirmed write: `pending` came back lower than
  // `latest` for the same address. Believing it re-uses a spent nonce, and the broadcast is rejected
  // as a duplicate — silently, because a failed simulation means nothing is ever sent.
  const m = mockChain({estimateGasResults: [100_000n], startNonce: 42, pendingNonce: 40});
  const send = makeHotSender({wallet: m.wallet, account: m.account, publicClient: m.publicClient});
  await send(tx({op: 'first'}));
  assert.equal(m.sent[0].nonce, 42, 'floored at the latest-block count, not the stale pending one');
});

test('makeHotSender: a genuinely pending transaction still wins — the floor never lowers a real nonce', async () => {
  const m = mockChain({estimateGasResults: [100_000n], startNonce: 42, pendingNonce: 45});
  const send = makeHotSender({wallet: m.wallet, account: m.account, publicClient: m.publicClient});
  await send(tx({op: 'first'}));
  assert.equal(m.sent[0].nonce, 45, 'pending is higher, so pending is correct');
});

test('makeHotSender: waits for code at the target from the second send onward, never on the first', async () => {
  const m = mockChain({estimateGasResults: [100_000n], codeAtTarget: true});
  const send = makeHotSender({wallet: m.wallet, account: m.account, publicClient: m.publicClient});
  await send(tx({op: 'deploy'}));
  assert.equal(m.getCodeCalls, 0, 'the first send in a sequence created its own target — nothing to wait for yet');
  await send(tx({op: 'setup', to: TO}));
  assert.equal(m.getCodeCalls, 1, 'a send after the first may target what an earlier send just created');
});

test('makeHotSender: a gasFloor refusal never sends — throws the typed GasEstimateBelowFloorError', async () => {
  // Every attempt comes back the same impossible-low estimate, so pinGas exhausts its retries and
  // refuses — makeHotSender must propagate that refusal WITHOUT ever calling sendTransaction.
  const m = mockChain({estimateGasResults: [50_000n]});
  const send = makeHotSender({wallet: m.wallet, account: m.account, publicClient: m.publicClient});
  await assert.rejects(
    () => send(tx({gasFloor: '0x186a0' /* 100_000 */})),
    (err: unknown) => {
      assert.ok(err instanceof GasEstimateBelowFloorError);
      return true;
    },
  );
  assert.equal(m.sent.length, 0, 'an under-funded tx is never broadcast');
});

test('makeHotSender: a reverted receipt throws TxRevertedError carrying the op + tx hash, not "confirmed"', async () => {
  const m = mockChain({estimateGasResults: [100_000n], receiptStatus: 'reverted'});
  const send = makeHotSender({wallet: m.wallet, account: m.account, publicClient: m.publicClient});
  await assert.rejects(
    () => send(tx({op: 'my-op'})),
    (err: unknown) => {
      assert.ok(err instanceof TxRevertedError);
      assert.match((err as Error).message, /my-op reverted/);
      assert.equal((err as TxRevertedError).op, 'my-op');
      return true;
    },
  );
});
