/**
 * sandbox-wallet.ts — ephemeral per-room deployer wallets for parallel FUNDED agent sweeps.
 *
 * WHY THIS EXISTS
 * The sweep harness's rule was "at most one funded agent per account and chain". That constraint is
 * not about funding, it is about ONE KEY'S NONCE SPACE: two agents signing with the same key both
 * read nonce N, both submit, and one gets `nonce too low` or silently replaces the other's
 * transaction. Those failures look exactly like product bugs, which invalidates the sweep.
 *
 * Give every room its OWN keypair and the contention is gone by construction — and the room also
 * becomes a more faithful simulation of a real creator (a fresh wallet with a small balance, not a
 * treasury key carrying hundreds of fixtures of history).
 *
 * WHAT FRESH WALLETS DO NOT FIX — read `preflight` before trusting parallelism
 * The SDK's `ensure*` helpers BOOTSTRAP chain-global singletons on demand, at CREATE2-deterministic
 * addresses. If N rooms each find one missing, they all race to deploy the SAME address: one wins,
 * the rest revert, and you spend an afternoon chasing a phantom regression. `preflight` refuses to
 * fan out until every manifest singleton already has code on the target chain.
 *
 * Testnet only. Never prints a private key.
 *
 *   node --import tsx scripts/sandbox-wallet.ts preflight --chain sepolia
 *   node --import tsx scripts/sandbox-wallet.ts new --out .sandbox-x/.ephemeral-wallet.json
 *   node --import tsx scripts/sandbox-wallet.ts fund --file .sandbox-x/.ephemeral-wallet.json --eth 0.01
 *   node --import tsx scripts/sandbox-wallet.ts sweep --file .sandbox-x/.ephemeral-wallet.json
 *   node --import tsx scripts/sandbox-wallet.ts report
 */
import {readFileSync, writeFileSync, existsSync, readdirSync} from 'node:fs';
import {formatEther, parseEther, type Address, type Hex} from 'viem';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {getDeployment, makePublicClient, makeWalletClient, resolveChain} from '../packages/sdk/src/index.js';
import {loadDotEnv} from '../packages/sdk/src/env.js';

// The SDK reads credentials from `process.env`; the CLI's own bootstrap is what normally populates
// it from `.env`. A standalone script has to do that itself or the treasury key is simply invisible.
loadDotEnv();

// Caps so a bug cannot walk the treasury across a dozen rooms. Deliberately low: a room needs gas
// for a handful of testnet transactions, not a war chest.
const MAX_PER_ROOM_ETH = Number(process.env.ABX_SWEEP_MAX_ROOM_ETH ?? '0.01');
const MAX_TOTAL_ETH = Number(process.env.ABX_SWEEP_MAX_TOTAL_ETH ?? '0.06');

type WalletFile = {address: Address; privateKey: Hex; chain: string; fundedEth?: string; sweptEth?: string};

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const chainKey = flag('chain') ?? process.env.ABX_CHAIN ?? 'base-sepolia';

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** Every chain-global address the deployment manifest pins, so the check is generic: a new singleton
 *  added to the manifest is covered automatically instead of needing a line here. */
function manifestAddresses(chainId: number): Array<[string, Address]> {
  const d = getDeployment(chainId) as Record<string, unknown> | undefined;
  if (!d) die(`no deployment manifest for chainId ${chainId}`);
  return Object.entries(d)
    .filter((e): e is [string, Address] => typeof e[1] === 'string' && /^0x[0-9a-fA-F]{40}$/.test(e[1]))
    .sort();
}

