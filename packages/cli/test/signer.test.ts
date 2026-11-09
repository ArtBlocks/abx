import {privateKeyToAccount} from 'viem/accounts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, symlinkSync, statSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {envKeyRequiresYes, openWalletSession, walletFundingGuidance, assertWalletTransaction} from '../src/signer.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('session URL replacement is private and does not follow an existing symlink', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-sign-private-'));
  const target = join(dir, 'other'); const file = join(dir, 'url');
  writeFileSync(target, 'unchanged'); symlinkSync(target, file);
  const session = await openWalletSession({chainKey: 'sepolia', port: 0, signUrlFile: file});
  try {
    assert.equal(readFileSync(target, 'utf8'), 'unchanged');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.match(boundUrl(file), /session=/);
  } finally {session.close(); rmSync(dir, {recursive: true, force: true});}
});

test('env-key consent follows the shared chain environment registry', () => {
  assert.equal(envKeyRequiresYes('base-sepolia'), false);
  assert.equal(envKeyRequiresYes('sepolia'), false);
  assert.equal(envKeyRequiresYes('robinhood-testnet'), false);
  assert.equal(envKeyRequiresYes('arbitrum-sepolia'), false);
  assert.equal(envKeyRequiresYes('base'), true);
  assert.equal(envKeyRequiresYes('robinhood'), true);
  assert.equal(envKeyRequiresYes('ethereum'), true);
  assert.equal(envKeyRequiresYes('arbitrum'), true);
  assert.equal(envKeyRequiresYes('unknown-chain'), true);
});

test('wallet funding guidance distinguishes testnet gas from real production funds', () => {
  const testnet = walletFundingGuidance('base-sepolia').join(' ');
  assert.match(testnet, /free test ETH/);
  assert.match(testnet, /faucet/);

  const production = walletFundingGuidance('base').join(' ');
  assert.match(production, /spends real funds/);
  assert.doesNotMatch(production, /free test ETH|faucet/i);
});

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
  const file = join(mkdtempSync(join(tmpdir(), 'abx-sign-auth-')), 'url');
  const session = await openWalletSession({chainKey: 'sepolia', port, total: 1, signUrlFile: file});
  const announced = new URL(boundUrl(file));
  const base = announced.origin;
  const auth = {'x-abx-session-token': announced.searchParams.get('session')!};
  try {
    // simulate the browser connecting a wallet
    const account = privateKeyToAccount('0x' + '01'.repeat(32) as `0x${string}`);
    const signer = account.address;
    assert.equal((await fetch(`${base}/next`)).status, 403);
    await fetch(`${base}/connect`, {method: 'POST', headers: {...auth, 'content-type': 'application/json'}, body: JSON.stringify({signer})});
    assert.equal((await session.connect()).toLowerCase(), signer.toLowerCase());

    // queue a message to sign; simulate the page polling + returning a signature
    const message = new Uint8Array([0x01, 0x02, 0x03, 0xab, 0xff]);
    const SIG = await account.signMessage({message: {raw: message}});
    const sigPromise = session.signMessage(message, 'test upload');

    let item: {index: number; msg?: {messageHex: string; summary: string}} | undefined;
    for (let i = 0; i < 100 && !item?.msg; i++) {
      item = (await (await fetch(`${base}/next`, {headers: auth})).json()) as typeof item;
      if (!item?.msg) await sleep(15);
    }
    assert.ok(item?.msg, 'a message item was served on /next (not a tx item)');
    assert.equal(item.msg.summary, 'test upload');
    assert.equal(item.msg.messageHex, '0x010203abff'); // bytes → 0x hex, faithfully

    assert.equal((await fetch(`${base}/signed`, {method: 'POST', headers: {...auth, 'content-type': 'application/json'}, body: JSON.stringify({index: item.index, signature: '0x1234'})})).status, 400);
    await fetch(`${base}/signed`, {method: 'POST', headers: {...auth, 'content-type': 'application/json'}, body: JSON.stringify({index: item.index, signature: SIG})});
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
    assert.equal(new URL(aUrl).origin, `http://localhost:${port}`, 'first session gets the preferred port');
    assert.notEqual(new URL(bUrl).origin, new URL(aUrl).origin, 'second session must NOT reuse the busy port — fresh server per action');
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
  const file = join(mkdtempSync(join(tmpdir(), 'abx-sign-auth-')), 'url');
  const session = await openWalletSession({chainKey: 'sepolia', port, total: 1, signUrlFile: file});
  const announced = new URL(boundUrl(file));
  const base = announced.origin;
  const auth = {'x-abx-session-token': announced.searchParams.get('session')!};
  // While live, `/` is the connect page.
  assert.match(await (await fetch(base, {headers: auth})).text(), /approve to sign/i);
  session.close(); // finished=true immediately; socket lingers briefly for the grace window
  const html = await (await fetch(base, {headers: auth})).text();
  assert.match(html, /session ended/i, 'a fresh load on a finished session reads as over');
  assert.doesNotMatch(html, /approve to sign/i, 'it must NOT re-serve the live connect page');
});

