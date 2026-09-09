import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {
  ArweaveBackend,
  HttpBundlerUploader,
  arweaveAddress,
  arweaveFunding,
  arweaveProvider,
  generateArweaveJwk,
  hashContent,
  turboBalanceForAddress,
  turboIdentity,
  resolveTurboIdentity,
  turboIdentityAddress,
  isEthIdentity,
  type ArweaveUploader,
} from '../src/index.js';

const BYTES = new TextEncoder().encode('permanent bytes');
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('ArweaveBackend: upload records the txid; gateway GET retrieves the bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-ar-'));
  try {
    // Inject a fake uploader (the real one signs/bundles); stub the gateway for retrieval.
    let uploaded: Uint8Array | null = null;
    const uploader: ArweaveUploader = {
      async upload(bytes) {
        uploaded = bytes;
        return {id: 'TX_FAKE_123'};
      },
    };
    globalThis.fetch = (async (input: any) => {
      if (String(input).endsWith('/TX_FAKE_123')) return new Response(BYTES, {status: 200});
      return new Response('not found', {status: 404});
    }) as typeof fetch;

    const ar = new ArweaveBackend({gateway: 'https://arweave.net', uploadUrl: 'https://bundler.example'}, dir, uploader);
    const hash = hashContent(BYTES);

    assert.equal(await ar.has(hash), false);
    await ar.put(hash, {bytes: BYTES, contentType: 'image/png'});
    assert.ok(uploaded, 'uploader was called');
    assert.equal(await ar.has(hash), true); // txid recorded in the off-chain index

    const got = await ar.get(hash);
    assert.ok(got);
    assert.deepEqual(got.bytes, BYTES); // retrieved from the gateway by txid
    assert.equal(got.contentType, 'image/png');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('HttpBundlerUploader: POSTs bytes with auth and extracts the txid', async () => {
  let seen: {auth?: string; method?: string} = {};
  globalThis.fetch = (async (_input: any, init: any) => {
    seen = {auth: init.headers.authorization, method: init.method};
    return new Response(JSON.stringify({id: 'TX_FROM_BUNDLER'}), {status: 200});
  }) as typeof fetch;

  const uploader = new HttpBundlerUploader({uploadUrl: 'https://bundler.example/tx', token: 'TKN'});
  const {id} = await uploader.upload(BYTES, 'image/png');
  assert.equal(id, 'TX_FROM_BUNDLER');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.auth, 'Bearer TKN');
});

test('HttpBundlerUploader: tolerates alternate txid field names', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({transactionId: 'TX_ALT'}), {status: 200})) as typeof fetch;
  const uploader = new HttpBundlerUploader({uploadUrl: 'https://bundler.example/tx'});
  assert.equal((await uploader.upload(BYTES, 'image/png')).id, 'TX_ALT');
});

test('HttpBundlerUploader: errors clearly when no upload URL is configured', async () => {
  const uploader = new HttpBundlerUploader({});
  await assert.rejects(() => uploader.upload(BYTES, 'image/png'), /upload endpoint/);
});

test('generateArweaveJwk: RSA JWK; arweaveAddress is a deterministic base64url(sha256(n))', () => {
  const jwk = generateArweaveJwk();
  assert.equal(jwk.kty, 'RSA');
  assert.ok(jwk.n && jwk.d && jwk.e, 'has modulus, private + public exponent');
  assert.equal(arweaveAddress(jwk), arweaveAddress(jwk)); // pure, stable
  assert.match(arweaveAddress(jwk), /^[A-Za-z0-9_-]{43}$/); // 32-byte sha256, base64url, unpadded
});

test('arweaveProvider: defaults to turbo; an uploadUrl implies http-bundler; explicit wins', () => {
  assert.equal(arweaveProvider({gateway: 'https://arweave.net'}), 'turbo');
  assert.equal(arweaveProvider({gateway: 'g', uploadUrl: 'https://b'}), 'http-bundler');
  assert.equal(arweaveProvider({gateway: 'g', uploadUrl: 'https://b', provider: 'turbo'}), 'turbo');
});

test('arweaveFunding: turbo exposes funding bound to the key address; http-bundler has none', async () => {
  const jwk = generateArweaveJwk();
  // arweaveFunding is async: the `turbo` path lazily `await import()`s the
  // optional `@artblocks/abx-storage-arweave` package to build the real TurboUploader, so this
  // exercises the actual cross-package wiring rather than a mock.
  const funding = await arweaveFunding({gateway: 'https://arweave.net', provider: 'turbo', jwk});
  // address() is a pure derivation — no network
  assert.equal(await funding.address(), arweaveAddress(jwk));
  // a provider without prepaid credits negotiates a clear error, not a fake topup
  await assert.rejects(() => arweaveFunding({gateway: 'g', uploadUrl: 'https://b'}), /no prepaid balance/);
});