async function preflight(): Promise<void> {
  const chain = resolveChain(chainKey);
  const client = makePublicClient({chainKey});
  const entries = manifestAddresses(chain.id);
  console.log(`\n  singleton preflight — ${chainKey} (chainId ${chain.id})\n`);
  const missing: string[] = [];
  for (const [name, addr] of entries) {
    const code = await client.getCode({address: addr}).catch(() => undefined);
    const present = !!code && code !== '0x';
    console.log(`  ${present ? '✓' : '✗'} ${name.padEnd(26)} ${addr}${present ? '' : '   NO CODE'}`);
    if (!present) missing.push(name);
  }
  if (missing.length) {
    console.error(
      `\n✗ ${missing.length} singleton(s) have no code on ${chainKey}: ${missing.join(', ')}\n` +
        `  DO NOT fan out parallel funded rooms yet. Each room would try to bootstrap these at the same\n` +
        `  CREATE2 addresses and all but one would revert, which reads as a product bug. Bootstrap them\n` +
        `  ONCE from the treasury key first (any single funded deploy that needs them will do it), then\n` +
        `  re-run this preflight.`,
    );
    process.exit(1);
  }
  console.log(`\n✓ all ${entries.length} manifest singletons have code — safe to fan out funded rooms\n`);
}

function newWallet(): void {
  const out = flag('out') ?? die('new needs --out <file>');
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  const body: WalletFile = {address, privateKey, chain: chainKey};
  writeFileSync(out, JSON.stringify(body, null, 2) + '\n', {mode: 0o600});
  // The ADDRESS only. The key stays in the gitignored room file and is never echoed.
  console.log(address);
}

function loadWallet(): {file: string; w: WalletFile} {
  const file = flag('file') ?? die('needs --file <wallet json>');
  if (!existsSync(file)) die(`no wallet file at ${file}`);
  return {file, w: JSON.parse(readFileSync(file, 'utf8')) as WalletFile};
}

/** A balance read that tolerates a lagging node: a few bounded attempts, then `null` rather than a
 *  confidently wrong zero. `expectNonZero` is the whole point — we just funded it. */
async function settledBalance(client: {getBalance: (a: {address: Address}) => Promise<bigint>}, address: Address): Promise<bigint | null> {
  for (const waitMs of [0, 1_000, 2_000, 4_000]) {
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
    const bal = await client.getBalance({address}).catch(() => null);
    if (bal !== null && bal > 0n) return bal;
  }
  return null;
}

async function fund(): Promise<void> {
  const {file, w} = loadWallet();
  const eth = flag('eth') ?? '0.01';
  if (Number(eth) > MAX_PER_ROOM_ETH) die(`--eth ${eth} exceeds the per-room cap ${MAX_PER_ROOM_ETH} (raise ABX_SWEEP_MAX_ROOM_ETH deliberately)`);
  const already = totalDisbursed();
  if (already + Number(eth) > MAX_TOTAL_ETH) {
    die(`funding ${eth} would put total disbursement at ${(already + Number(eth)).toFixed(6)} ETH, over the ${MAX_TOTAL_ETH} cap`);
  }
  const {wallet, account} = makeWalletClient({chainKey: w.chain});
  const client = makePublicClient({chainKey: w.chain});
  const hash = await wallet.sendTransaction({account, chain: resolveChain(w.chain), to: w.address, value: parseEther(eth)});
  await client.waitForTransactionReceipt({hash});
  writeFileSync(file, JSON.stringify({...w, fundedEth: eth}, null, 2) + '\n', {mode: 0o600});
  // A receipt does NOT mean the next read sees the balance: behind a failover transport the balance
  // query can land on a node that hasn't caught up, and this printed a flat `balance 0` seconds
  // after a confirmed transfer. Same read-after-write lag the CLI handles on the post-mint write
  // path. Retry briefly, and if it still lags say so instead of printing a number that is a lie.
  const bal = await settledBalance(client, w.address);
  console.log(`✓ funded ${w.address} with ${eth} ETH (balance ${bal === null ? 'read lagged — check `report`' : formatEther(bal)}) — ${hash}`);
}

/** Best-effort return of what's left. A sweep cannot return the FULL balance (its own transaction
 *  needs gas), so dust is expected and is reported rather than treated as an error. */
