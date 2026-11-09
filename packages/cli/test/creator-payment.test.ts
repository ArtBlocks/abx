import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import type {CreatorAccount, CreatorPreparedOperation, PreparedTx, PublicClient} from '@artblocks/abx-sdk';
import {assertCreatorSigningRequest, preflightCreatorPayment, quoteCreatorPayment} from '../src/creator-payment.js';

const wallet = '0x1111111111111111111111111111111111111111' as const;
const target = '0x2222222222222222222222222222222222222222' as const;
const tx = {
  op: 'test',
  summary: 'test',
  fields: {},
  chainId: 1,
  to: target,
  value: '0x0',
  data: '0x1234',
} as const satisfies PreparedTx;
const account: CreatorAccount = {
  accountId: 'account',
  emailVerified: true,
  wallet: {address: wallet, provider: 'privy', providerAppId: 'app'},
  capabilities: {wallet: true, selfPayment: true, walletChains: [1, 8453], sponsorship: true, sponsoredChains: [8453]},
};
const client = (balance: bigint, chainId = 1) =>
  ({
    chain: {id: chainId},
    getBalance: async () => balance,
    estimateFeesPerGas: async () => ({maxFeePerGas: 10n, maxPriorityFeePerGas: 2n}),
  }) as unknown as PublicClient;

test('native-value preflight rejects disabled self-payment before reading funds or suggesting funding', async () => {
  const disabled = {...account, capabilities: {...account.capabilities, selfPayment: false}};
  for (const balance of [0n, 2000n]) {
    let reads = 0;
    const rpc = {
      ...client(balance, 8453),
      getBalance: async () => {
        reads++;
        return balance;
      },
    } as unknown as PublicClient;
    const call = {...tx, chainId: 8453, value: '0x64'} as const;
    await assert.rejects(preflightCreatorPayment(rpc, disabled, call), /does not enable creator-wallet self-payment/);
    await assert.rejects(quoteCreatorPayment(rpc, disabled, call, 100n), /does not enable creator-wallet self-payment/);
    assert.equal(reads, 0);
  }
});

test('native-value preflight checks funding only after self-payment is available', async () => {
  await assert.rejects(preflightCreatorPayment(client(100n), account, {...tx, value: '0x64'}), /Fund the creator wallet/);
  await assert.doesNotReject(preflightCreatorPayment(client(1100n), account, {...tx, value: '0x64'}));
  const disabled = {...account, capabilities: {...account.capabilities, selfPayment: false}};
  await assert.doesNotReject(preflightCreatorPayment(client(0n, 8453), disabled, {...tx, chainId: 8453}));
});

test('funded creator wallets self-pay on a non-sponsored network, including native value', async () => {
  const result = await quoteCreatorPayment(client(1100n), account, {...tx, value: '0x64'}, 100n);
  assert.deepEqual(result, {
    mode: 'self-paid',
    requiredBalance: 1100n,
    maxFeePerGas: '0xa',
    maxPriorityFeePerGas: '0x2',
  });
});

test('funded Base wallet self-pays; fee reserve includes L1 and operator charges', async () => {
  const call = {...tx, chainId: 8453};
  assert.equal(
    (await quoteCreatorPayment(client(1200n, 8453), account, call, 100n, async () => 100n)).mode,
    'self-paid',
  );
  assert.equal(
    (await quoteCreatorPayment(client(1199n, 8453), account, call, 100n, async () => 100n)).mode,
    'sponsored',
  );
  assert.equal((await quoteCreatorPayment(client(0n, 8453), account, call, 100n)).mode, 'sponsored');
});

test('non-zero value never falls back to sponsorship and insufficient funds fail before signing', async () => {
  await assert.rejects(
    quoteCreatorPayment(client(1000n, 8453), account, {...tx, chainId: 8453, value: '0x1'}, 100n, async () => 0n),
    /Fund this same wallet/,
  );
  await assert.rejects(quoteCreatorPayment(client(999n), account, tx, 100n), /Fund this same wallet/);
});

test('sponsorship revocation does not prevent funded self-payment', async () => {
  const revoked = {...account, capabilities: {...account.capabilities, sponsorship: false, sponsoredChains: []}};
  assert.equal((await quoteCreatorPayment(client(1000n), revoked, tx, 100n)).mode, 'self-paid');
});

