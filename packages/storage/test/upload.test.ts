// `abx storage upload` locator derivation (upload.ts). The load-bearing guarantee: the returned
// locator PRESERVES the filename, so an attached artifact keeps its declared mimeType (the on-chain
// field has no MIME slot — the URL extension is the declaration). Regression guard for the round-3
// finding: a bare content-addressed locator (ar://txid, <gw>/ipfs/<cid>) has no extension → octet-stream.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {StorageBackend, StoredContent} from '../src/backend.ts';
import {uploadAndLocate} from '../src/upload.ts';

const bytesOf = (s: string) => new TextEncoder().encode(s);
const content: StoredContent = {bytes: bytesOf('x'), contentType: 'image/tiff'};

/** A fake backend with only the capabilities each test needs. */
function fakeBackend(caps: Partial<StorageBackend> & {id: string}): StorageBackend {
  return {
    put: async () => {},
    get: async () => null,
    has: async () => false,
    ...caps,
  } as StorageBackend;
}

test('cloud (path-addressed): key carries the filename → publicBase/name', async () => {
  const b = fakeBackend({id: 's3', publicBase: 'https://cdn.example/', putObject: async () => {}});
  const r = await uploadAndLocate(b, 'master.tiff', content);
  assert.equal(r.locator, 'https://cdn.example/master.tiff'); // trailing slash trimmed, name preserved
  assert.equal(r.filenamePreserved, true);
});

test('content-addressed (ipfs/arweave): dir-wrap so the locator keeps the filename', async () => {
  const b = fakeBackend({
    id: 'arweave',
    locator: async () => 'https://arweave.net/RAWTXID', // the BARE (extension-less) form we must NOT use
    putDirectory: async () => ({base: 'https://arweave.net/MANIFEST'}),
  });
  const r = await uploadAndLocate(b, 'master.tiff', content);
  assert.equal(r.locator, 'https://arweave.net/MANIFEST/master.tiff'); // dir path, extension preserved
  assert.equal(r.filenamePreserved, true);
});

test('dir-wrap failure (e.g. kubo IPFS) falls back to the bare locator + flags it', async () => {
  const b = fakeBackend({
    id: 'ipfs',
    locator: async () => 'https://ipfs.example/ipfs/CID',
    putDirectory: async () => {
      throw new Error('kubo directory add not wired');
    },
  });
  const r = await uploadAndLocate(b, 'master.tiff', content);
  assert.equal(r.locator, 'https://ipfs.example/ipfs/CID'); // no extension
  assert.equal(r.filenamePreserved, false); // → caller warns the declared type will be octet-stream
  assert.match(r.fallbackReason ?? '', /kubo/);
});

test("fs (no public URL) is refused — an attached file must be reachable off-machine", async () => {
  const b = fakeBackend({id: 'fs'});
  await assert.rejects(() => uploadAndLocate(b, 'master.tiff', content), /can't produce a public URL/);
});
