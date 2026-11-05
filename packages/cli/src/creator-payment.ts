import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {formatEther, type Address, type Hex, type PublicClient, type Chain, type Transport} from 'viem';
import {estimateL1Fee, estimateOperatorFee} from 'viem/op-stack';
import type {CreatorAccount, CreatorPreparedOperation, PreparedTx} from '@artblocks/abx-sdk';

export type CreatorPayment =
  | {mode: 'sponsored'; requiredBalance: bigint}
  | {mode: 'self-paid'; requiredBalance: bigint; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex};

const quantity = (value: bigint): Hex => `0x${value.toString(16)}`;

/** Resolve payment once, before preparing/signing an operation. Never switch it after submission. */
export async function quoteCreatorPayment(
  client: PublicClient,
  account: CreatorAccount,
  tx: PreparedTx & {to: Address},
  gas: bigint,
  additionalFee?: () => Promise<bigint>,
): Promise<CreatorPayment> {
  const value = BigInt(tx.value);
  const eligible =
    value === 0n && account.capabilities.sponsorship && account.capabilities.sponsoredChains.includes(tx.chainId);
  const canSelfPay = account.capabilities.selfPayment && account.capabilities.walletChains?.includes(tx.chainId);
  if (!canSelfPay) {
    if (eligible) return {mode: 'sponsored', requiredBalance: 0n};
    throw new Error('The provider does not enable creator-wallet self-payment on this network.');
  }
  if (client.chain?.id !== tx.chainId) throw new Error('Creator-wallet fee quote has the wrong chain.');
  const nativeClient = client as PublicClient<Transport, Chain>;
  const wallet = account.wallet!.address;
  const balance = await client.getBalance({address: wallet, blockTag: 'pending'});
  if (balance === 0n && eligible) return {mode: 'sponsored', requiredBalance: 0n};
  const fees = await nativeClient.estimateFeesPerGas({type: 'eip1559'});
  if (fees.maxFeePerGas <= 0n || fees.maxPriorityFeePerGas < 0n || fees.maxPriorityFeePerGas > fees.maxFeePerGas) {
    throw new Error('Could not obtain valid creator-wallet fee ceilings. Nothing was signed.');
  }
  // Arbitrum's execution gas estimate includes the L1 component. Base charges L1/operator
  // fees separately; reserve twice their estimate rather than treating execution gas as total cost.
  let extra = 0n;
  if (additionalFee) extra = await additionalFee();
  else if ([8453, 84532].includes(tx.chainId)) {
    const request = {account: wallet, to: tx.to, data: tx.data, value, gas};
    const [l1, operator] = await Promise.all([
      estimateL1Fee(nativeClient, request),
      estimateOperatorFee(nativeClient, request),
    ]);
    extra = l1 + operator;
  }
  const requiredBalance = value + gas * fees.maxFeePerGas + extra * 2n;
  if (balance >= requiredBalance) {
    return {
      mode: 'self-paid',
      requiredBalance,
      maxFeePerGas: quantity(fees.maxFeePerGas),
      maxPriorityFeePerGas: quantity(fees.maxPriorityFeePerGas),
    };
  }
  if (eligible) return {mode: 'sponsored', requiredBalance};
  throw new Error(
    `Creator wallet needs at least ${formatEther(requiredBalance)} ETH on this network for value plus fees; it holds ${formatEther(balance)} ETH. Fund this same wallet on the selected network. Nothing was signed.`,
  );
}

/** The backend may relay a locally approved intent, but cannot choose what the CLI signs. */
export function assertCreatorSigningRequest(
  prepared: CreatorPreparedOperation,
  input: {
    accountId: string;
    operationId: string;
    walletId: string;
    wallet: Address;
    tx: PreparedTx & {to: Address};
    gasLimit: number;
    payment: CreatorPayment;
  },
): void {
  const {tx, payment} = input;
  const reference = `abx_${createHash('sha256').update(`${input.accountId}:${input.operationId}`).digest('hex').slice(0, 60)}`;
  const transaction = {
    from: input.wallet.toLowerCase(),
    chain_id: tx.chainId,
    value: tx.value.toLowerCase(),
    data: tx.data.toLowerCase(),
    gas_limit: quantity(BigInt(input.gasLimit)),
    to: tx.to.toLowerCase(),
    ...(payment.mode === 'self-paid'
      ? {max_fee_per_gas: payment.maxFeePerGas, max_priority_fee_per_gas: payment.maxPriorityFeePerGas}
      : {}),
  };
  const expected = {
    method: 'eth_sendTransaction',
    chain_type: 'ethereum',
    caip2: `eip155:${tx.chainId}`,
    sponsor: payment.mode === 'sponsored',
    reference_id: reference,
    params: {transaction},
  };
  if (
    prepared.operation.state !== 'prepared' ||
    prepared.operation.operationId !== input.operationId ||
    prepared.operation.chainId !== tx.chainId ||
    prepared.operation.walletId !== input.walletId ||
    (prepared.operation.paymentMode ?? 'sponsored') !== payment.mode ||
    prepared.signingRequest.walletId !== input.walletId ||
    prepared.signingRequest.idempotencyKey !== reference ||
    !isDeepStrictEqual(prepared.signingRequest.body, expected)
  ) {
    throw new Error(
      'Creator-wallet signing payload does not match the locally prepared transaction. Nothing was signed.',
    );
  }
}
