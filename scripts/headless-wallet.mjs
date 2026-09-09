// A headless stand-in for a browser-extension wallet, for testing the `--sign` lane's
// multi-tx WalletSession without a real MetaMask. It plays the exact role the sign page
// plays: connect once, then for each tx the CLI queues, sign it with a local key and post
// the hash back. Proves the session orchestration (stage chunk(s) → deploy, one connect,
// N approvals) end to end against a local anvil.
//
//   node scripts/headless-wallet.mjs <signUrl> <rpcUrl> <privateKey> [expectedTotal]
//
// Exits 0 once the session reports `done`, non-zero on any signing error or timeout.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

// viem lives in a workspace package's node_modules (pnpm doesn't hoist it to the repo root),
// so resolve it from @artblocks/abx-sdk's package context rather than relying on bare resolution here.
const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(join(here, '..', 'packages', 'sdk', 'package.json'));
const {createWalletClient, http} = await import(req.resolve('viem'));
const {privateKeyToAccount} = await import(req.resolve('viem/accounts'));

const [, , base, rpc, pk, expectedTotalRaw] = process.argv;
if (!base || !rpc || !pk) {
  console.error('usage: headless-wallet.mjs <signUrl> <rpcUrl> <privateKey> [expectedTotal]');
  process.exit(2);
}
const expectedTotal = expectedTotalRaw ? Number(expectedTotalRaw) : null;
const account = privateKeyToAccount(pk);
const wallet = createWalletClient({account, transport: http(rpc)});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`  [wallet] ${m}`);

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(base + '/');
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('sign page never came up at ' + base);
}

// Guard test: connect as the WRONG wallet and assert the session refuses it (server 409).
async function expectReject() {
  await waitForServer();
  log(`connecting as ${account.address} — expecting REJECTION`);
  const r = await fetch(base + '/connect', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({signer: account.address}),
  });
  if (r.ok) throw new Error(`guard FAILED: wrong wallet ${account.address} was accepted (expected 409)`);
  log(`connect correctly rejected (HTTP ${r.status}) — wrong wallet blocked`);
  await fetch(base + '/cancel', {method: 'POST'}).catch(() => {});
  process.exit(0);
}

async function main() {
  if (expectedTotalRaw === 'reject') return expectReject();
  await waitForServer();
  log(`connecting as ${account.address}`);
  await fetch(base + '/connect', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({signer: account.address}),
  });

  let lastIndex = 0;
  let signedCount = 0;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    let d;
    try {
      d = await (await fetch(base + '/next')).json();
    } catch {
      // server may be closing right after `done`; treat as finished.
      break;
    }
    if (d.done) {
      log(`session done — signed ${signedCount} tx(s)`);
      if (expectedTotal != null && signedCount !== expectedTotal) {
        throw new Error(`expected to sign ${expectedTotal} tx(s), signed ${signedCount}`);
      }
      process.exit(0);
    }
    if (d.tx && d.index !== lastIndex) {
      lastIndex = d.index;
      const tx = d.tx;
      log(`tx ${d.index}${d.total ? '/' + d.total : ''}: ${tx.summary}`);
      const hash = await wallet.sendTransaction({
        account,
        chain: null,
        to: tx.to ?? undefined,
        data: tx.data,
        value: BigInt(tx.value ?? '0x0'),
      });
      log(`  sent ${hash}`);
      await fetch(base + '/signed', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({index: d.index, txHash: hash}),
      });
      signedCount++;
    }
    await sleep(300);
  }
  throw new Error('headless wallet timed out waiting for the session');
}

main().catch((e) => {
  console.error(`  [wallet] ERROR: ${e.message}`);
  fetch(base + '/cancel', {method: 'POST'}).catch(() => {});
  process.exit(1);
});