test('ArweaveBackend(turbo): retrieval needs no identity/SDK; upload without a key fails clearly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-ar-'));
  try {
    const ar = new ArweaveBackend({gateway: 'https://arweave.net', provider: 'turbo'}, dir);
    const hash = hashContent(BYTES);
    // the resolver path (get/locator/has) must not construct the uploader
    assert.equal(await ar.has(hash), false);
    assert.equal(await ar.locator(hash), null);
    assert.equal(await ar.funding(), null); // no key → no funding capability yet
    // uploading without an identity surfaces a clear, actionable error
    await assert.rejects(() => ar.put(hash, {bytes: BYTES, contentType: 'image/png'}), /needs an identity/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

const ETH_KEY = '0xac0976bfec70ba57a56a97f5b3b26f4b7cb17df3edc816e14e77dc22a8ed3a48'; // anvil #0

test('turboBalanceForAddress: reads any address\' Turbo balance from the public API (no key); null on 404/garbage', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    if (String(url).includes('0xHASCREDITS')) return new Response(JSON.stringify({winc: '1500000000000'}), {status: 200});
    if (String(url).includes('0xUNKNOWN')) return new Response('Not found', {status: 404});
    return new Response(JSON.stringify({winc: 'not-a-number'}), {status: 200});
  }) as typeof fetch;

  const ok = await turboBalanceForAddress('0xHASCREDITS', 'ethereum');
  assert.equal(ok?.winc, '1500000000000');
  assert.equal(ok?.credits, '1.5'); // 1.5e12 winc = 1.5 credits
  assert.match(calls[0], /\/account\/balance\/ethereum\?address=0xHASCREDITS/); // no auth, address in query
  assert.equal(await turboBalanceForAddress('0xUNKNOWN', 'ethereum'), null); // never had a balance
  assert.equal(await turboBalanceForAddress('0xGARBAGE', 'ethereum'), null); // non-numeric winc
  assert.equal(await turboBalanceForAddress('', 'ethereum'), null); // no address
});

test('turboIdentity: precedence is remoteEth → eth key → arweave jwk → null', () => {
  const jwk = generateArweaveJwk();
  const remoteEth = {address: '0xabc', signMessage: async () => new Uint8Array()};
  // none configured → null (Turbo before a managed key exists)
  assert.equal(turboIdentity({gateway: 'g', provider: 'turbo'}), null);
  // jwk alone → arweave
  assert.deepEqual(turboIdentity({gateway: 'g', jwk})?.kind, 'arweave');
  // eth key beats jwk
  assert.equal(turboIdentity({gateway: 'g', jwk, ethSignerKey: ETH_KEY})?.kind, 'ethereum');
  // remote beats both
  assert.equal(turboIdentity({gateway: 'g', jwk, ethSignerKey: ETH_KEY, remoteEth})?.kind, 'ethereum-remote');
});

test('turboIdentityAddress: arweave = sha256(n), eth = the 0x account; isEthIdentity flags EVM', () => {
  const jwk = generateArweaveJwk();
  const arId = {kind: 'arweave' as const, jwk};
  assert.equal(turboIdentityAddress(arId), arweaveAddress(jwk));
  assert.equal(isEthIdentity(arId), false);

  const ethId = {kind: 'ethereum' as const, privateKey: ETH_KEY};
  assert.equal(turboIdentityAddress(ethId), privateKeyToAccount(ETH_KEY).address);
  assert.equal(isEthIdentity(ethId), true);

  const remoteId = {kind: 'ethereum-remote' as const, address: '0xF00', signMessage: async () => new Uint8Array()};
  assert.equal(turboIdentityAddress(remoteId), '0xF00');
  assert.equal(isEthIdentity(remoteId), true);
});

test('ArweaveBackend health: reports the eth identity address for an .env EVM Turbo lane', async () => {
  globalThis.fetch = (async () => new Response(null, {status: 200})) as typeof fetch;
  const dir = mkdtempSync(join(tmpdir(), 'abx-ar-'));
  try {
    const ar = new ArweaveBackend({gateway: 'https://arweave.net', provider: 'turbo', ethSignerKey: ETH_KEY}, dir);
    const h = await ar.health();
    assert.match(h.detail ?? '', /identity eth/);
    assert.match(h.detail ?? '', new RegExp(privateKeyToAccount(ETH_KEY).address));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('resolveTurboIdentity: mints the managed key only on a WRITE, never on a read/probe or over an existing key', () => {
  let minted = 0;
  const ensureJwk = () => {
    minted += 1;
    return generateArweaveJwk();
  };
  const cfg = {gateway: 'https://arweave.net', provider: 'turbo' as const, ensureJwk};

  // read/probe (mint:false): no identity available AND the mint hook is untouched
  assert.equal(resolveTurboIdentity(cfg, {mint: false}), null);
  assert.equal(minted, 0);

  // write (mint:true): mints exactly once, yielding an arweave identity
  const id = resolveTurboIdentity(cfg, {mint: true});
  assert.equal(id?.kind, 'arweave');
  assert.equal(minted, 1);

  // an already-present key is used as-is — the mint hook is never called over it
  const withKey = resolveTurboIdentity({...cfg, jwk: generateArweaveJwk()}, {mint: true});
  assert.equal(withKey?.kind, 'arweave');
  assert.equal(minted, 1); // unchanged
});

test('ArweaveBackend: reads (has / locator / health) never mint the managed identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-ar-nomint-'));
  let minted = 0;
  globalThis.fetch = (async () => new Response(null, {status: 200})) as typeof fetch;
  try {
    const backend = new ArweaveBackend(
      {gateway: 'https://arweave.net', provider: 'turbo', ensureJwk: () => (minted++, generateArweaveJwk())},
      dir,
    );
    await backend.has('0xabc0000000000000000000000000000000000000000000000000000000000000');
    await backend.locator('0xabc0000000000000000000000000000000000000000000000000000000000000');
    const h = await backend.health();
    assert.equal(h.ok, true);
    assert.match(h.detail ?? '', /created on first upload/); // health advertises lazy creation
    assert.equal(minted, 0); // no read built an uploader or touched the identity
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
