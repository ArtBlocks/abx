import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ContentIndex, IpfsBackend, hashContent} from '../src/index.js';

const BYTES = new TextEncoder().encode('hello ipfs');
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('ContentIndex persists and reloads keccak → {cid, contentType}', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-idx-'));
  try {
    const hash = hashContent(BYTES);
    const a = new ContentIndex(dir);
    assert.equal(a.has(hash), false);
    a.set(hash, {pointer: 'bafyTEST', contentType: 'image/png'});
    // a fresh instance reads the same file from disk
    const b = new ContentIndex(dir);
    assert.equal(b.has(hash), true);
    assert.deepEqual(b.get(hash), {pointer: 'bafyTEST', contentType: 'image/png'});
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('IpfsBackend (kubo): add stores the CID, gateway GET retrieves the bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-ipfs-'));
  try {
    // Stub the network: Kubo /add returns a CID; the gateway returns the bytes.
    globalThis.fetch = (async (input: any, init: any) => {
      const url = String(input);
      if (url.includes('/api/v0/add')) {
        assert.equal(init.method, 'POST');
        return new Response(JSON.stringify({Name: 'content', Hash: 'bafyFAKECID', Size: '10'}) + '\n', {status: 200});
      }
      if (url.endsWith('/ipfs/bafyFAKECID')) {
        return new Response(BYTES, {status: 200});
      }
      return new Response('not found', {status: 404});
    }) as typeof fetch;

    const ipfs = new IpfsBackend({mode: 'kubo', apiUrl: 'http://127.0.0.1:5001', gateway: 'http://127.0.0.1:8080'}, dir);
    const hash = hashContent(BYTES);

    assert.equal(await ipfs.has(hash), false);
    await ipfs.put(hash, {bytes: BYTES, contentType: 'image/png'});
    assert.equal(await ipfs.has(hash), true); // CID recorded in the off-chain index

    const got = await ipfs.get(hash);
    assert.ok(got);
    assert.deepEqual(got.bytes, BYTES); // retrieved via the gateway by CID
    assert.equal(got.contentType, 'image/png'); // content type from the index, not the gateway

    // the gateway HTTPS URL the resolver serves as `image` (production-safe; renders everywhere)
    assert.equal(await ipfs.locator(hash), 'http://127.0.0.1:8080/ipfs/bafyFAKECID');
    assert.equal(await ipfs.locator(hashContent(new TextEncoder().encode('never pinned'))), null);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('IpfsBackend (kubo): putDirectory adds recursively and returns the wrapping directory CID', async () => {
  let sawUrl = '';
  let sawFilenames: string[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    sawUrl = String(input);
    assert.equal(init.method, 'POST');
    const fd = init.body as FormData;
    sawFilenames = (fd.getAll('file') as File[]).map((f) => f.name);
    // Kubo streams one NDJSON object per added path, the wrapping directory (`abx`) last —
    // only once every file beneath it has landed.
    const lines = [
      {Name: 'abx/index.html', Hash: 'bafyINDEX', Size: '12'},
      {Name: 'abx/sub/1.png', Hash: 'bafySUB1', Size: '34'},
      {Name: 'abx', Hash: 'bafyROOT', Size: '99'},
    ];
    return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', {status: 200});
  }) as typeof fetch;

  const ipfs = new IpfsBackend({mode: 'kubo', apiUrl: 'http://127.0.0.1:5001', gateway: 'http://127.0.0.1:8080'});
  const {base} = await ipfs.putDirectory([
    {name: 'index.html', bytes: new TextEncoder().encode('<html/>'), contentType: 'text/html'},
    {name: 'sub/1.png', bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png'},
  ]);

  // the returned root is the WRAPPING directory's CID, not any individual file's
  assert.equal(base, 'http://127.0.0.1:8080/ipfs/bafyROOT');
  assert.ok(sawUrl.startsWith('http://127.0.0.1:5001/api/v0/add?'));
  assert.ok(sawUrl.includes('recursive=true'));
  // deterministic relative paths, preserved under the common wrapping prefix — `index.html`
  // resolves at the directory root (`<base>/index.html>`), not nested under a temp wrapper name
  assert.deepEqual(sawFilenames, ['abx/index.html', 'abx/sub/1.png']);
});

test('IpfsBackend (kubo): putDirectory rejects a non-2xx response instead of guessing a root', async () => {
  globalThis.fetch = (async () => new Response('internal error', {status: 500})) as typeof fetch;
  const ipfs = new IpfsBackend({mode: 'kubo', apiUrl: 'http://127.0.0.1:5001', gateway: 'http://127.0.0.1:8080'});
  await assert.rejects(
    () => ipfs.putDirectory([{name: 'index.html', bytes: new Uint8Array([1]), contentType: 'text/html'}]),
    /IPFS directory add failed \(500\)/,
  );
});

test('IpfsBackend (kubo): putDirectory rejects a truncated NDJSON stream', async () => {
  globalThis.fetch = (async () => {
    // Connection dropped mid-object: a partial JSON line, no closing directory entry.
    return new Response('{"Name":"abx/index.html","Hash":"bafyINDEX","Size":"1', {status: 200});
  }) as typeof fetch;
  const ipfs = new IpfsBackend({mode: 'kubo', apiUrl: 'http://127.0.0.1:5001', gateway: 'http://127.0.0.1:8080'});
  await assert.rejects(
    () => ipfs.putDirectory([{name: 'index.html', bytes: new Uint8Array([1]), contentType: 'text/html'}]),
    /malformed output \(truncated stream\?\)/,
  );
});

test('IpfsBackend (kubo): putDirectory rejects a stream that ends without the wrapping directory CID', async () => {
  globalThis.fetch = (async () => {
    // Every file line is well-formed, but the stream stops before Kubo emits the directory root
    // (e.g. the node was killed after adding files but before finishing the wrap).
    const lines = [{Name: 'abx/index.html', Hash: 'bafyINDEX', Size: '12'}];
    return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', {status: 200});
  }) as typeof fetch;
  const ipfs = new IpfsBackend({mode: 'kubo', apiUrl: 'http://127.0.0.1:5001', gateway: 'http://127.0.0.1:8080'});
  await assert.rejects(
    () => ipfs.putDirectory([{name: 'index.html', bytes: new Uint8Array([1]), contentType: 'text/html'}]),
    /stream ended without the wrapping directory CID/,
  );
});

test('IpfsBackend (kubo): putDirectory rejects a mid-stream error object', async () => {
  globalThis.fetch = (async () => {
    const lines = [
      {Name: 'abx/index.html', Hash: 'bafyINDEX', Size: '12'},
      {Type: 'error', Message: 'no space left on device'},
    ];
    return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', {status: 200});
  }) as typeof fetch;
  const ipfs = new IpfsBackend({mode: 'kubo', apiUrl: 'http://127.0.0.1:5001', gateway: 'http://127.0.0.1:8080'});
  await assert.rejects(
    () => ipfs.putDirectory([{name: 'index.html', bytes: new Uint8Array([1]), contentType: 'text/html'}]),
    /failed mid-stream: no space left on device/,
  );
});

test('IpfsBackend (pinata): pinFileToIPFS stores the CID with auth', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abx-ipfs-'));
  try {
    let sawAuth = '';
    globalThis.fetch = (async (input: any, init: any) => {
      const url = String(input);
      if (url.includes('/pinning/pinFileToIPFS')) {
        sawAuth = init.headers.authorization;
        return new Response(JSON.stringify({IpfsHash: 'bafyPINNED', PinSize: 10, Timestamp: 'x'}), {status: 200});
      }
      if (url.endsWith('/ipfs/bafyPINNED')) return new Response(BYTES, {status: 200});
      return new Response('not found', {status: 404});
    }) as typeof fetch;

    const ipfs = new IpfsBackend(
      {mode: 'pinata', gateway: 'https://gateway.pinata.cloud', pinataEndpoint: 'https://api.pinata.cloud', pinataJwt: 'JWT123'},
      dir,
    );
    const hash = hashContent(BYTES);
    await ipfs.put(hash, {bytes: BYTES, contentType: 'image/png'});
    assert.equal(sawAuth, 'Bearer JWT123');
    assert.deepEqual((await ipfs.get(hash))?.bytes, BYTES);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