async function sweep(): Promise<void> {
  const {file, w} = loadWallet();
  const client = makePublicClient({chainKey: w.chain});
  const bal = await client.getBalance({address: w.address});
  if (bal === 0n) {
    console.log(`·  ${w.address} is empty — nothing to return`);
    return;
  }
  const {account: treasury} = makeWalletClient({chainKey: w.chain});
  const {wallet, account} = makeWalletClient({chainKey: w.chain, privateKey: w.privateKey});
  const fee = await client.estimateFeesPerGas().catch(() => null);
  const gasPrice = fee?.maxFeePerGas ?? (await client.getGasPrice());
  const gas = 21_000n;
  // 2x headroom on the fee: a sweep that reverts for underpricing leaves the funds stranded anyway,
  // and being slightly conservative only costs dust we already accept losing.
  const cost = gas * gasPrice * 2n;
  if (bal <= cost) {
    console.log(`·  ${w.address} holds ${formatEther(bal)} ETH — below the ${formatEther(cost)} it would cost to return it; leaving as dust`);
    return;
  }
  const value = bal - cost;
  try {
    const hash = await wallet.sendTransaction({account, chain: resolveChain(w.chain), to: treasury.address, value});
    await client.waitForTransactionReceipt({hash});
    writeFileSync(file, JSON.stringify({...w, sweptEth: formatEther(value)}, null, 2) + '\n', {mode: 0o600});
    // Deliberately NOT reporting a post-sweep balance here. Read immediately after the receipt it
    // came back as the PRE-sweep figure (the same lag `settledBalance` exists for, and unfixable the
    // same way because here the expected direction is DOWN, so "wait for a change" has no floor to
    // test against). `report` is the one authority for live balances; this line states only what
    // this transaction actually returned, which it knows for certain.
    console.log(`✓ returned ${formatEther(value)} ETH from ${w.address} to ${treasury.address} — ${hash}`);
    console.log(`   ${'`'}sandbox-wallet.ts report${'`'} for the live balance (a little dust always remains — the sweep pays its own gas)`);
  } catch (err) {
    // Never fail cleanup over worthless testnet dust — report it so an abandoned room is VISIBLE
    // instead of silently stranding funds.
    console.error(`⚠ could not return ${formatEther(bal)} ETH from ${w.address}: ${(err as Error).message.slice(0, 160)}`);
  }
}

function walletFiles(): string[] {
  return readdirSync('.')
    .filter((d) => d.startsWith('.sandbox-'))
    .map((d) => `${d}/.ephemeral-wallet.json`)
    .filter((f) => existsSync(f));
}

function totalDisbursed(): number {
  return walletFiles().reduce((sum, f) => {
    const w = JSON.parse(readFileSync(f, 'utf8')) as WalletFile;
    return sum + Number(w.fundedEth ?? 0) - Number(w.sweptEth ?? 0);
  }, 0);
}

async function report(): Promise<void> {
  const files = walletFiles();
  if (!files.length) {
    console.log('  no ephemeral sweep wallets');
    return;
  }
  console.log(`\n  ephemeral sweep wallets (${files.length})\n`);
  for (const f of files) {
    const w = JSON.parse(readFileSync(f, 'utf8')) as WalletFile;
    const bal = await makePublicClient({chainKey: w.chain}).getBalance({address: w.address}).catch(() => null);
    console.log(`  ${w.address}  ${w.chain.padEnd(13)} funded ${(w.fundedEth ?? '?').padEnd(8)} now ${bal === null ? '?' : formatEther(bal)}  ${f.split('/')[0]}`);
  }
  // "disbursed, not yet returned" -- NOT "recoverable". Most of the gap between this and the live
  // balances above is gas already spent, which no sweep can bring back. This figure is what the
  // budget cap governs (how much has left the treasury), so it must not read as a refund estimate.
  console.log(`\n  disbursed, not yet returned: ${totalDisbursed().toFixed(6)} ETH (cap ${MAX_TOTAL_ETH}) — spent gas is gone; only live balances above are recoverable\n`);
}

const run = {preflight, new: newWallet, fund, sweep, report}[cmd ?? ''];
if (!run) die(`usage: sandbox-wallet.ts <preflight|new|fund|sweep|report> [--chain k] [--file f] [--out f] [--eth n]`);
await run();