test('a failed balance/fee read never selects a different payment mode', async () => {
  const broken = {
    ...client(2000n, 8453),
    estimateFeesPerGas: async () => {
      throw new Error('RPC unavailable');
    },
  } as unknown as PublicClient;
  await assert.rejects(quoteCreatorPayment(broken, account, {...tx, chainId: 8453}, 100n), /RPC unavailable/);
});

test('older providers keep their existing sponsorship behavior without unlocking self-payment', async () => {
  const legacy = {...account, capabilities: {wallet: true, sponsorship: true, sponsoredChains: [8453]}};
  assert.equal(
    (await quoteCreatorPayment(client(10000n, 8453), legacy, {...tx, chainId: 8453}, 100n)).mode,
    'sponsored',
  );
  await assert.rejects(quoteCreatorPayment(client(10000n), legacy, tx, 100n), /does not enable/);
});

test('signing refuses substitutions of intent, payer, wallet, fees, or extra transaction authority', () => {
  const reference = `abx_${createHash('sha256').update('account:op_test_auto').digest('hex').slice(0, 60)}`;
  const operation = {
    operationId: 'op_test_auto',
    chainId: 1,
    walletId: 'wallet',
    paymentMode: 'self-paid',
    state: 'prepared',
    providerTransactionId: null,
    transactionHash: null,
    userOperationHash: null,
    errorCode: null,
    updatedAt: '2026-11-05',
  } as const;
  const prepared: CreatorPreparedOperation = {
    operation,
    signingRequest: {
      walletId: 'wallet',
      idempotencyKey: reference,
      requestExpiry: '9999999999999',
      body: {
        method: 'eth_sendTransaction',
        chain_type: 'ethereum',
        caip2: 'eip155:1',
        sponsor: false,
        reference_id: reference,
        params: {
          transaction: {
            from: wallet,
            to: target,
            chain_id: 1,
            value: '0x0',
            data: '0x1234',
            gas_limit: '0x64',
            max_fee_per_gas: '0xa',
            max_priority_fee_per_gas: '0x2',
          },
        },
      },
    },
  };
  const input = {
    accountId: 'account',
    operationId: 'op_test_auto',
    walletId: 'wallet',
    wallet,
    tx,
    gasLimit: 100,
    payment: {mode: 'self-paid', requiredBalance: 1000n, maxFeePerGas: '0xa', maxPriorityFeePerGas: '0x2'} as const,
  };
  assert.doesNotThrow(() => assertCreatorSigningRequest(prepared, input));
  const sponsored = structuredClone(prepared);
  sponsored.operation.paymentMode = 'sponsored';
  sponsored.signingRequest.body.sponsor = true;
  const sponsoredTx = (sponsored.signingRequest.body.params as {transaction: Record<string, unknown>}).transaction;
  delete sponsoredTx.max_fee_per_gas;
  delete sponsoredTx.max_priority_fee_per_gas;
  assert.doesNotThrow(() =>
    assertCreatorSigningRequest(sponsored, {...input, payment: {mode: 'sponsored', requiredBalance: 0n}}),
  );

  const reject = (change: (p: CreatorPreparedOperation) => void) => {
    const p = structuredClone(prepared);
    change(p);
    assert.throws(() => assertCreatorSigningRequest(p, input), /does not match/);
  };
  reject((p) => {
    p.signingRequest.walletId = 'another-wallet';
  });
  reject((p) => {
    p.signingRequest.idempotencyKey = 'different';
  });
  reject((p) => {
    p.signingRequest.body.sponsor = true;
  });
  reject((p) => {
    p.signingRequest.body.caip2 = 'eip155:8453';
  });
  reject((p) => {
    p.operation.state = 'confirmed';
  });
  for (const [key, value] of Object.entries({
    to: wallet,
    from: target,
    value: '0x1',
    data: '0xdead',
    chain_id: 8453,
    gas_limit: '0x65',
    max_fee_per_gas: '0xb',
    max_priority_fee_per_gas: '0x3',
    authorization_list: [],
  })) {
    reject((p) => {
      (p.signingRequest.body.params as {transaction: Record<string, unknown>}).transaction[key] = value;
    });
  }
});
