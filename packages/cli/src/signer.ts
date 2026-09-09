import {createServer, type IncomingMessage, type ServerResponse, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {writeFileSync} from 'node:fs';
import {
  makeHotSender,
  makePublicClient,
  makeWalletClient,
  pinGas,
  resolveChain,
  runPrepared,
  sleep,
  waitForCodeAt,
  type Address,
  type Hex,
  type PreparedTx,
} from '@artblocks/abx-sdk';
import type {TransactionReceipt} from 'viem';
import {faucetHint} from './config.js';

/**
 * The signing harness — the one place a write transaction turns into a signature.
 *
 * The CLI builds an unsigned {@link PreparedTx}; this picks the *lane* that signs it:
 *
 *   • send (hot)     — sign with the env key and broadcast. Autonomous agents, testnet, low stakes.
 *   • sign (wallet)  — serve a one-shot, operation-aware localhost page; a human approves in their
 *                      own wallet (the key never touches this process). Real value, mainnet.
 *   • unsigned (cold)— print the tx data to sign elsewhere (a multisig / offline signer).
 *
 * The agent picks the lane; the CLI owns the mechanics. Signing is the only step
 * that ever differs — everything up to the prepared tx, and the re-index after,
 * is identical across lanes.
 */
export type Lane = 'send' | 'sign' | 'unsigned';

/** A prepared tx, or — when the signer's address is needed to build it (deploy) — a builder of one. */
export type TxProvider = PreparedTx | ((signer: Address) => PreparedTx | Promise<PreparedTx>);

export interface SignOptions {
  lane: Lane;
  chainKey: string;
  /** The address that must sign (onlyOwner / token holder). Shown to the human; guards the hot lane. */
  expectedSigner?: Address;
  /** Allow the hot lane on a non-testnet chain (a deliberate mainnet spend). */
  yes?: boolean;
  /** Port for the wallet-lane sign page. */
  port?: number;
  /** Write the sign-page URL to this file the instant the server is ready — a deterministic,
   *  race-free way for an agent driving this in the background to capture + relay the URL. */
  signUrlFile?: string;
}

/** Announce the wallet sign-page URL: a stable, greppable line for humans/agents, plus an
 *  optional file write so a backgrounding agent can read the URL without parsing stdout. */
function announceSignUrl(signUrl: string, file?: string): void {
  // A machine-stable marker line (distinct from the prose below) — easy to grep from a
  // backgrounded process's output: `ABX_SIGN_URL=http://localhost:8799`.
  console.log(`  ${dim('ABX_SIGN_URL=')}${bold(signUrl)}`);
  if (file) {
    try {
      writeFileSync(file, signUrl + '\n');
    } catch {
      /* best-effort — the printed line is the fallback */
    }
  }
}

export interface SignResult {
  txHash: Hex;
  prepared: PreparedTx;
  blockNumber: bigint;
}

const DEFAULT_SIGN_PORT = 8799;
const TESTNETS = new Set(['sepolia', 'base-sepolia']);

// ── tiny ANSI (kept local so this module stands alone) ───────────────────────
const C = {reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[38;5;115m', purple: '\x1b[38;5;141m', orange: '\x1b[38;5;215m'};
const dim = (s: string) => `${C.dim}${s}${C.reset}`;
const bold = (s: string) => `${C.bold}${s}${C.reset}`;
const purple = (s: string) => `${C.purple}${s}${C.reset}`;
const green = (s: string) => `${C.green}${s}${C.reset}`;

function explorerFor(chainKey: string): string {
  const chain = resolveChain(chainKey);
  return chain.blockExplorers?.default?.url ?? '';
}

async function resolveTx(provider: TxProvider, signer: Address): Promise<PreparedTx> {
  return typeof provider === 'function' ? await provider(signer) : provider;
}

/**
 * Bind the sign page to a *fresh* port, robustly.
 *
 * Each owner op is a separate short-lived CLI process, and they all prefer the same port
 * (8799) — nice for humans, and it lets the wallet remember the connection across a
 * sequence. But that also means a previous op's server can still be draining on it (a
 * finished session lingers ~1s before its socket drops), or a stuck/abandoned session can
 * still be holding it. Binding naively then either (a) hands the new action to a server that
 * is *already finished* — so the page connects and instantly shows "done" (last op's success,
 * not this one) — or (b) throws EADDRINUSE and the process dies before its page ever appears.
 *
 * So: try the preferred port with a few quick retries (covers a previous session draining),
 * then fall back to an OS-assigned ephemeral port. A new action therefore ALWAYS gets its own
 * fresh server — never one a finished session is still answering. Callers must announce the
 * ACTUAL bound port (returned here), never the requested one.
 */
async function listenAvailable(server: Server, preferred: number): Promise<number> {
  const tryListen = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const onError = () => {
        server.removeListener('error', onError);
        resolve(false); // EADDRINUSE (or any bind failure) → unavailable; caller retries / falls back
      };
      server.once('error', onError);
      server.listen(port, () => {
        server.removeListener('error', onError);
        resolve(true);
      });
    });

  // ~1.8s of quick retries: reclaim the friendly port the moment a draining prior session lets go.
  for (let i = 0; i < 6; i++) {
    if (await tryListen(preferred)) return preferred;
    await sleep(300);
  }
  // Still held (a stuck/abandoned session) → don't block or crash; take a fresh ephemeral port.
  if (await tryListen(0)) return (server.address() as AddressInfo).port;
  throw new Error('could not bind a local port for the wallet signing page');
}

function printIntent(prepared: PreparedTx, opts: SignOptions): void {
  console.log(`\n  ${purple('◆')} ${bold(prepared.summary)}`);
  for (const [k, v] of Object.entries(prepared.fields)) console.log(`    ${dim(k.padEnd(10))} ${v}`);
  if (opts.expectedSigner) console.log(`    ${dim('sign as'.padEnd(10))} ${opts.expectedSigner}`);
}

/**
 * Sign and (for hot/wallet) broadcast a prepared tx via the chosen lane. Returns
 * the broadcast tx hash, or `null` for the cold lane (nothing is sent — the
 * caller hands the printed tx to an external signer).
 */
export async function signTx(provider: TxProvider, opts: SignOptions): Promise<SignResult | null> {
  switch (opts.lane) {
    case 'send':
      return signHot(provider, opts);
    case 'sign':
      return signWallet(provider, opts);
    case 'unsigned':
      return signCold(provider, opts);
  }
}

// ── hot lane: env key signs + broadcasts ─────────────────────────────────────
async function signHot(provider: TxProvider, opts: SignOptions): Promise<SignResult> {
  if (!TESTNETS.has(opts.chainKey) && !opts.yes) {
    throw new Error(
      `Refusing to sign on '${opts.chainKey}' with the env key without --yes. ` +
        `For real value, prefer the wallet lane (--sign) so the key never touches this process.`,
    );
  }
  const {wallet, account} = makeWalletClient({chainKey: opts.chainKey});
  const publicClient = makePublicClient({chainKey: opts.chainKey});
  const prepared = await resolveTx(provider, account.address);
  printIntent(prepared, opts);
  if (opts.expectedSigner && opts.expectedSigner.toLowerCase() !== account.address.toLowerCase()) {
    console.log(
      `\n  ${C.orange}⚠${C.reset} env key ${account.address} is not the expected signer ${opts.expectedSigner} — this will likely revert.`,
    );
  }
  console.log(`\n  ${dim(`signing with env key ${account.address} …`)}`);
  // makeHotSender pins the gas (rather than letting viem re-estimate at send time — see
  // execute.ts's pinGas for why an estimate can come back as the calldata cost alone and silently
  // underfund a CREATE) and throws a typed error on a `reverted` receipt instead of reporting a
  // burned transaction as "confirmed".
  const send = makeHotSender({wallet, account, publicClient});
  const receipt = await send(prepared);
  console.log(`  ${dim('tx')} ${explorerFor(opts.chainKey)}/tx/${receipt.transactionHash}`);
  console.log(`  ${green('✓')} confirmed`);
  return {txHash: receipt.transactionHash, prepared, blockNumber: receipt.blockNumber};
}

/**
 * Sign + broadcast a SEQUENCE of prepared txs on the hot lane, in order — the hot-lane sibling of
 * the wallet lane's `openWalletSession({total: N})` (one session, N approvals) and the cold lane's
 * per-tx `signTx` loop (see e.g. `deploy-code`'s cold-lane branch in main.ts). One
 * {@link makeHotSender} for the whole sequence, so the nonce is pinned once and gas is re-checked
 * per tx against the target a PRIOR tx in this same sequence may just have created (a multi-tx code
 * deploy: the setup multicall targets the clone the deploy tx just made). Replaces what used to be
 * a hand-rolled nonce/gas loop at the one call site that needed it.
 */
export async function signHotSequence(txs: PreparedTx[], opts: {chainKey: string; yes?: boolean}): Promise<SignResult[]> {
  if (!TESTNETS.has(opts.chainKey) && !opts.yes) {
    throw new Error(
      `Refusing to sign on '${opts.chainKey}' with the env key without --yes. ` +
        `For real value, prefer the wallet lane (--sign) so the key never touches this process.`,
    );
  }
  const {wallet, account} = makeWalletClient({chainKey: opts.chainKey});
  const publicClient = makePublicClient({chainKey: opts.chainKey});
  console.log(`\n  ${dim(`signing ${txs.length} transaction(s) with env key ${account.address} …`)}`);
  const send = makeHotSender({
    wallet,
    account,
    publicClient,
    onEvent: (e) => {
      if (e.kind === 'sending') console.log(`  ${purple('◆')} ${bold(e.tx.summary)}`);
      else console.log(`  ${dim('tx')} ${explorerFor(opts.chainKey)}/tx/${e.receipt.transactionHash}  ${green('✓')} confirmed`);
    },
  });
  const receipts = await runPrepared(txs, send);
  return receipts.map((receipt, i) => ({txHash: receipt.transactionHash, prepared: txs[i], blockNumber: receipt.blockNumber}));
}

// ── cold lane: print the tx for an external signer ───────────────────────────
async function signCold(provider: TxProvider, opts: SignOptions): Promise<null> {
  if (typeof provider === 'function' && !opts.expectedSigner) {
    throw new Error('This op needs the signer address to build its tx. Pass --from <address> with --unsigned.');
  }
  const prepared = await resolveTx(provider, opts.expectedSigner ?? ('0x0000000000000000000000000000000000000000' as Address));
  printIntent(prepared, opts);
  console.log(`\n  ${bold('unsigned transaction')} ${dim('— sign + broadcast this with your own signer (multisig / offline):')}\n`);
  console.log(
    JSON.stringify(
      {
        to: prepared.to,
        data: prepared.data,
        value: prepared.value,
        chainId: prepared.chainId,
        // NOT a gas limit — a floor the external signer's own estimate must clear. Emitting it as
        // `gas` would be wrong: it covers only the provable code-deposit cost, not the schema /
        // dependency / mint legs riding the same multicall, so a signer that used it verbatim would
        // under-fund the transaction. See execute.ts.
        ...(prepared.gasFloor ? {gasMustExceed: prepared.gasFloor} : {}),
      },
      null,
      2,
    )
      .split('\n')
      .map((l) => '    ' + l)
      .join('\n'),
  );
  if (prepared.gasFloor) {
    console.log(
      `\n  ${C.orange}⚠${C.reset} ${bold('gasMustExceed')} ${dim('is a floor, not a limit.')} This tx stores bytes on-chain, which costs\n` +
        `    200 gas/byte in code deposit alone. If your signer's gas estimate comes back BELOW ${BigInt(prepared.gasFloor)},\n` +
        `    it is estimating against stale state (the target contract not visible yet) — re-estimate rather than\n` +
        `    sending, or it reverts ${bold('DeploymentFailed()')} and the gas is lost.`,
    );
  }
  // `index` alone fails on a node that never registered the project ("isn't indexed by this node"),
  // which is the common case for an unsigned tx handed to someone else's signer. `add` is idempotent
  // and registers + indexes, so naming it first works from either state.
  console.log(
    `\n  ${dim('Then run')} ${bold('abx add <address>')} ${dim('(or')} ${bold('abx index <address>')} ${dim('if this node already tracks it) to reflect it once mined.')}\n`,
  );
  return null;
}

// ── wallet lane: a single tx, on the SAME hardened session as staged deploys ──
// Owner ops and off-chain-custody deploys are a single tx, but they get the exact same
// guard-rich page: connect once, network + signer verified (and re-verified live right
// before signing), then approve. A builder provider (deploy) is resolved against the
// CONNECTED signer — which the session pins to `expectedSigner` (page + server both refuse a
// mismatch) — so the owner/mintTo can never be a wallet you didn't intend.
async function signWallet(provider: TxProvider, opts: SignOptions): Promise<SignResult> {
  const session = await openWalletSession({
    chainKey: opts.chainKey,
    expectedSigner: opts.expectedSigner,
    port: opts.port,
    signUrlFile: opts.signUrlFile,
    total: 1,
  });
  try {
    const signer = await session.connect();
    const prepared = await resolveTx(provider, signer);
    const {txHash, receipt} = await session.send(prepared);
    return {txHash, prepared, blockNumber: receipt.blockNumber};
  } finally {
    session.close();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ── wallet SESSION: one page, connect once, sign 1..N txs in sequence ─────────
/**
 * The one sign-page implementation behind the whole wallet lane — single owner ops AND
 * multi-tx staged deploys both run through it ({@link signWallet} just opens one with
 * `total: 1`). It keeps a single page open: the human connects once, then approves each tx as
 * the CLI produces it (`Transaction 1 of N`, …). Each tx's receipt can feed the next (a
 * chunk's pointers determine the manifest), so the CLI drives the sequence and the page just
 * follows. Every signature is gated on the right NETWORK and the right SIGNING WALLET, checked
 * live in the page (and re-checked at sign time) and enforced server-side on `/connect`, so a
 * wrong-chain or wrong-wallet tx can never be queued. The key never touches this process.
 */
export interface SignedReceipt {
  txHash: Hex;
  receipt: TransactionReceipt;
}

export interface WalletSession {
  /** Resolves once the human connects a wallet in the browser; yields the connected address. */
  connect(): Promise<Address>;
  /** Show + sign the next tx through the open page; resolves with its hash + mined receipt. */
  send(tx: PreparedTx): Promise<SignedReceipt>;
  /** Show + `personal_sign` a message through the open page; resolves with the `0x` signature. Used
   *  to sign Arweave/Turbo upload data-items with the connected wallet (its credits then pay). */
  signMessage(message: Uint8Array, summary?: string): Promise<Hex>;
  /** No more items — the page shows "all done", then the server closes. */
  close(): void;
}

/** Uint8Array → `0x…` hex (for handing a data-item's signature-data to the browser to personal_sign). */
function bytesToHex(b: Uint8Array): Hex {
  let s = '0x';
  for (const byte of b) s += byte.toString(16).padStart(2, '0');
  return s as Hex;
}

export interface WalletSessionOptions {
  chainKey: string;
  /** The address that should sign (owner / deployer). Shown to the human; mismatch warns. */
  expectedSigner?: Address;
  port?: number;
  /** Total tx count if known up front — rendered as "Transaction N of total". */
  total?: number;
  /** Write the sign-page URL to this file the instant the server is ready (agent capture). */
  signUrlFile?: string;
}

export async function openWalletSession(opts: WalletSessionOptions): Promise<WalletSession> {
  const preferredPort = opts.port ?? DEFAULT_SIGN_PORT;
  const chain = resolveChain(opts.chainKey);
  const publicClient = makePublicClient({chainKey: opts.chainKey});
  const explorer = explorerFor(opts.chainKey);

  let resolveConnect: (a: Address) => void;
  let rejectAll: (e: Error) => void;
  const connected = new Promise<Address>((res, rej) => {
    resolveConnect = res;
    rejectAll = rej;
  });

  // The single item the page should currently show; `consumed` flips once it's signed, so `/next`
  // returns idle until the CLI queues the next. An item is either an EVM tx (eth_sendTransaction →
  // txHash) or a message to sign (personal_sign → signature) — the latter is how the wallet signs
  // Turbo (Arweave) upload data-items so its own credits pay. Both resolve `pendingResolve` with a
  // Hex value (a txHash or a signature); only one item is ever in flight.
  // `tx` carries an optional resolved `gas` (hex) the CLI pinned for this item — the page forwards it
  // to `eth_sendTransaction` rather than letting the wallet estimate. See send() below.
  let current: {index: number; kind: 'tx' | 'msg'; tx?: PreparedTx & {gas?: Hex}; msg?: {messageHex: Hex; summary: string}; consumed: boolean} | null = null;
  let pendingResolve: ((value: Hex) => void) | null = null;
  let pendingReject: ((e: Error) => void) | null = null;
  let index = 0;
  let finished = false;

  const fail = (e: Error) => {
    pendingReject?.(e);
    rejectAll?.(e);
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('access-control-allow-origin', '*');
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/') {
        res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
        // A finished session must NOT re-serve the live connect page: a stale hit (an old tab, a
        // reused bookmark, a page opened while this server drains) would connect and instantly
        // read `/next` → done, looking like THIS action succeeded when it was the last one. Serve
        // an unambiguous ended-state instead — the next action opens its own fresh link.
        res.end(finished ? endedPage() : sessionPage({chainId: chain.id, chainName: chain.name, explorer, expectedSigner: opts.expectedSigner, total: opts.total}));
        return;
      }
      if (url.pathname === '/connect' && req.method === 'POST') {
        const {signer} = JSON.parse((await readBody(req)) || '{}');
        // Hard server-side guard: never let the deployer/owner resolve to anything but the
        // expected signer (the page enforces this too, but the CLI builds owner/mintTo from
        // whatever connects, so a wrong signer here would silently mis-own the contract).
        if (signer && opts.expectedSigner && (signer as string).toLowerCase() !== opts.expectedSigner.toLowerCase()) {
          res.writeHead(409, {'content-type': 'application/json'});
          res.end(JSON.stringify({ok: false, error: `connected ${signer} but this is prepared for ${opts.expectedSigner}`}));
          return;
        }
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({ok: true}));
        if (signer) resolveConnect(signer as Address);
        return;
      }
      if (url.pathname === '/next') {
        res.writeHead(200, {'content-type': 'application/json'});
        if (finished) res.end(JSON.stringify({done: true}));
        else if (current && !current.consumed) {
          const base = {index: current.index, total: opts.total ?? null};
          res.end(JSON.stringify(current.kind === 'msg' ? {...base, msg: current.msg} : {...base, tx: current.tx}));
        } else res.end(JSON.stringify({idle: true}));
        return;
      }
      if (url.pathname === '/signed' && req.method === 'POST') {
        // A tx item returns `txHash`; a message item returns `signature`. Both are Hex; the awaiting
        // caller (send vs signMessage) knows which it queued.
        const {index: i, txHash, signature} = JSON.parse((await readBody(req)) || '{}');
        const value = (txHash ?? signature) as Hex | undefined;
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({ok: true}));
        if (current && current.index === i && value && pendingResolve) {
          current.consumed = true;
          pendingResolve(value);
        }
        return;
      }
      if (url.pathname === '/cancel' && req.method === 'POST') {
        res.writeHead(200);
        res.end('ok');
        fail(new Error('signing cancelled in the browser'));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    } catch (err) {
      res.writeHead(500, {'content-type': 'application/json'});
      res.end(JSON.stringify({error: (err as Error).message}));
    }
  });

  const boundPort = await listenAvailable(server, preferredPort);
  const signUrl = `http://localhost:${boundPort}`;
  console.log(`\n  ${purple('◆')} ${bold('wallet signing')}  ${dim(`(${chain.name}${opts.total ? `, ${opts.total} transactions` : ''})`)}`);
  console.log(`\n  Open ${bold(signUrl)} , connect a wallet${opts.expectedSigner ? ` (${opts.expectedSigner})` : ''}, and approve each step.`);
  // Funding, said out loud at the one moment it matters. `warnUnfunded` can't help here: on the
  // wallet lane without --for we don't know the address until the browser connects, so an empty
  // wallet's first and only signal used to be a failed transaction. Name the requirement and the
  // fix BEFORE they go pick a wallet, not after it reverts.
  console.log(`  ${dim(`Use a wallet holding a little ${chain.name} ETH — it pays gas, and it's free test ETH, not real money.`)}`);
  console.log(`  ${dim(`None yet? ${faucetHint(opts.chainKey)}.`)}`);
  announceSignUrl(signUrl, opts.signUrlFile);
  console.log(`  ${dim('The key never touches this process — only signed tx hashes come back. Ctrl-C to cancel.')}\n`);

  const onSigint = () => fail(new Error('cancelled'));
  process.once('SIGINT', onSigint);

  return {
    connect: () => connected,
    async send(tx: PreparedTx): Promise<SignedReceipt> {
      index += 1;
      // A wallet session spans blocks: the deploy is approved, then setup targets the contract it
      // just created. The browser wallet estimates against ITS OWN RPC, which we don't control and
      // which can lag — so wait for the code to be visible and hand the page an explicit gas limit
      // instead of letting the wallet guess. Same reasoning as the hot lane (see execute.ts).
      if (tx.to && tx.gasFloor) await waitForCodeAt(publicClient, tx.to);
      const gas = opts.expectedSigner
        ? await pinGas(publicClient, {from: opts.expectedSigner, to: tx.to, data: tx.data, value: tx.value, gasFloor: tx.gasFloor}).catch(() => undefined)
        : undefined;
      current = {index, kind: 'tx', tx: gas === undefined ? tx : {...tx, gas: `0x${gas.toString(16)}` as Hex}, consumed: false};
      console.log(`  ${dim(`tx ${opts.total ? `${index}/${opts.total}` : index}:`)} ${tx.summary} ${dim('— approve in your wallet …')}`);
      const txHash = await new Promise<Hex>((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;
      });
      pendingResolve = null;
      pendingReject = null;
      console.log(`  ${dim('tx')} ${explorer}/tx/${txHash}  ${dim('— confirming …')}`);
      const receipt = await publicClient.waitForTransactionReceipt({hash: txHash});
      console.log(`  ${green('✓')} confirmed`);
      current = null; // back to idle until the next send()
      return {txHash, receipt};
    },
    async signMessage(message: Uint8Array, summary?: string): Promise<Hex> {
      index += 1;
      current = {index, kind: 'msg', msg: {messageHex: bytesToHex(message), summary: summary ?? 'Sign storage upload (Arweave/Turbo)'}, consumed: false};
      console.log(`  ${dim(`sign ${opts.total ? `${index}/${opts.total}` : index}:`)} ${current.msg!.summary} ${dim('— approve in your wallet …')}`);
      const sig = await new Promise<Hex>((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;
      });
      pendingResolve = null;
      pendingReject = null;
      console.log(`  ${green('✓')} signed`);
      current = null; // back to idle
      return sig;
    },
    close() {
      finished = true;
      process.removeListener('SIGINT', onSigint);
      // Brief grace so the page's next poll can render "all done" before the socket drops.
      setTimeout(() => server.close(), 1200).unref();
    },
  };
}

/** The page a *finished* session serves on a fresh load — so a stale/reused hit reads as
 *  "over", never as the current action's success. Deliberately inert: no wallet JS, no poll. */
function endedPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ABX · session ended</title><style>
:root{color-scheme:dark}
body{margin:0;font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0c0c10;color:#e7e7ea;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{width:min(560px,92vw);background:#15151c;border-radius:14px;padding:26px 28px;box-shadow:0 12px 40px #0008}
h1{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#a98bff;margin:0 0 10px}
p{margin:0 0 8px;color:#c9c9d0}
.dim{color:#7d7d88;font-size:13px}
</style></head><body><div class="card">
<h1>ABX · signing session ended</h1>
<p>This signing session is finished — nothing is pending here.</p>
<p class="dim">This is <b>not</b> a fresh action. Each new action opens its own link: return to the terminal, wait for the next sign URL, and open that one. Don't reuse this tab.</p>
</div></body></html>`;
}

function sessionPage(o: {
  chainId: number;
  chainName: string;
  explorer: string;
  expectedSigner?: Address;
  total?: number;
}): string {
  const cfg = JSON.stringify({
    chainId: o.chainId,
    chainName: o.chainName,
    explorer: o.explorer,
    expectedSigner: o.expectedSigner ?? null,
    total: o.total ?? null,
  });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ABX · sign</title><style>
:root{color-scheme:dark}
body{margin:0;font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0c0c10;color:#e7e7ea;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{width:min(560px,92vw);background:#15151c;border:1px solid #26263200;border-radius:14px;padding:26px 28px;box-shadow:0 12px 40px #0008}
h1{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#a98bff;margin:0 0 4px}
.prog{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#7d7d88;margin:0 0 10px;min-height:14px}
.ctx{margin:0 0 16px;font-size:12.5px}
.ctx .row{display:flex;align-items:flex-start;gap:8px;padding:3px 0}
.ctx .dot{flex:none;width:8px;height:8px;border-radius:50%;margin-top:6px;background:#5a5a66}
.ctx .dot.good{background:#7fe0a0}.ctx .dot.bad{background:#ff8b8b}
.ctx .v{word-break:break-all}
.ctx .good{color:#9be8b6}.ctx .bad{color:#ff9d9d}
.summary{font-size:18px;font-weight:600;margin:10px 0 4px}
.tlabel{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#8a8a96;margin:8px 0 2px}
table{width:100%;border-collapse:collapse;margin:0 0 16px;font-size:13px}
td{padding:5px 0;vertical-align:top;border-bottom:1px solid #ffffff10}
td.k{color:#8a8a96;width:104px;padding-right:12px}
td.v{word-break:break-all;color:#d6d6dc}
button{font:inherit;font-weight:600;border:0;border-radius:9px;padding:12px 18px;width:100%;cursor:pointer;background:#7c5cff;color:#fff;margin-top:6px}
button:disabled{opacity:.4;cursor:not-allowed}
button.secondary{background:#23232e;color:#cfcfd6}
.note{font-size:12px;color:#7d7d88;margin-top:14px}
.status{font-size:13px;margin-top:14px;padding:10px 12px;border-radius:8px;background:#1c1c25;display:none}
.status.show{display:block}
.ok{color:#7fe0a0}.err{color:#ff8b8b}.warn{color:#ffcf8b}
a{color:#a98bff}
</style></head><body><div class="card">
<h1>ABX · approve to sign</h1>
<div class="prog" id="progress"></div>
<div class="ctx">
  <div class="row"><span class="dot" id="netDot"></span><span class="v" id="netText">Network: …</span></div>
  <div class="row"><span class="dot" id="acctDot"></span><span class="v" id="acctText">Wallet: not connected</span></div>
</div>
<div class="tlabel" id="tlabel" style="display:none">This transaction does</div>
<div class="summary" id="summary">Connect your wallet to begin.</div>
<table id="fields"></table>
<button id="connect">Connect wallet</button>
<button id="switch" class="secondary" style="display:none">Switch network to ${o.chainName}</button>
<button id="sign" disabled style="display:none">Sign &amp; send</button>
<div class="status" id="status"></div>
<div class="note" id="note"></div>
</div>
<script>
const CFG = ${cfg};
const $ = (id) => document.getElementById(id);
let account=null, chainId=null, connected=false, curTx=null, curMsg=null, curKind=null, curIndex=0, signing=false, stopped=false;
const toHexChain = (n) => '0x' + n.toString(16);
const eq = (a,b) => a && b && a.toLowerCase() === b.toLowerCase();
function status(msg, cls){ const s=$('status'); s.className='status show '+(cls||''); s.innerHTML=msg; }
function progress(i, label){ $('progress').textContent = i ? ((label||'Step') + ' ' + i + (CFG.total ? ' of ' + CFG.total : '')) : ''; }
const signerOk = () => !CFG.expectedSigner || eq(account, CFG.expectedSigner);
const chainOk  = () => chainId === CFG.chainId;
// A message signature (personal_sign, for Arweave/Turbo uploads) is chain-agnostic; only a tx needs the network right.
const needChain = () => curKind !== 'msg';

// Every signature is gated on THREE things being right: the network, the signing wallet,
// and a tx to sign. The page renders all three and refuses to enable signing unless they hold.
function renderCtx(){
  const nd=$('netDot'), nt=$('netText');
  if (chainId == null){ nd.className='dot'; nt.className='v'; nt.textContent='Network: connect to check'; }
  else if (chainOk()){ nd.className='dot good'; nt.className='v good'; nt.textContent='Network: '+CFG.chainName+' (chainId '+CFG.chainId+') ✓'; }
  else { nd.className='dot bad'; nt.className='v bad'; nt.innerHTML='Wrong network: wallet is on chainId '+chainId+', this needs <b>'+CFG.chainName+' ('+CFG.chainId+')</b>'; }
  const ad=$('acctDot'), at=$('acctText');
  if (!account){ ad.className='dot'; at.className='v'; at.textContent='Wallet: not connected'; }
  else if (signerOk()){ ad.className='dot good'; at.className='v good'; at.innerHTML='Wallet: '+account+' ✓'+(CFG.expectedSigner?'':' — this wallet will be the owner'); }
  else { ad.className='dot bad'; at.className='v bad'; at.innerHTML='Wrong wallet: connected <b>'+account+'</b>, but this was prepared for <b>'+CFG.expectedSigner+'</b>. Switch accounts in your wallet.'; }
  $('switch').style.display = (account && !chainOk()) ? 'block' : 'none';
  gateSign();
}
function gateSign(){
  const hasItem = !!curTx || !!curMsg;
  const ready = hasItem && !signing && signerOk() && (!needChain() || chainOk());
  $('sign').disabled = !ready;
  if (hasItem && !signing && !ready){
    if (needChain() && !chainOk()) status('Can\\'t sign: wrong network. Switch your wallet to '+CFG.chainName+' ('+CFG.chainId+').','err');
    else if (!signerOk()) status('Can\\'t sign: wrong wallet. Switch to '+CFG.expectedSigner+'.','err');
  }
}
function renderTx(t,i){
  curTx=t; curMsg=null; curKind='tx'; curIndex=i; progress(i,'Transaction');
  $('tlabel').style.display='block'; $('tlabel').textContent='This transaction does';
  $('summary').textContent=t.summary;
  $('fields').innerHTML=Object.entries(t.fields).map(([k,v]) =>
    '<tr><td class="k">'+k+'</td><td class="v">'+v+'</td></tr>').join('');
  $('connect').style.display='none';
  $('sign').textContent='Sign & send';
  $('sign').style.display='block';
  if (signerOk() && chainOk()) status('Review the details above, then approve in your wallet.','');
  gateSign();
}
function renderMsg(m,i){
  curMsg=m; curTx=null; curKind='msg'; curIndex=i; progress(i,'Signature');
  $('tlabel').style.display='block'; $('tlabel').textContent='This signature authorizes';
  $('summary').textContent=m.summary;
  $('fields').innerHTML='<tr><td class="k">action</td><td class="v">Sign a storage upload (Arweave / Turbo). This is a message signature — <b>no gas, no funds move</b>; the upload is paid from your Turbo credits.</td></tr>';
  $('connect').style.display='none';
  $('sign').textContent='Sign message';
  $('sign').style.display='block';
  if (signerOk()) status('Review, then sign in your wallet (a signature, not a transaction).','');
  gateSign();
}
async function readChain(){
  try { chainId = parseInt(await window.ethereum.request({method:'eth_chainId'}),16); } catch(e){ chainId=null; }
}
async function trySwitch(){
  try { await window.ethereum.request({method:'wallet_switchEthereumChain', params:[{chainId: toHexChain(CFG.chainId)}]}); }
  catch(e){ status('Couldn\\'t switch automatically — switch to '+CFG.chainName+' ('+CFG.chainId+') in your wallet manually.','err'); }
  await readChain(); renderCtx(); maybeConnect();
}
$('switch').onclick = trySwitch;
// Tell the CLI which wallet is signing — but ONLY once it's the right wallet on the right
// network, so the deployer/owner the CLI builds can never be a wallet you didn't intend.
async function maybeConnect(){
  if (connected || !account) return;
  if (!signerOk() || !chainOk()){ gateSign(); return; }
  const r = await fetch('/connect', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({signer: account})});
  if (!r.ok){ const e = await r.json().catch(()=>({})); status('Rejected: '+(e.error||'signer mismatch'),'err'); return; }
  connected=true;
  status('Connected '+account+' on '+CFG.chainName+'. Waiting for the first transaction…','ok');
  poll();
}
$('connect').onclick = async () => {
  const eth = window.ethereum;
  if (!eth){ status('No injected wallet found. Install MetaMask (or use the hot lane: <code>--send</code>).','err'); return; }
  try {
    const accs = await eth.request({method:'eth_requestAccounts'});
    account = accs[0] || null;
    await readChain();
    if (!chainOk()) await trySwitch(); else { renderCtx(); maybeConnect(); }
  } catch(e){ status(e.message||String(e),'err'); }
};
$('sign').onclick = async () => {
  if ((!curTx && !curMsg) || signing) return;
  // Re-verify LIVE against the wallet right before signing — the user may have switched the
  // account or network since we last checked. Never send a tx to the wrong place.
  try {
    const live = (await window.ethereum.request({method:'eth_accounts'}))[0] || null;
    if (live) account = live;
    await readChain(); renderCtx();
  } catch(e){}
  if (!signerOk() || (needChain() && !chainOk())){ gateSign(); return; }
  signing=true; $('sign').disabled=true;
  try {
    if (curKind==='msg'){
      // Sign the Arweave data-item's signature-data with the wallet (EIP-191). No gas, no chain.
      const signature = await window.ethereum.request({method:'personal_sign', params:[curMsg.messageHex, account]});
      await fetch('/signed', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({index: curIndex, signature})});
      status('Signed ✓ — continuing…','ok');
      $('sign').style.display='none'; curMsg=null; signing=false;
    } else {
      const params = {from: account, data: curTx.data, value: curTx.value};
      if (curTx.to) params.to = curTx.to;
      // An explicit limit the CLI resolved for this tx. Wallets that would otherwise estimate against
      // a node lagging behind the deploy block send ~200k for a call needing ~941k, and the on-chain
      // content write reverts DeploymentFailed(). The user can still edit it in the wallet UI.
      if (curTx.gas) params.gas = curTx.gas;
      const txHash = await window.ethereum.request({method:'eth_sendTransaction', params:[params]});
      await fetch('/signed', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({index: curIndex, txHash})});
      const link = CFG.explorer ? '<a href="'+CFG.explorer+'/tx/'+txHash+'" target="_blank">'+txHash+'</a>' : txHash;
      status('Sent ✓ '+link+'<br>Confirming on-chain…','ok');
      $('sign').style.display='none'; curTx=null; signing=false;
    }
  } catch(e){ status((e&&e.message)||String(e),'err'); signing=false; gateSign(); }
};
if (window.ethereum){
  window.ethereum.on && window.ethereum.on('accountsChanged', (accs)=>{ account=(accs&&accs[0])||null; renderCtx(); maybeConnect(); });
  window.ethereum.on && window.ethereum.on('chainChanged', async ()=>{ await readChain(); renderCtx(); maybeConnect(); });
}
renderCtx();
async function poll(){
  if (stopped) return;
  try {
    const r = await fetch('/next'); const d = await r.json();
    if (d.done){ stopped=true; progress(0); $('tlabel').style.display='none'; $('summary').textContent='All done — everything signed.'; $('fields').innerHTML=''; status('Done ✓ — you can close this tab.','ok'); return; }
    if (d.tx && d.index !== curIndex && !signing) renderTx(d.tx, d.index);
    else if (d.msg && d.index !== curIndex && !signing) renderMsg(d.msg, d.index);
  } catch(e){ /* server finishing/closing — keep trying briefly */ }
  if (!stopped) setTimeout(poll, 700);
}
</script></body></html>`;
}
