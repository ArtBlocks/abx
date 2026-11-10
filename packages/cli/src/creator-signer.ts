import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {
  AbxServiceClient,
  assertChainId,
  CREATOR_WALLET_INTERFACE,
  CreatorApiClient,
  makePublicClient,
  pinGas,
  resolveChain,
  chainSupportByKey,
  isChainSelectable,
  resolveServiceInterfaceEndpoint,
  sleep,
  TxRevertedError,
  waitForCodeAt,
  waitForTransactionReceiptResilient,
  type Address,
  type CreatorOperation,
  type Hex,
  type PreparedTx,
  type PublicClient,
} from '@artblocks/abx-sdk';
import {formatEther, formatGwei, type TransactionReceipt} from 'viem';
import {CreatorAgentAuthorization, restoreOrAuthorizeCreatorAgent} from './creator-agent.js';
import {CreatorKeyringStore} from './creator-keyring.js';
import {quoteCreatorPayment, assertCreatorSigningRequest, preflightCreatorPayment} from './creator-payment.js';
import {warn} from './output.js';
import {ABX_SERVICES_URL} from './remote.js';

const CREATOR_GRANTS_URL = 'https://services.abx.io/authorize';

/** Preserve the exact RPC estimate across the JSON service boundary. This is a serialization
 * guard, not a sponsorship-policy ceiling; real EVM transaction limits are many orders of
 * magnitude below Number.MAX_SAFE_INTEGER. */
export function sponsoredGasLimit(gas: bigint): number {
  const limit = Number(gas);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`Sponsored transaction gas estimate ${gas} cannot be represented safely.`);
  }
  return limit;
}

/** Synchronous preflight for commands that may upload content before opening the signing lane. */
export function assertSponsorConfigured(chainKey: string): void {
  assertSponsorConfiguredWithEnv(chainKey, process.env);
}

function assertSponsorConfiguredWithEnv(chainKey: string, env: NodeJS.ProcessEnv): void {
  const support = chainSupportByKey(chainKey);
  if (!support || !isChainSelectable(support)) {
    throw new Error(
      'The creator-wallet lane requires a selectable ABX network and live wallet eligibility.',
    );
  }
  if (!env.ABX_SERVICES_API_KEY) {
    throw new Error('--sponsor needs ABX_SERVICES_API_KEY in your ignored .env. Run `abx auth login` first.');
  }
}

/**
 * Resolve the existing account-bound creator wallet for a sponsored preview without provisioning
 * a wallet or opening an authorization grant. A dry run must use the signer that the real send
 * will use; silently falling back to a local env key changes the CREATE2 salt, owner, royalty
 * receiver, and mint recipient shown in the preview.
 */
export async function sponsoredPreviewAddress(
  chainKey: string,
  options: {env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch} = {},
): Promise<Address> {
  return sponsoredWalletAddress(chainKey, {...options, provision: false});
}

/** Resolve the account-bound creator wallet for a transaction plan. Real sponsored sends may
 * provision the stable wallet just as `openSponsoredSession` does; dry runs call the wrapper above
 * and remain strictly read-only. */
export async function sponsoredWalletAddress(
  chainKey: string,
  options: {env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; provision?: boolean} = {},
): Promise<Address> {
  const env = options.env ?? process.env;
  const chain = resolveChain(chainKey);
  assertSponsorConfiguredWithEnv(chainKey, env);
  const apiKey = env.ABX_SERVICES_API_KEY!;
  const api = new CreatorApiClient({
    baseUrl: await creatorApiUrl(chain.id, env),
    token: apiKey,
    fetchImpl: options.fetchImpl,
  });
  let account = await api.account();
  if (!account.wallet && options.provision) {
    await api.provisionWallet();
    account = await api.account();
  }
  if (!account.wallet || !account.capabilities.wallet) {
    throw new Error(
      options.provision
        ? 'ABX Services did not return the creator wallet after provisioning.'
        : 'Sponsored dry run needs an existing ABX creator wallet, but this account has not provisioned one yet. ' +
          'Run `abx auth wallet` once, then rerun; the preview will not create external state.',
    );
  }
  if (!(account.capabilities.selfPayment && account.capabilities.walletChains?.includes(chain.id)) &&
      !(account.capabilities.sponsorship && account.capabilities.sponsoredChains.includes(chain.id))) {
    throw new Error(`ABX creator-wallet payment is not enabled for ${chain.name} on this account.`);
  }
  return account.wallet.address;
}

