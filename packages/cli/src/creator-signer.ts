import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {
  AbxServiceClient,
  CREATOR_WALLET_INTERFACE,
  CreatorApiClient,
  makePublicClient,
  pinGas,
  resolveChain,
  resolveServiceInterfaceEndpoint,
  sleep,
  TxRevertedError,
  waitForCodeAt,
  type Address,
  type Hex,
  type PreparedTx,
} from '@artblocks/abx-sdk';
import type {TransactionReceipt} from 'viem';
import {CreatorAgentAuthorization} from './creator-agent.js';
import {ABX_SERVICES_URL} from './remote.js';

const SPONSORABLE_BASE_CHAINS = new Set([8_453, 84_532]);
const MAX_SPONSORED_GAS = 3_000_000n;

/** Synchronous preflight for commands that may upload content before opening the signing lane. */
export function assertSponsorConfigured(chainKey: string): void {
  if (!SPONSORABLE_BASE_CHAINS.has(resolveChain(chainKey).id)) {
    throw new Error(
      '--sponsor is a beta for Base and Base Sepolia only, and still requires live provider and account eligibility. Use --send, --sign, or --unsigned on this network.',
    );
  }
  if (!process.env.ABX_SERVICES_API_KEY) {
    throw new Error('--sponsor needs ABX_SERVICES_API_KEY in your ignored .env. Run `abx auth login` first.');
  }
}

export interface SponsoredReceipt {
  txHash: Hex;
  receipt: TransactionReceipt;
}

export interface SponsoredSession {
  address: Address;
  send(tx: PreparedTx): Promise<SponsoredReceipt>;
  close(): void;
}

function checkedCreatorApiUrl(raw: string): string {
  const parsed = new URL(raw);
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:'))
  ) {
    throw new Error(
      'ABX_CREATORS_API_URL must be HTTPS (or localhost HTTP for development) without credentials, a query, or a fragment.',
    );
  }
  return parsed.toString().replace(/\/+$/, '');
}

/** Resolve the first-party wallet API from its public remote catalog. The env override is an
 * explicit local/staging escape hatch; production callers do not need to know `api.abx.io`. */
export async function creatorApiUrl(chainId: number, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.ABX_CREATORS_API_URL) return checkedCreatorApiUrl(env.ABX_CREATORS_API_URL);
  const descriptor = await new AbxServiceClient({baseUrl: ABX_SERVICES_URL, timeoutMs: 10_000}).descriptor();
  const endpoint = resolveServiceInterfaceEndpoint(ABX_SERVICES_URL, descriptor, CREATOR_WALLET_INTERFACE);
  if (!endpoint) {
    throw new Error('The ABX remote does not advertise an account-bound creator-wallet service. Use --send, --sign, or --unsigned.');
  }
  if (!endpoint.chains.includes(chainId)) {
    throw new Error(`The ABX creator-wallet service does not support chain ${chainId}. Use --send, --sign, or --unsigned.`);
  }
  return endpoint.baseUrl;
}

function openBrowser(url: string): void {
  if (process.env.CI) return;
  try {
    const command =
      process.platform === 'darwin'
        ? {file: 'open', args: [url]}
        : process.platform === 'win32'
          ? {file: 'rundll32', args: ['url.dll,FileProtocolHandler', url]}
          : {file: 'xdg-open', args: [url]};
    const child = spawn(command.file, command.args, {detached: true, stdio: 'ignore'});
    child.on('error', () => {});
    child.unref();
  } catch {
    // The complete URL and code are always printed below.
  }
}

/**
 * Open one short-lived creator authorization session. The human authorizes the agent once; every
 * exact transaction in this CLI invocation is then signed by that same ephemeral grant. Neither the
 * OAuth token nor the decrypted authorization key is written to disk or returned to callers.
 */
