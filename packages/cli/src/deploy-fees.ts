import type {Address, PreparedTx, PublicClient} from '@artblocks/abx-sdk';
import {formatEther, parseAbi} from 'viem';
import {base, baseSepolia} from 'viem/chains';
import {estimateL1Fee} from 'viem/op-stack';
import type {DeployPlanEstimate} from './deploy-plan.js';

const gasPriceOracle = '0x420000000000000000000000000000000000000F';
const operatorFeeAbi = parseAbi(['function getOperatorFee(uint256 gasUsed) view returns (uint256)']);
const noEstimate = {ethApprox: null, gasApprox: null} satisfies DeployPlanEstimate;

export function usesBaseFeeBreakdown(chainId: number): boolean {
  return chainId === base.id || chainId === baseSepolia.id;
}

export async function estimateDeployFees(client: PublicClient, options: {
  chainId: number;
  account: Address | null;
  transactions?: PreparedTx[] | undefined;
  factoryGasFallback?: bigint | undefined;
  setupGas?: bigint[] | undefined;
  roughGas?: bigint | undefined;
  unavailableReason?: string | undefined;
}): Promise<DeployPlanEstimate> {
  const {chainId, account, transactions, factoryGasFallback, setupGas = [], roughGas} = options;
  const showBreakdown = usesBaseFeeBreakdown(chainId);
  if (!showBreakdown && roughGas === undefined) return noEstimate;

  const first = transactions?.[0];
  const gasPrice = first || roughGas !== undefined ? client.getGasPrice().catch(() => null) : null;
  const factoryGas = first && account
    ? await client.estimateGas({account, to: first.to ?? undefined, data: first.data, value: BigInt(first.value)}).catch(() => null)
    : null;
  const initialGas = factoryGas ?? factoryGasFallback;
  const perTxGas = initialGas === undefined ? null : [initialGas, ...setupGas];
  const gas = perTxGas?.reduce((sum, next) => sum + next, 0n) ?? roughGas ?? null;
  const price = await gasPrice;
  const execution = gas === null || price === null ? null : gas * price;
  const estimate: DeployPlanEstimate = {
    // Preserve the legacy execution-only fields and their display precision.
    ethApprox: execution === null ? null : execution < 10_000_000_000_000n ? '<0.00001' : Number(formatEther(execution)).toFixed(5),
    gasApprox: gas?.toString() ?? null,
  };
  if (!showBreakdown) return estimate;

  let l1DataFee: bigint | null = null;
  let operatorFee: bigint | null = null;
  if (transactions?.length && account) {
    l1DataFee = 0n;
    operatorFee = perTxGas ? 0n : null;
    for (const [index, tx] of transactions.entries()) {
      const gasUsed = perTxGas?.[index];
      const [l1, operator]: [bigint | null, bigint | null] = await Promise.all([
        l1DataFee === null ? null : estimateL1Fee(client, {
          chain: chainId === base.id ? base : baseSepolia, account,
          to: tx.to ?? undefined, data: tx.data, value: BigInt(tx.value), gasPriceOracleAddress: gasPriceOracle,
        }).catch(() => null),
        operatorFee === null || gasUsed === undefined ? null : client.readContract({
          address: gasPriceOracle, abi: operatorFeeAbi, functionName: 'getOperatorFee', args: [gasUsed],
        }).catch(() => null),
      ]);
      l1DataFee = l1 === null || l1DataFee === null ? null : l1DataFee + l1;
      operatorFee = operator === null || operatorFee === null ? null : operatorFee + operator;
    }
  }
  const total = execution === null || l1DataFee === null || operatorFee === null ? null : execution + l1DataFee + operatorFee;
  estimate.feeBreakdown = {
    executionGasSource: gas === null ? null : factoryGas !== null && setupGas.length === 0 ? 'rpc' : 'heuristic',
    gasPriceWei: price?.toString() ?? null,
    executionFeeWei: execution?.toString() ?? null,
    l1DataFeeWei: l1DataFee?.toString() ?? null,
    operatorFeeWei: operatorFee?.toString() ?? null,
    totalWei: total?.toString() ?? null,
    unavailableReason: total === null ? options.unavailableReason ?? 'One or more fee components could not be estimated from the RPC.' : null,
  };
  return estimate;
}

export function deployFeeLines(estimate: DeployPlanEstimate): string[] {
  const {feeBreakdown: fees} = estimate;
  if (!fees) {
    return estimate.ethApprox === null ? [] : [
      `Est. execution cost: ~${estimate.ethApprox} ETH (roughly ${BigInt(estimate.gasApprox!).toLocaleString()} gas; excludes rollup fees and off-chain storage)`,
    ];
  }
  const amount = (wei: string | null) => wei === null ? 'unavailable' : `${formatEther(BigInt(wei))} ETH`;
  const gas = estimate.gasApprox === null ? '' : ` (${fees.executionGasSource === 'rpc' ? 'RPC estimate' : 'rough estimate'} of ${BigInt(estimate.gasApprox).toLocaleString()} gas)`;
  return [
    `Execution fee: ${amount(fees.executionFeeWei)}${gas}`,
    `L1 data fee: ${amount(fees.l1DataFeeWei)}`,
    `Operator fee: ${amount(fees.operatorFeeWei)}`,
    `Est. total network fee: ${amount(fees.totalWei)} (standard wallet transactions; excludes off-chain storage)`,
    ...(fees.unavailableReason ? [fees.unavailableReason] : []),
  ];
}