export interface SponsoredReceipt {
  txHash: Hex;
  receipt: TransactionReceipt;
  paymentMode?: 'sponsored' | 'self-paid';
}

export interface SponsoredSession {
  address: Address;
  send(tx: PreparedTx): Promise<SponsoredReceipt>;
  close(): void;
}

/** Read the durable provider-side state of one account-scoped sponsored operation. This is the
 * recovery path for an RPC that disappears after submission: status reads never submit or replay. */
export async function sponsoredOperationStatus(
  chainKey: string,
  operationId: string,
  options: {env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch} = {},
): Promise<CreatorOperation> {
  const env = options.env ?? process.env;
  assertSponsorConfiguredWithEnv(chainKey, env);
  if (!/^op_[a-zA-Z0-9]+$/.test(operationId)) throw new Error('Invalid sponsored operation id.');
  const chain = resolveChain(chainKey);
  return new CreatorApiClient({
    baseUrl: await creatorApiUrl(chain.id, env, false),
    token: env.ABX_SERVICES_API_KEY!,
    fetchImpl: options.fetchImpl,
  }).getOperation(operationId);
}

/** A provider-confirmed operation is monotonic: a local RPC miss cannot turn it back into a failed
 * submission. Announce the durable identifiers before reading the receipt, then give a read-only
 * recovery command instead of an error that might invite a duplicate transaction. */
export async function confirmedSponsoredReceipt(
  publicClient: PublicClient,
  operation: CreatorOperation & {transactionHash: Hex},
  op: string,
  line: (message: string) => void = console.log,
): Promise<SponsoredReceipt> {
  const label = operation.paymentMode === 'self-paid' ? 'Self-paid' : 'Sponsored';
  line(`  ${label} operation ${operation.operationId} confirmed by ABX Services.`);
  line(`  Transaction: ${operation.transactionHash}`);
  let receipt: TransactionReceipt;
  try {
    receipt = await waitForTransactionReceiptResilient(publicClient, {hash: operation.transactionHash});
  } catch (cause) {
    throw new Error(
      `${label} operation ${operation.operationId} was submitted as ${operation.transactionHash}, but the configured RPCs ` +
        `could not read its receipt. Do not retry it. Run \`abx auth operation ${operation.operationId}\` or check the transaction in a block explorer.`,
      {cause},
    );
  }
  if (receipt.status !== 'success') throw new TxRevertedError(op, operation.transactionHash);
  return {txHash: operation.transactionHash, receipt, ...(operation.paymentMode ? {paymentMode: operation.paymentMode} : {})};
}

/** Pure boundary check shared by every sponsored operation. Privy's sponsored relay requires a
 * call target, so custom-contract deployments must already be expressed as a call to the keyless
 * CREATE2 proxy before they reach this boundary. */
export function assertCreatorPreparedTx(
  tx: PreparedTx,
  chainId: number,
): asserts tx is PreparedTx & {to: Address} {
  if (tx.chainId !== chainId) {
    throw new Error(`Refusing sponsored transaction for chain ${tx.chainId}; expected ${chainId}.`);
  }
  if (tx.to === null) {
    throw new Error(
      'ABX sponsorship requires a call target; use `abx deploy-contract --sponsor` to route exact initcode through CREATE2.',
    );
  }
}