test('wallet receipts must match the complete pending intent and cannot predate its nonce', () => {
  const signer = '0x1111111111111111111111111111111111111111' as const;
  const target = '0x2222222222222222222222222222222222222222' as const;
  const intended = {to: target, data: '0x1234', value: '0x3'} as never;
  const hash = ('0x' + '11'.repeat(32)) as `0x${string}`;
  const actual = {hash, from: signer, to: target, input: '0x1234' as const, value: 3n, nonce: 7};
  const receipt = {transactionHash: hash, from: signer, status: 'success'} as never;
  assert.doesNotThrow(() => assertWalletTransaction(intended, signer, actual, receipt, 7));
  for (const change of [{from: target}, {to: signer}, {input: '0x5678'}, {value: 4n}, {nonce: 6}]) {
    assert.throws(() => assertWalletTransaction(intended, signer, {...actual, ...change} as typeof actual, receipt, 7), /does not match/);
  }
  assert.throws(() => assertWalletTransaction(intended, signer, actual, {transactionHash: hash, from: signer, status: 'reverted'} as never, 7), /does not match/);
});

test('rendered signing page reports rejected connections and escapes transaction field text', async () => {
  const {createContext, runInContext} = await import('node:vm');
  const file = join(mkdtempSync(join(tmpdir(), 'abx-sign-page-')), 'url');
  const session = await openWalletSession({chainKey: 'sepolia', port: 0, signUrlFile: file});
  try {
    const url = new URL(boundUrl(file));
    const html = await (await fetch(url)).text();
    const source = html.match(/<script>([\s\S]*?)<\/script>/i)![1]!;
    const elements = new Map<string, {className: string; textContent: string; innerHTML: string; style: Record<string, string>; disabled: boolean}>();
    const element = (id: string) => {if (!elements.has(id)) elements.set(id, {className: '', textContent: '', innerHTML: '', style: {}, disabled: false}); return elements.get(id)!;};
    const statusChildren: Array<string | Record<string, string>> = [];
    Object.assign(element('status'), {append: (...items: typeof statusChildren) => statusChildren.push(...items)});
    const context = createContext({document: {getElementById: element, createElement: (tagName: string) => ({tagName})}, window: {}, location: {search: url.search}, URLSearchParams,
      fetch: async () => ({ok: false, text: async () => JSON.stringify({error: 'signer rejected'})}), setTimeout: () => {}});
    runInContext(source, context);
    await runInContext('account="0x1111111111111111111111111111111111111111"; chainId=CFG.chainId; maybeConnect()', context);
    assert.match(element('status').textContent, /Rejected: signer rejected/);
    runInContext('renderTx({summary:"test",fields:{name:"<img src=x onerror=alert(1)>"}},1)', context);
    assert.match(element('fields').innerHTML, /&lt;img/);
    assert.doesNotMatch(element('fields').innerHTML, /<img/);
    runInContext('statusSent("0x1234")', context);
    const link = statusChildren[0] as Record<string, string>;
    assert.match(link.href!, /\/tx\/0x1234$/);
    assert.equal(link.textContent, '0x1234');
    assert.equal(link.rel, 'noopener noreferrer');
    context.fetch = async () => ({ok: true, json: async () => ({error: 'confirmation stopped'})});
    await runInContext('maybeConnect()', context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(element('status').textContent, /confirmation stopped/);
    assert.doesNotMatch(element('summary').textContent, /All done/);
    runInContext('account="0x2222222222222222222222222222222222222222"; renderCtx()', context);
    assert.equal(runInContext('signerOk()', context), false, 'a deploy session stays bound to the wallet used to construct its transaction');

  } finally {session.close();}
});
