import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openWalletSession} from '../src/signer.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read the actual bound URL a session announced (via signUrlFile) — the port may differ from
 *  the requested one after a collision fallback, so tests must read it, never assume it. */
function boundUrl(file: string): string {
  return readFileSync(file, 'utf8').trim();
}

/**
 * The wallet lane's message-signing contract: a Turbo
 * upload data-item is signed by the connected browser wallet via `personal_sign`. This drives the
 * CLI↔page HTTP contract with a simulated browser — the one part verifiable without a real wallet.
 * (The MetaMask ↔ arbundles ↔ Turbo byte agreement is covered by matching arbundles' source, and
 * needs a manual smoke test to certify end to end.)
 */
test('wallet session: signMessage round-trips a personal_sign through the /next + /signed contract', async () => {
  const port = 8971;
  const base = `http://localhost:${port}`;
  const session = await openWalletSession({chainKey: 'sepolia', port, total: 1});
  try {
    // simulate the browser connecting a wallet
    const signer = '0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C';
    await fetch(`${base}/connect`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({signer})});
    assert.equal((await session.connect()).toLowerCase(), signer.toLowerCase());

    // queue a message to sign; simulate the page polling + returning a signature
    const message = new Uint8Array([0x01, 0x02, 0x03, 0xab, 0xff]);
    const SIG = ('0x' + 'cd'.repeat(65)) as `0x${string}`;
    const sigPromise = session.signMessage(message, 'test upload');

    let item: {index: number; msg?: {messageHex: string; summary: string}} | undefined;
    for (let i = 0; i < 100 && !item?.msg; i++) {
      item = (await (await fetch(`${base}/next`)).json()) as typeof item;
      if (!item?.msg) await sleep(15);
    }
    assert.ok(item?.msg, 'a message item was served on /next (not a tx item)');
    assert.equal(item.msg.summary, 'test upload');
    assert.equal(item.msg.messageHex, '0x010203abff'); // bytes → 0x hex, faithfully

    await fetch(`${base}/signed`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({index: item.index, signature: SIG})});
    assert.equal(await sigPromise, SIG); // the CLI receives exactly the wallet's signature
  } finally {
    session.close();
  }
});

/**
 * The signing-page staleness bug: each owner op is a fresh process that prefers the same port
 * (8799). When they overlap, binding naively either crashes (EADDRINUSE) or — worse — hands the
 * new action a server that is still finishing, which reads as an instant "done". The fix: a
 * new session that finds its preferred port busy takes a fresh ephemeral port instead, so two
 * live sessions NEVER share a server. Read the announced URL — never assume the port.
 */
test('wallet session: a second session on a busy preferred port falls back to a fresh port', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-sign-'));
  const port = 8973;
  const aFile = join(dir, 'a-url');
  const bFile = join(dir, 'b-url');
  const a = await openWalletSession({chainKey: 'sepolia', port, total: 1, signUrlFile: aFile});
  const b = await openWalletSession({chainKey: 'sepolia', port, total: 1, signUrlFile: bFile});
  try {
    const aUrl = boundUrl(aFile);
    const bUrl = boundUrl(bFile);
    assert.equal(aUrl, `http://localhost:${port}`, 'first session gets the preferred port');
    assert.notEqual(bUrl, aUrl, 'second session must NOT reuse the busy port — fresh server per action');
    // Both are independently reachable and live (each serves its own connect page).
    assert.match(await (await fetch(aUrl)).text(), /approve to sign/i);
    assert.match(await (await fetch(bUrl)).text(), /approve to sign/i);
  } finally {
    a.close();
    b.close();
  }
});

/**
 * A finished session must not masquerade as live. A stale hit — an old tab, a reused bookmark,
 * a page opened while the server drains after the last op — connecting and instantly showing
 * "done" is exactly the reported confusion. Once closed, `/` serves an unmistakable ended page.
 */
test('wallet session: a finished session serves an ended page, not the live connect page', async () => {
  const port = 8975;
  const base = `http://localhost:${port}`;
  const session = await openWalletSession({chainKey: 'sepolia', port, total: 1});
  // While live, `/` is the connect page.
  assert.match(await (await fetch(base)).text(), /approve to sign/i);
  session.close(); // finished=true immediately; socket lingers briefly for the grace window
  const html = await (await fetch(base)).text();
  assert.match(html, /session ended/i, 'a fresh load on a finished session reads as over');
  assert.doesNotMatch(html, /approve to sign/i, 'it must NOT re-serve the live connect page');
});