/** Compatibility check for callers specifically preparing an ABX-paid transaction. */
export function assertSponsoredPreparedTx(tx: PreparedTx, chainId: number): asserts tx is PreparedTx & {to: Address} {
  if (BigInt(tx.value) !== 0n) throw new Error('ABX sponsorship never covers a transaction that transfers ETH.');
  assertCreatorPreparedTx(tx, chainId);
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
 * explicit local/staging escape hatch; production callers discover the interface from the
 * services catalog and do not need to know a deployment hostname. */
export async function creatorApiUrl(chainId: number, env: NodeJS.ProcessEnv = process.env, requireChain = true): Promise<string> {
  if (env.ABX_CREATORS_API_URL) return checkedCreatorApiUrl(env.ABX_CREATORS_API_URL);
  const descriptor = await new AbxServiceClient({baseUrl: ABX_SERVICES_URL, timeoutMs: 10_000}).descriptor();
  const endpoint = resolveServiceInterfaceEndpoint(ABX_SERVICES_URL, descriptor, CREATOR_WALLET_INTERFACE);
  if (!endpoint) {
    throw new Error('The ABX remote does not advertise an account-bound creator-wallet service. Use --send, --sign, or --unsigned.');
  }
  if (requireChain && !endpoint.chains.includes(chainId)) {
    throw new Error(`The ABX creator-wallet service does not support chain ${chainId}. Use --send, --sign, or --unsigned.`);
  }
  return endpoint.baseUrl;
}

/** Provision or reuse the stable first-party creator wallet without entering a sponsorship lane. */
export async function provisionCreatorWallet(
  options: {env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch} = {},
): Promise<{address: Address; created: boolean}> {
  const env = options.env ?? process.env;
  const apiKey = env.ABX_SERVICES_API_KEY;
  if (!apiKey) throw new Error('Creator wallet setup needs ABX_SERVICES_API_KEY. Run `abx auth login` first.');
  const baseUrl = env.ABX_CREATORS_API_URL
    ? checkedCreatorApiUrl(env.ABX_CREATORS_API_URL)
    : await (async () => {
        const descriptor = await new AbxServiceClient({baseUrl: ABX_SERVICES_URL, timeoutMs: 10_000}).descriptor();
        const endpoint = resolveServiceInterfaceEndpoint(ABX_SERVICES_URL, descriptor, CREATOR_WALLET_INTERFACE);
        if (!endpoint) throw new Error('ABX Services does not advertise a creator-wallet service.');
        return endpoint.baseUrl;
      })();
  const wallet = await new CreatorApiClient({baseUrl, token: apiKey, fetchImpl: options.fetchImpl}).provisionWallet();
  return {address: wallet.address, created: wallet.created};
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
 * Open a creator authorization session. Privy's rotating grant is retained in the user's native OS
 * credential store and reused across CLI invocations. The decrypted request-signing key remains
 * memory-only and every exact transaction is still prepared, signed, and reconciled independently.
 */
export async function openSponsoredSession(chainKey: string): Promise<SponsoredSession> {
  const chain = resolveChain(chainKey);
  assertSponsorConfigured(chainKey);
  await assertChainId(chainKey);
  const apiKey = process.env.ABX_SERVICES_API_KEY;
  if (!apiKey) throw new Error('ABX Services API key disappeared after sponsorship preflight.');

  const api = new CreatorApiClient({baseUrl: await creatorApiUrl(chain.id), token: apiKey});
  const wallet = await api.provisionWallet();
  const account = await api.account();
  if (!account.wallet || !account.capabilities.wallet || account.wallet.address.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error('ABX Creators returned inconsistent wallet binding. Nothing was signed.');
  }
  if (!(account.capabilities.selfPayment && account.capabilities.walletChains?.includes(chain.id)) &&
      !(account.capabilities.sponsorship && account.capabilities.sponsoredChains.includes(chain.id))) {
    throw new Error(`ABX creator-wallet payment is not enabled for ${chain.name} on this account.`);
  }

  let persistenceWarningShown = false;
  const persistenceWarning = () => {
    if (persistenceWarningShown) return;
    persistenceWarningShown = true;
    warn('Could not use the OS credential store. This authorization works for the current command only.');
  };
  const store = new CreatorKeyringStore(wallet.providerAppId, wallet.address);
  const authorization = new CreatorAgentAuthorization({
    appId: wallet.providerAppId,
    store,
    onPersistenceError: persistenceWarning,
  });
  try {
    const {wallets, newlyApproved} = await restoreOrAuthorizeCreatorAgent(authorization, {
      checkingStore: () => {
        console.log(`  Checking the saved ABX creator-wallet authorization for ${wallet.address} in your OS credential store.`);
        if (process.platform === 'darwin') {
          console.log('  macOS may ask whether Node can access it. This is saved-authorization access; your Mac password stays with macOS.');
        }
      },
      device: (device) => {
        const verificationUrl = device.verificationUriComplete ?? device.verificationUri;
        console.log(`\n  Authorize this agent to use your ABX creator wallet:`);
        console.log(`  ${verificationUrl}`);
        console.log(`  Code: ${device.userCode}\n`);
        console.log('  Waiting for human approval. Open the URL above if no browser appears; Ctrl-C stops this authorization attempt.');
        openBrowser(verificationUrl);
      },
    });
    const authorized = wallets.find(
      (candidate) => candidate.chainType === 'ethereum' && candidate.address.toLowerCase() === wallet.address.toLowerCase(),
    );
    if (!authorized) throw new Error(`Privy authorized a different wallet; expected ${wallet.address}.`);
    if (newlyApproved) {
      try {
        await authorization.remember();
        console.log(`  Agent access saved in your OS credential store. Manage or revoke it at ${CREATOR_GRANTS_URL}.\n`);
      } catch {
        persistenceWarning();
      }
    }

    const publicClient = makePublicClient({chainKey});
    let closed = false;
    return {
      address: wallet.address,
      async send(tx: PreparedTx): Promise<SponsoredReceipt> {
        if (closed) throw new Error('The creator authorization session is closed.');
        assertCreatorPreparedTx(tx, chain.id);
        await preflightCreatorPayment(publicClient, account, tx);
        if (tx.gasFloor && tx.to) await waitForCodeAt(publicClient, tx.to);
        const gas = await pinGas(publicClient, {
          from: wallet.address,
          to: tx.to,
          data: tx.data,
          value: tx.value,
          gasFloor: tx.gasFloor,
        });
        const operationId = `op_${randomUUID().replaceAll('-', '')}`;
        const payment = await quoteCreatorPayment(publicClient, account, tx, gas);
        console.log(payment.mode === 'self-paid' ? `  Creator wallet pays value and gas (funds required ≈${formatEther(payment.requiredBalance)} ETH; execution fee capped at ${formatGwei(BigInt(payment.maxFeePerGas))} gwei/gas, rollup fees estimated).` : '  ABX pays eligible gas.');
        const gasLimit = sponsoredGasLimit(gas);
        const prepared = await api.prepare({
          operationId,
          chainId: chain.id,
          to: tx.to,
          value: tx.value,
          data: tx.data,
          gasLimit,
          ...(payment.mode === 'self-paid' ? {paymentMode: payment.mode, maxFeePerGas: payment.maxFeePerGas, maxPriorityFeePerGas: payment.maxPriorityFeePerGas} : {}),
        });
        assertCreatorSigningRequest(prepared, {accountId: account.accountId, operationId, walletId: authorized.id, wallet: wallet.address, tx, gasLimit, payment});
        const signed = await authorization.sign({
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
        while (
          operation.state === 'prepared' ||
          operation.state === 'submitting' ||
          operation.state === 'pending' ||
          operation.state === 'unknown'
        ) {
          if (Date.now() >= deadline) {
            throw new Error(
              `Creator-wallet operation ${operationId} could not be reconciled. It may have been submitted; check its status before doing anything else and do not retry it.`,
            );
          }
          await sleep(1_500);
          operation = await api.getOperation(operationId);
        }
        if (operation.state !== 'confirmed' || !operation.transactionHash) {
          throw new Error(`Creator-wallet operation ${operationId} failed${operation.errorCode ? ` (${operation.errorCode})` : ''}.`);
        }
        return confirmedSponsoredReceipt(
          publicClient,
          operation as CreatorOperation & {transactionHash: Hex},
          tx.op,
        );
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