export async function openSponsoredSession(chainKey: string): Promise<SponsoredSession> {
  const chain = resolveChain(chainKey);
  assertSponsorConfigured(chainKey);
  const apiKey = process.env.ABX_SERVICES_API_KEY;
  if (!apiKey) throw new Error('ABX Services API key disappeared after sponsorship preflight.');

  const api = new CreatorApiClient({baseUrl: await creatorApiUrl(chain.id), token: apiKey});
  const wallet = await api.provisionWallet();
  const account = await api.account();
  if (!account.wallet || account.wallet.address.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error('ABX Creators returned inconsistent wallet binding. Nothing was signed.');
  }
  if (!account.capabilities.sponsorship || !account.capabilities.sponsoredChains.includes(chain.id)) {
    throw new Error(`ABX gas sponsorship is not enabled for ${chain.name} on this account.`);
  }

  const authorization = new CreatorAgentAuthorization({appId: wallet.providerAppId});
  try {
    const device = await authorization.start();
    const verificationUrl = device.verificationUriComplete ?? device.verificationUri;
    console.log(`\n  Authorize this agent once for the transaction group:`);
    console.log(`  ${verificationUrl}`);
    console.log(`  Code: ${device.userCode}\n`);
    openBrowser(verificationUrl);
    const wallets = await authorization.wait();
    const authorized = wallets.find(
      (candidate) => candidate.chainType === 'ethereum' && candidate.address.toLowerCase() === wallet.address.toLowerCase(),
    );
    if (!authorized) throw new Error(`Privy authorized a different wallet; expected ${wallet.address}.`);

    const publicClient = makePublicClient({chainKey});
    let closed = false;
    return {
      address: wallet.address,
      async send(tx: PreparedTx): Promise<SponsoredReceipt> {
        if (closed) throw new Error('The creator authorization session is closed.');
        if (tx.chainId !== chain.id) throw new Error(`Refusing sponsored transaction for chain ${tx.chainId}; expected ${chain.id}.`);
        if (!tx.to) throw new Error('Direct contract creation is not sponsored; deploy through an ABX factory.');
        if (BigInt(tx.value) !== 0n) throw new Error('ABX sponsorship never covers a transaction that transfers ETH.');
        if (tx.gasFloor) await waitForCodeAt(publicClient, tx.to);
        const gas = await pinGas(publicClient, {
          from: wallet.address,
          to: tx.to,
          data: tx.data,
          value: tx.value,
          gasFloor: tx.gasFloor,
        });
        if (gas > MAX_SPONSORED_GAS) {
          throw new Error(`This transaction needs ${gas} gas; the ABX sponsorship beta caps each transaction at ${MAX_SPONSORED_GAS}.`);
        }

        const operationId = `op_${randomUUID().replaceAll('-', '')}`;
        const prepared = await api.prepare({
          operationId,
          chainId: chain.id,
          to: tx.to,
          value: tx.value,
          data: tx.data,
          gasLimit: Number(gas),
        });
        const signed = authorization.sign({
          walletId: prepared.signingRequest.walletId,
          body: prepared.signingRequest.body,
          idempotencyKey: prepared.signingRequest.idempotencyKey,
          requestExpiry: prepared.signingRequest.requestExpiry,
        });
        let operation = await api.submit(operationId, {
          requestExpiry: prepared.signingRequest.requestExpiry,
          data: tx.data,
          signed,
        });
        const deadline = Date.now() + 180_000;
        while (operation.state === 'prepared' || operation.state === 'submitting' || operation.state === 'pending') {
          if (Date.now() >= deadline) {
            throw new Error(`Sponsored operation ${operationId} is still pending. Check its status before doing anything else; do not retry it.`);
          }
          await sleep(1_500);
          operation = await api.getOperation(operationId);
        }
        if (operation.state === 'unknown') {
          throw new Error(`Sponsored operation ${operationId} has an unknown provider outcome. Inspect it before doing anything else; do not retry it.`);
        }
        if (operation.state !== 'confirmed' || !operation.transactionHash) {
          throw new Error(`Sponsored operation ${operationId} failed${operation.errorCode ? ` (${operation.errorCode})` : ''}.`);
        }
        const receipt = await publicClient.waitForTransactionReceipt({hash: operation.transactionHash});
        if (receipt.status !== 'success') throw new TxRevertedError(tx.op, operation.transactionHash);
        return {txHash: operation.transactionHash, receipt};
      },
      close() {
        closed = true;
        authorization.dispose();
      },
    };
  } catch (error) {
    authorization.dispose();
    throw error;
  }
}
